-- COPY-1 · FASE 2B — retirada por copyright, apelación, restauración y eliminación definitiva MANUAL.
-- PROPUESTA LOCAL: NO aplicada en ningún entorno. Forward-only, posterior a 20261108120000 (la 2A, 20261107120000, no se modifica).
--
-- Principios:
--   * Todo es decisión humana: una persona de moderación (moderator, developer o admin, verificada bajo lock) retira, resuelve la
--     apelación o elimina. Nada se retira, restaura ni elimina por vencimiento de plazo, por cron ni por ningún proceso automático.
--   * «Retirar» = OCULTAR (community_posts.status 'hidden'): no se tocan los archivos. No se usa 'removed_pending_purge', cuya purga
--     programada (72 h, cron existente) sería automática. community_posts, community_post_media y media_assets solo se modifican
--     dentro de las RPC de este archivo, que son SECURITY DEFINER propiedad de postgres (la frontera de escritura de R4-A no cambia).
--   * La eliminación definitiva reutiliza la regla de la purga existente: solo los archivos usados EXCLUSIVAMENTE por esa publicación
--     pasan a 'deleting' (lo recoge el GC existente de R2); los compartidos o ajenos se conservan.
--   * Reglas de eliminación, repetidas en la RPC (la interfaz solo las refleja): correo inicial enviado, plazo vencido, sin apelación
--     pendiente, sin aviso de resolución pendiente y confirmación explícita (referencia + versión vigente).
--   * El plazo de apelación (60 o 1440 minutos) lo decide el BACKEND (1 h solo fuera de producción y con la variable de prueba; el
--     entorno de producción ignora la variable). La RPC solo acepta esos dos valores y cuenta el plazo desde el envío CONFIRMADO.
--   * El enlace de apelación lleva un token aleatorio de 256 bits generado por el backend: aquí solo se guarda su SHA-256.
--   * Historial: copyright_claim_events (propio) + el MISMO moderation_audit_log (acciones copyright_* nuevas, siempre humanas).
--   * Sin tablas de historial nuevas, sin funciones serverless nuevas. Una apelación es una fila por reclamación (unique).
-- Rollback (solo local/operador): supabase/rollbacks/20261110120000_copyright_removal_appeals.rollback.sql

-- 1. Reclamación: estados y columnas de retirada ------------------------------------------------------------------------------
alter table public.copyright_claims drop constraint copyright_claims_status_check;
alter table public.copyright_claims add constraint copyright_claims_status_check check (status in
  ('received', 'in_review', 'needs_info', 'dismissed', 'withdrawn', 'removed', 'appeal_pending', 'restored', 'purged'));

alter table public.copyright_claims
  add column removal_reason            text,
  add column removed_at                timestamptz,
  add column removed_by                uuid,
  add column removed_post_version      integer,
  add column removal_window_minutes    integer,
  add column appeal_token_hash         text,
  add column notified_at               timestamptz,
  add column notify_attempts           integer not null default 0,
  add column notify_last_error         text,
  add column appeal_deadline           timestamptz,
  add column resolution_notice_pending boolean not null default false,
  add column resolution_notified_at    timestamptz,
  add column restored_at               timestamptz,
  add column purged_at                 timestamptz,
  add column purge_asset_ids           uuid[];

alter table public.copyright_claims
  add constraint copyright_claims_removal_check check (
    (status in ('removed', 'appeal_pending', 'restored', 'purged')) = (removed_at is not null)
    and (removed_at is not null) = (removal_reason is not null)
    and (removed_at is not null) = (removed_by is not null)
    and (removed_at is not null) = (removed_post_version is not null)
    and (removed_at is not null) = (removal_window_minutes is not null)
    and (removal_reason is null or public.copyright_text_ok(removal_reason, 10, 1000))
    and (removal_window_minutes is null or removal_window_minutes in (60, 1440))
    and (status = 'restored') = (restored_at is not null)
    and (status = 'purged') = (purged_at is not null)
    and (notified_at is null) = (appeal_deadline is null)
    and (notified_at is null or removed_at is not null)
    and (appeal_token_hash is null or appeal_token_hash ~ '^[0-9a-f]{64}$')
    and (appeal_token_hash is null or removed_at is not null)
    and notify_attempts >= 0
    and (notify_last_error is null or notify_last_error in
      ('not_configured', 'rejected', 'rate_limited', 'provider_unavailable', 'timeout', 'invalid_response', 'no_recipient'))
    and (not resolution_notice_pending or status in ('removed', 'restored'))
    and (purge_asset_ids is null or status = 'purged'));
create unique index copyright_claims_appeal_token_idx on public.copyright_claims (appeal_token_hash)
  where appeal_token_hash is not null;

-- 2. Apelación: una por reclamación (unique), solo texto y enlaces ------------------------------------------------------------
create table public.copyright_appeals (
  id                 uuid primary key default gen_random_uuid(),
  claim_id           uuid not null unique references public.copyright_claims (id),
  author_user_id     uuid not null,
  contact_name       text not null check (public.copyright_text_ok(contact_name, 2, 120)),
  contact_email      text not null check (char_length(contact_email) between 3 and 254
    and contact_email = lower(btrim(contact_email))
    and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  reason             text not null check (reason in
    ('own_work', 'authorized', 'not_infringing', 'legal_exception', 'mistake', 'other')),
  explanation        text not null check (public.copyright_text_ok(explanation, 10, 2000)),
  evidence_text      text check (evidence_text is null or public.copyright_text_ok(evidence_text, 1, 2000)),
  evidence_urls      text[] not null default '{}' check (cardinality(evidence_urls) = 0 or public.copyright_urls_ok(evidence_urls)),
  statement_version  text not null check (statement_version ~ '^[a-z0-9._-]{1,20}$'),
  statement_accepted boolean not null check (statement_accepted),
  status             text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text check (resolution_note is null or public.copyright_text_ok(resolution_note, 1, 1000)),
  check (evidence_text is not null or cardinality(evidence_urls) > 0),
  check ((status = 'pending') = (resolved_at is null)),
  check ((status = 'pending') = (resolved_by is null)),
  check ((status = 'pending') = (resolution_note is null))
);
alter table public.copyright_appeals enable row level security;
alter table public.copyright_appeals force row level security;
revoke all on table public.copyright_appeals from public, anon, authenticated, service_role;
comment on table public.copyright_appeals is
  'Apelaciones del autor de una publicación retirada por copyright (fase 2B). Privada: solo las funciones SECURITY DEFINER. Una por reclamación.';

-- 3. Historial propio y general ----------------------------------------------------------------------------------------------
alter table public.copyright_claim_events drop constraint copyright_claim_events_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_kind_check check (kind in
  ('received', 'review_started', 'info_requested', 'review_resumed', 'note', 'dismissed', 'withdrawn',
   'removed', 'notified', 'notification_failed', 'token_reissued', 'appeal_submitted', 'appeal_accepted',
   'appeal_rejected', 'restored', 'purged'));

alter table public.moderation_audit_log drop constraint moderation_audit_log_action_check;
alter table public.moderation_audit_log add constraint moderation_audit_log_action_check check (action in (
  'report_status_changed', 'post_hidden', 'post_restored', 'post_quarantined', 'case_rejected',
  'content_actioned', 'strike_applied', 'strike_revoked', 'post_purged',
  'copyright_claim_review_started', 'copyright_claim_info_requested', 'copyright_claim_review_resumed',
  'copyright_claim_note_added', 'copyright_claim_dismissed', 'copyright_claim_withdrawn',
  'copyright_post_removed', 'copyright_notification_sent', 'copyright_notification_failed',
  'copyright_notice_token_reissued', 'copyright_appeal_submitted', 'copyright_appeal_accepted',
  'copyright_appeal_rejected', 'copyright_post_restored', 'copyright_post_purged'));

-- 4. Condiciones de eliminación: UNA sola fuente de verdad (la lee la interfaz y la repite la RPC) -------------------------------
create function public.copyright_purge_blockers(p_claim public.copyright_claims, p_now timestamptz)
returns text[] language sql stable set search_path = pg_catalog, public as $$
  select array_remove(array[
    case when p_claim.status = 'appeal_pending' then 'appeal_pending'
         when p_claim.status <> 'removed' then 'not_removed' end,
    case when p_claim.status in ('removed', 'appeal_pending') and p_claim.notified_at is null then 'notification_pending'
         when p_claim.status in ('removed', 'appeal_pending') and p_claim.appeal_deadline > p_now then 'window_open' end,
    case when p_claim.resolution_notice_pending then 'resolution_notice_pending' end
  ], null)
$$;
alter function public.copyright_purge_blockers(public.copyright_claims, timestamptz) owner to postgres;
revoke all on function public.copyright_purge_blockers(public.copyright_claims, timestamptz)
  from public, anon, authenticated, service_role;

-- 4b. PROTECCIÓN: una publicación con retirada o apelación de copyright ACTIVA no se puede eliminar por ningún camino ordinario -------
-- «Activa» = reclamación en estado removed o appeal_pending. Se protege en la base de datos (no solo en la interfaz) y SIN segundo GC:
--   * la decisión ordinaria content_actioned (único camino a removed_pending_purge y, con él, a la purga de 72 h y al GC de R2) falla con
--     post_copyright_protected: no queda ninguna eliminación diferida que pueda reactivarse al terminar la protección;
--   * el borrado propio de la autora (community_post_delete, que además pasa los archivos a 'deleting') se rechaza igual;
--   * la purga programada (community_purge_due_posts) omite cualquier publicación protegida aunque se hubiera programado antes;
--   * la eliminación de copyright (copyright_claim_purge) cierra primero la reclamación y entonces sí puede borrar.
-- No se bloquea el borrado en cascada de una CUENTA (derecho de la persona usuaria): no pasa por estos caminos.
create function public.copyright_post_protected(p_post_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.copyright_claims c
                  where c.post_id = p_post_id and c.status in ('removed', 'appeal_pending'))
$$;
alter function public.copyright_post_protected(uuid) owner to postgres;
revoke all on function public.copyright_post_protected(uuid) from public, anon, authenticated, service_role;
create index copyright_claims_protected_post_idx on public.copyright_claims (post_id)
  where status in ('removed', 'appeal_pending');

create function public.copyright_protect_post_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if public.copyright_post_protected(new.id) then
    raise exception 'post_copyright_protected';
  end if;
  return new;
end;
$$;
alter function public.copyright_protect_post_guard() owner to postgres;
revoke all on function public.copyright_protect_post_guard() from public, anon, authenticated, service_role;
create trigger copyright_protect_post_removal
  before update of status on public.community_posts
  for each row when (new.status = 'removed_pending_purge' and old.status <> 'removed_pending_purge')
  execute function public.copyright_protect_post_guard();

-- Mismas funciones ordinarias que ya existían, con UNA comprobación añadida (el resto del cuerpo es idéntico).
create or replace function public.community_purge_due_posts(p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_cand record;
  v_post public.community_posts%rowtype;
  v_asset_ids uuid[];
  v_marked uuid[];
  v_purged integer := 0;
  v_marked_total integer := 0;
  v_retained_total integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'invalid_argument'; end if;
  for v_cand in
    select id from public.community_posts
    where status = 'removed_pending_purge' and purge_after <= v_now
    order by purge_after, id
    limit p_limit
    for update skip locked
  loop
    -- Revalidate under the row lock: state, decision link and boundary.
    select * into v_post from public.community_posts where id = v_cand.id for update;
    if not found
      or v_post.status <> 'removed_pending_purge'
      or v_post.removal_decision_id is null
      or not public.community_purge_due(v_post.purge_after, v_now)
      -- COPY-1 2B: una publicación con retirada o apelación de copyright activa NUNCA se purga por este camino (se omite, no aborta el lote).
      or public.copyright_post_protected(v_post.id) then
      continue;
    end if;

    select coalesce(array_agg(pm.asset_id order by pm.position, pm.id), array[]::uuid[])
      into v_asset_ids from public.community_post_media pm where pm.post_id = v_post.id;

    -- Only assets used exclusively by THIS community post become deleting. community_post_media
    -- is unique per asset; the cosplay/domain guards protect against any foreign reuse.
    with marked as (
      update public.media_assets a
         set status = 'deleting', updated_at = v_now
       where a.id = any(v_asset_ids)
         and a.status = 'ready'
         and a.domain = 'community'
         and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id)
         and not exists (select 1 from public.community_post_media o
                          where o.asset_id = a.id and o.post_id <> v_post.id)
      returning a.id)
    select coalesce(array_agg(id), array[]::uuid[]) into v_marked from marked;

    delete from public.community_posts where id = v_post.id; -- cascades post_media and likes

    insert into public.moderation_audit_log
      (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
      values ('system', null, 'community_post', v_post.id, 'post_purged',
        jsonb_build_object('post_id', v_post.id, 'removal_decision_id', v_post.removal_decision_id,
          'assets_marked', cardinality(v_marked),
          'assets_retained', cardinality(v_asset_ids) - cardinality(v_marked),
          'purged_at', v_now), v_now);

    v_purged := v_purged + 1;
    v_marked_total := v_marked_total + cardinality(v_marked);
    v_retained_total := v_retained_total + (cardinality(v_asset_ids) - cardinality(v_marked));
  end loop;
  return jsonb_build_object('purged', v_purged, 'assetsMarked', v_marked_total,
    'assetsRetained', v_retained_total, 'serverNow', v_now);
end;
$$;

create or replace function public.community_post_delete(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current_version integer;
  v_author uuid;
  v_asset_ids uuid[];
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;

  select version, author_user_id into v_current_version, v_author
    from public.community_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_author <> p_actor_user_id then
    raise exception 'not_owner';
  end if;
  -- COPY-1 2B: mientras exista una retirada o apelación de copyright activa, ni la publicación ni sus archivos se pueden borrar
  -- (tampoco por su autora): hay una apelación en curso y la eliminación es siempre una decisión humana de moderación.
  if public.copyright_post_protected(p_post_id) then
    raise exception 'post_copyright_protected';
  end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select coalesce(array_agg(asset_id), array[]::uuid[]) into v_asset_ids
    from public.community_post_media where post_id = p_post_id;

  if array_length(v_asset_ids, 1) > 0 then
    update public.media_assets set status = 'deleting', updated_at = clock_timestamp()
      where id = any(v_asset_ids) and status = 'ready';
  end if;

  delete from public.community_posts where id = p_post_id;

  return jsonb_build_object('deleted_asset_ids', to_jsonb(v_asset_ids));
end;
$$;

-- 5. Revisión 2A: las acciones previas a la retirada no se aplican a reclamaciones retiradas o cerradas ------------------------
create or replace function public.copyright_claim_review(
  p_actor_user_id uuid, p_claim_id uuid, p_action text, p_expected_version integer, p_note text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_note text; v_from text; v_to text;
  v_kind text; v_audit text; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null or p_expected_version is null or p_expected_version < 1
     or p_action is null or p_action not in
       ('start_review', 'request_info', 'resume_review', 'dismiss', 'withdraw', 'add_note') then
    raise exception 'invalid_argument';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and not public.copyright_text_ok(v_note, 1, 1000) then raise exception 'invalid_argument'; end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  if v_claim.version <> p_expected_version then raise exception 'version_conflict'; end if;
  if v_claim.status in ('dismissed', 'withdrawn', 'restored', 'purged') then raise exception 'invalid_transition'; end if;
  -- Una reclamación ya retirada solo admite notas: descartarla o «retirarla» exigiría restaurar la publicación (apelación).
  if v_claim.status in ('removed', 'appeal_pending') and p_action <> 'add_note' then raise exception 'invalid_transition'; end if;
  if p_action in ('request_info', 'dismiss', 'withdraw', 'add_note') and v_note is null then raise exception 'note_required'; end if;

  if p_action = 'start_review' then
    if v_claim.status <> 'received' then raise exception 'invalid_transition'; end if;
    v_to := 'in_review'; v_kind := 'review_started'; v_audit := 'copyright_claim_review_started';
  elsif p_action = 'request_info' then
    if v_claim.status <> 'in_review' then raise exception 'invalid_transition'; end if;
    v_to := 'needs_info'; v_kind := 'info_requested'; v_audit := 'copyright_claim_info_requested';
  elsif p_action = 'resume_review' then
    if v_claim.status <> 'needs_info' then raise exception 'invalid_transition'; end if;
    v_to := 'in_review'; v_kind := 'review_resumed'; v_audit := 'copyright_claim_review_resumed';
  elsif p_action = 'dismiss' then
    v_to := 'dismissed'; v_kind := 'dismissed'; v_audit := 'copyright_claim_dismissed';
  elsif p_action = 'withdraw' then
    v_to := 'withdrawn'; v_kind := 'withdrawn'; v_audit := 'copyright_claim_withdrawn';
  else
    v_to := v_claim.status; v_kind := 'note'; v_audit := 'copyright_claim_note_added';
  end if;

  v_from := v_claim.status;
  update public.copyright_claims set status = v_to, version = version + 1, updated_at = v_now
    where id = v_claim.id returning * into v_claim;
  insert into public.copyright_claim_events
    (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, note, created_at)
    values (v_claim.id, v_kind, 'human', p_actor_user_id, v_from, v_to, v_note, v_now);
  -- Historial GENERAL de moderación: sin datos del reclamante ni texto de la nota (solo referencia y estados).
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'copyright_claim', v_claim.id, v_audit,
      jsonb_build_object('reference', v_claim.reference, 'to_status', v_to, 'claim_version', v_claim.version), v_now);
  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status,
    'version', v_claim.version, 'updatedAt', v_claim.updated_at);
end;
$$;
alter function public.copyright_claim_review(uuid, uuid, text, integer, text) owner to postgres;
revoke execute on function public.copyright_claim_review(uuid, uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.copyright_claim_review(uuid, uuid, text, integer, text) to service_role;

-- 6. Lectura: colas ampliadas y detalle con retirada, apelación y condiciones de eliminación -----------------------------------
create or replace function public.copyright_claims_read(
  p_actor_user_id uuid, p_scope text default 'open',
  p_before_created timestamptz default null, p_before_id uuid default null,
  p_claim_id uuid default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_items jsonb; v_count integer; v_next jsonb := null;
  v_post public.community_posts%rowtype; v_appeal public.copyright_appeals%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
  c_page constant integer := 25;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is not null then
    select * into v_claim from public.copyright_claims where id = p_claim_id;
    if not found then raise exception 'claim_not_found'; end if;
    select * into v_post from public.community_posts where id = v_claim.post_id;
    select * into v_appeal from public.copyright_appeals where claim_id = v_claim.id;
    return jsonb_build_object('serverNow', v_now, 'item', jsonb_build_object(
      'id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status, 'version', v_claim.version,
      'claimantName', v_claim.claimant_name, 'claimantEmail', v_claim.claimant_email,
      'organization', v_claim.claimant_organization, 'relationship', v_claim.relationship,
      'workDescription', v_claim.work_description, 'infringementDescription', v_claim.infringement_description,
      'evidenceUrls', to_jsonb(v_claim.evidence_urls), 'claimedPostUrl', v_claim.claimed_post_url,
      'postId', v_claim.post_id, 'postFound', v_claim.post_found,
      'postTextSnapshot', v_claim.post_text_snapshot, 'postMediaCount', v_claim.post_media_count,
      'currentPostStatus', v_post.status,
      'currentPost', case when v_post.id is null then null else jsonb_build_object(
        'status', v_post.status, 'text', left(v_post.text, 2000), 'version', v_post.version,
        'mediaCount', (select count(*) from public.community_post_media pm where pm.post_id = v_post.id)) end,
      'statementVersion', v_claim.statement_version, 'signature', v_claim.signature,
      'createdAt', v_claim.created_at, 'updatedAt', v_claim.updated_at,
      'removal', case when v_claim.removed_at is null then null else jsonb_build_object(
        'removedAt', v_claim.removed_at, 'reason', v_claim.removal_reason,
        'windowMinutes', v_claim.removal_window_minutes, 'notifiedAt', v_claim.notified_at,
        'appealDeadline', v_claim.appeal_deadline, 'notifyAttempts', v_claim.notify_attempts,
        'notifyLastError', v_claim.notify_last_error, 'resolutionNoticePending', v_claim.resolution_notice_pending,
        'resolutionNotifiedAt', v_claim.resolution_notified_at, 'restoredAt', v_claim.restored_at,
        'purgedAt', v_claim.purged_at,
        'purgeAssetsPending', case when v_claim.purge_asset_ids is null then null else
          (select count(*) from public.media_assets a where a.id = any (v_claim.purge_asset_ids)) end,
        'purgeBlockers', to_jsonb(public.copyright_purge_blockers(v_claim, v_now))) end,
      'appeal', case when v_appeal.id is null then null else jsonb_build_object(
        'status', v_appeal.status, 'reason', v_appeal.reason, 'explanation', v_appeal.explanation,
        'evidenceText', v_appeal.evidence_text, 'evidenceUrls', to_jsonb(v_appeal.evidence_urls),
        'contactName', v_appeal.contact_name, 'contactEmail', v_appeal.contact_email,
        'createdAt', v_appeal.created_at, 'resolvedAt', v_appeal.resolved_at,
        'resolutionNote', v_appeal.resolution_note) end,
      'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'actorKind', e.actor_kind,
        'fromStatus', e.from_status, 'toStatus', e.to_status, 'note', e.note, 'createdAt', e.created_at)
        order by e.created_at, e.id) from public.copyright_claim_events e where e.claim_id = v_claim.id), '[]'::jsonb)));
  end if;
  if p_scope is null or p_scope not in ('open', 'closed') or (p_before_created is null) <> (p_before_id is null) then
    raise exception 'invalid_argument';
  end if;
  -- Una página de c_page + 1 filas (la última solo indica que hay más), con cursor por (created_at, id).
  if p_scope = 'open' then
    select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'reference', q.reference, 'status', q.status,
        'version', q.version, 'claimantName', q.claimant_name, 'relationship', q.relationship,
        'postFound', q.post_found, 'createdAt', q.created_at, 'updatedAt', q.updated_at) order by q.created_at, q.id)
        filter (where q.ord <= c_page), '[]'::jsonb),
      max(q.ord)
      into v_items, v_count
      from (select c.*, row_number() over (order by c.created_at, c.id) ord from (
              select * from public.copyright_claims
               where status in ('received', 'in_review', 'needs_info', 'removed', 'appeal_pending')
                 and (p_before_created is null or (created_at, id) > (p_before_created, p_before_id))
               order by created_at, id limit c_page + 1) c) q;
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'reference', q.reference, 'status', q.status,
        'version', q.version, 'claimantName', q.claimant_name, 'relationship', q.relationship,
        'postFound', q.post_found, 'createdAt', q.created_at, 'updatedAt', q.updated_at) order by q.created_at desc, q.id desc)
        filter (where q.ord <= c_page), '[]'::jsonb),
      max(q.ord)
      into v_items, v_count
      from (select c.*, row_number() over (order by c.created_at desc, c.id desc) ord from (
              select * from public.copyright_claims
               where status in ('dismissed', 'withdrawn', 'restored', 'purged')
                 and (p_before_created is null or (created_at, id) < (p_before_created, p_before_id))
               order by created_at desc, id desc limit c_page + 1) c) q;
  end if;
  if coalesce(v_count, 0) > c_page then
    v_next := jsonb_build_object('createdAt', v_items->(c_page - 1)->>'createdAt', 'id', v_items->(c_page - 1)->>'id');
  end if;
  return jsonb_build_object('items', v_items, 'next', v_next);
end;
$$;
alter function public.copyright_claims_read(uuid, text, timestamptz, uuid, uuid) owner to postgres;
revoke execute on function public.copyright_claims_read(uuid, text, timestamptz, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.copyright_claims_read(uuid, text, timestamptz, uuid, uuid) to service_role;

-- 7a. Retirada: oculta la publicación (NO toca sus archivos) y deja la reclamación «removed» -----------------------------------
-- Exige: reclamación en revisión, publicación existente y publicada con la versión que la persona vio, y confirmación explícita
-- (la referencia mostrada en la segunda confirmación). Devuelve los datos del aviso al autor (solo para el backend).
create function public.copyright_claim_remove(
  p_actor_user_id uuid, p_claim_id uuid, p_expected_version integer, p_expected_post_version integer,
  p_confirm_reference text, p_reason text, p_token_hash text, p_window_minutes integer
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_post public.community_posts%rowtype;
  v_reason text; v_before_version integer; v_email text; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if p_claim_id is null or p_expected_version is null or p_expected_version < 1
     or p_expected_post_version is null or p_expected_post_version < 1
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_window_minutes is null or p_window_minutes not in (60, 1440) then
    raise exception 'invalid_argument';
  end if;
  if v_reason is null then raise exception 'note_required'; end if;
  if not public.copyright_text_ok(v_reason, 10, 1000) then raise exception 'invalid_argument'; end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  if v_claim.version <> p_expected_version then raise exception 'version_conflict'; end if;
  if v_claim.status <> 'in_review' then raise exception 'invalid_transition'; end if;
  if p_confirm_reference is distinct from v_claim.reference then raise exception 'confirmation_mismatch'; end if;
  if not v_claim.post_found or v_claim.post_id is null then raise exception 'post_not_found'; end if;
  select * into v_post from public.community_posts where id = v_claim.post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if v_post.author_user_id is distinct from v_claim.post_author_user_id or v_post.status <> 'published' then
    raise exception 'post_state_conflict';
  end if;
  if v_post.version <> p_expected_post_version then raise exception 'post_version_conflict'; end if;
  v_before_version := v_post.version;
  update public.community_posts set status = 'hidden', version = version + 1, updated_at = v_now
    where id = v_post.id returning * into v_post;
  update public.copyright_claims set status = 'removed', version = version + 1, updated_at = v_now,
      removal_reason = v_reason, removed_at = v_now, removed_by = p_actor_user_id, removed_post_version = v_post.version,
      removal_window_minutes = p_window_minutes, appeal_token_hash = p_token_hash
    where id = v_claim.id returning * into v_claim;
  insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, note, created_at)
    values (v_claim.id, 'removed', 'human', p_actor_user_id, 'in_review', 'removed', v_reason, v_now);
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'copyright_claim', v_claim.id, 'copyright_post_removed',
      jsonb_build_object('reference', v_claim.reference, 'to_status', 'removed', 'claim_version', v_claim.version,
        'post_id', v_post.id, 'from_post_version', v_before_version, 'to_post_version', v_post.version,
        'window_minutes', p_window_minutes), v_now);
  select u.email into v_email from auth.users u where u.id = v_claim.post_author_user_id;
  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status,
    'version', v_claim.version, 'updatedAt', v_claim.updated_at,
    'notice', jsonb_build_object('kind', 'removal', 'authorEmail', v_email, 'reason', v_reason,
      'windowMinutes', v_claim.removal_window_minutes));
end;
$$;
alter function public.copyright_claim_remove(uuid, uuid, integer, integer, text, text, text, integer) owner to postgres;
revoke execute on function public.copyright_claim_remove(uuid, uuid, integer, integer, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.copyright_claim_remove(uuid, uuid, integer, integer, text, text, text, integer) to service_role;

-- 7b. Contexto de un aviso pendiente (reintento): reemite el token solo mientras el aviso inicial NO se haya confirmado ---------
create function public.copyright_claim_notice_context(
  p_actor_user_id uuid, p_claim_id uuid, p_kind text, p_token_hash text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_appeal public.copyright_appeals%rowtype;
  v_email text; v_expected text; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null or p_kind is null or p_kind not in ('removal', 'appeal_accepted', 'appeal_rejected')
     or (p_kind = 'removal') <> (p_token_hash is not null)
     or (p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid_argument';
  end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  select * into v_appeal from public.copyright_appeals where claim_id = v_claim.id;
  if p_kind = 'removal' then
    if v_claim.status not in ('removed', 'appeal_pending') or v_claim.notified_at is not null then
      raise exception 'invalid_transition';
    end if;
    update public.copyright_claims set appeal_token_hash = p_token_hash, version = version + 1, updated_at = v_now
      where id = v_claim.id returning * into v_claim;
    insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, created_at)
      values (v_claim.id, 'token_reissued', 'human', p_actor_user_id, v_claim.status, v_claim.status, v_now);
    insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
      values ('human', p_actor_user_id, 'copyright_claim', v_claim.id, 'copyright_notice_token_reissued',
        jsonb_build_object('reference', v_claim.reference, 'to_status', v_claim.status, 'claim_version', v_claim.version), v_now);
  else
    v_expected := case when p_kind = 'appeal_accepted' then 'accepted' else 'rejected' end;
    if not v_claim.resolution_notice_pending or v_appeal.id is null or v_appeal.status <> v_expected then
      raise exception 'invalid_transition';
    end if;
  end if;
  select u.email into v_email from auth.users u where u.id = v_claim.post_author_user_id;
  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status,
    'version', v_claim.version, 'updatedAt', v_claim.updated_at,
    'notice', jsonb_build_object('kind', p_kind, 'authorEmail', v_email, 'reason', v_claim.removal_reason,
      'windowMinutes', v_claim.removal_window_minutes, 'resolutionNote', v_appeal.resolution_note));
end;
$$;
alter function public.copyright_claim_notice_context(uuid, uuid, text, text) owner to postgres;
revoke execute on function public.copyright_claim_notice_context(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.copyright_claim_notice_context(uuid, uuid, text, text) to service_role;

-- 7c. Resultado de un aviso (enviado o fallido). El plazo de apelación empieza SOLO al confirmarse el aviso inicial. -------------
create function public.copyright_claim_notice_record(
  p_actor_user_id uuid, p_claim_id uuid, p_kind text, p_ok boolean, p_error_class text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
  v_class text;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null or p_ok is null or p_kind is null or p_kind not in ('removal', 'appeal_accepted', 'appeal_rejected')
     or (p_ok and p_error_class is not null)
     or (not p_ok and (p_error_class is null or p_error_class not in
       ('not_configured', 'rejected', 'rate_limited', 'provider_unavailable', 'timeout', 'invalid_response', 'no_recipient'))) then
    raise exception 'invalid_argument';
  end if;
  v_class := p_error_class;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  if p_kind = 'removal' then
    if v_claim.status not in ('removed', 'appeal_pending', 'restored', 'purged') then raise exception 'invalid_transition'; end if;
    -- Idempotente: un segundo registro del aviso inicial no mueve el plazo ni repite nada.
    if v_claim.notified_at is not null then
      return jsonb_build_object('id', v_claim.id, 'version', v_claim.version, 'alreadyNotified', true);
    end if;
  else
    if not v_claim.resolution_notice_pending then
      return jsonb_build_object('id', v_claim.id, 'version', v_claim.version, 'alreadyNotified', true);
    end if;
  end if;
  if p_ok then
    if p_kind = 'removal' then
      update public.copyright_claims set notified_at = v_now, appeal_deadline = v_now + make_interval(mins => removal_window_minutes),
          notify_last_error = null, version = version + 1, updated_at = v_now
        where id = v_claim.id returning * into v_claim;
    else
      update public.copyright_claims set resolution_notice_pending = false, resolution_notified_at = v_now,
          notify_last_error = null, version = version + 1, updated_at = v_now
        where id = v_claim.id returning * into v_claim;
    end if;
  else
    update public.copyright_claims set notify_attempts = notify_attempts + 1, notify_last_error = v_class,
        version = version + 1, updated_at = v_now
      where id = v_claim.id returning * into v_claim;
  end if;
  insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, note, created_at)
    values (v_claim.id, case when p_ok then 'notified' else 'notification_failed' end, 'human', p_actor_user_id,
      v_claim.status, v_claim.status, case when p_ok then null else v_class end, v_now);
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'copyright_claim', v_claim.id,
      case when p_ok then 'copyright_notification_sent' else 'copyright_notification_failed' end,
      jsonb_build_object('reference', v_claim.reference, 'to_status', v_claim.status, 'claim_version', v_claim.version,
        'notice', p_kind) || case when p_ok then '{}'::jsonb else jsonb_build_object('error_class', v_class) end, v_now);
  return jsonb_build_object('id', v_claim.id, 'version', v_claim.version, 'alreadyNotified', false,
    'appealDeadline', v_claim.appeal_deadline);
end;
$$;
alter function public.copyright_claim_notice_record(uuid, uuid, text, boolean, text) owner to postgres;
revoke execute on function public.copyright_claim_notice_record(uuid, uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.copyright_claim_notice_record(uuid, uuid, text, boolean, text) to service_role;

-- 7d. Apelación: lectura del estado (autor autenticado + token) --------------------------------------------------------------
-- Token inexistente, autor distinto o reclamación sin retirada responden IGUAL (appeal_not_available): no revela nada.
create function public.copyright_appeal_context(p_user_id uuid, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_claim public.copyright_claims%rowtype; v_appeal public.copyright_appeals%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp(); v_state text;
begin
  if p_user_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'appeal_not_available'; end if;
  select * into v_claim from public.copyright_claims where appeal_token_hash = p_token_hash;
  if not found or v_claim.post_author_user_id is distinct from p_user_id or v_claim.removed_at is null then
    raise exception 'appeal_not_available';
  end if;
  select * into v_appeal from public.copyright_appeals where claim_id = v_claim.id;
  v_state := case
    when v_appeal.id is not null then 'submitted'
    when v_claim.status in ('restored', 'purged') then 'closed'
    when v_claim.status <> 'removed' or v_claim.notified_at is null then 'closed'
    when v_now >= v_claim.appeal_deadline then 'expired'
    else 'open' end;
  return jsonb_build_object('reference', v_claim.reference, 'state', v_state, 'reason', v_claim.removal_reason,
    'removedAt', v_claim.removed_at, 'appealDeadline', v_claim.appeal_deadline,
    'appealStatus', v_appeal.status, 'claimStatus', v_claim.status);
end;
$$;
alter function public.copyright_appeal_context(uuid, text) owner to postgres;
revoke execute on function public.copyright_appeal_context(uuid, text) from public, anon, authenticated;
grant execute on function public.copyright_appeal_context(uuid, text) to service_role;

-- 7e. Apelación: presentación ATÓMICA (reclamación bloqueada + unique por reclamación): registra y bloquea la eliminación ----------
create function public.copyright_appeal_submit(p_user_id uuid, p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_keys constant text[] := array['contactName', 'contactEmail', 'reason', 'explanation', 'evidenceText', 'evidenceUrls',
    'statementVersion', 'statementAccepted'];
  v_claim public.copyright_claims%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
  v_name text; v_email text; v_reason text; v_expl text; v_evtext text; v_urls text[]; v_ver text;
begin
  if p_user_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'appeal_not_available'; end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_input) k where k <> all (v_keys)) then
    raise exception 'invalid_input';
  end if;
  if jsonb_typeof(p_input->'contactName') is distinct from 'string'
     or jsonb_typeof(p_input->'contactEmail') is distinct from 'string'
     or jsonb_typeof(p_input->'reason') is distinct from 'string'
     or jsonb_typeof(p_input->'explanation') is distinct from 'string'
     or jsonb_typeof(p_input->'evidenceUrls') is distinct from 'array'
     or jsonb_typeof(p_input->'statementVersion') is distinct from 'string'
     or p_input->'statementAccepted' is distinct from 'true'::jsonb
     or (p_input ? 'evidenceText' and jsonb_typeof(p_input->'evidenceText') not in ('string', 'null')) then
    raise exception 'invalid_input';
  end if;
  v_name := btrim(p_input->>'contactName'); v_email := lower(btrim(p_input->>'contactEmail'));
  v_reason := p_input->>'reason'; v_expl := btrim(p_input->>'explanation');
  v_evtext := nullif(btrim(coalesce(p_input->>'evidenceText', '')), ''); v_ver := p_input->>'statementVersion';
  if exists (select 1 from jsonb_array_elements(p_input->'evidenceUrls') e where jsonb_typeof(e) <> 'string') then
    raise exception 'invalid_input';
  end if;
  select coalesce(array_agg(e #>> '{}'), '{}') into v_urls from jsonb_array_elements(p_input->'evidenceUrls') e;
  if not public.copyright_text_ok(v_name, 2, 120)
     or char_length(v_email) not between 3 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or v_reason not in ('own_work', 'authorized', 'not_infringing', 'legal_exception', 'mistake', 'other')
     or not public.copyright_text_ok(v_expl, 10, 2000)
     or (v_evtext is not null and not public.copyright_text_ok(v_evtext, 1, 2000))
     or (cardinality(v_urls) > 0 and not public.copyright_urls_ok(v_urls))
     or (v_evtext is null and cardinality(v_urls) = 0)
     or v_ver !~ '^[a-z0-9._-]{1,20}$' then
    raise exception 'invalid_input';
  end if;
  select * into v_claim from public.copyright_claims where appeal_token_hash = p_token_hash for update;
  if not found or v_claim.post_author_user_id is distinct from p_user_id or v_claim.removed_at is null then
    raise exception 'appeal_not_available';
  end if;
  if exists (select 1 from public.copyright_appeals where claim_id = v_claim.id) then raise exception 'appeal_already_submitted'; end if;
  if v_claim.status <> 'removed' or v_claim.notified_at is null then raise exception 'appeal_not_available'; end if;
  if v_now >= v_claim.appeal_deadline then raise exception 'appeal_window_closed'; end if;
  insert into public.copyright_appeals (claim_id, author_user_id, contact_name, contact_email, reason, explanation, evidence_text,
      evidence_urls, statement_version, statement_accepted, created_at)
    values (v_claim.id, p_user_id, v_name, v_email, v_reason, v_expl, v_evtext, v_urls, v_ver, true, v_now);
  update public.copyright_claims set status = 'appeal_pending', version = version + 1, updated_at = v_now
    where id = v_claim.id returning * into v_claim;
  insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, created_at)
    values (v_claim.id, 'appeal_submitted', 'human', p_user_id, 'removed', 'appeal_pending', v_now);
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_user_id, 'copyright_claim', v_claim.id, 'copyright_appeal_submitted',
      jsonb_build_object('reference', v_claim.reference, 'to_status', 'appeal_pending', 'claim_version', v_claim.version), v_now);
  return jsonb_build_object('reference', v_claim.reference, 'state', 'submitted');
end;
$$;
alter function public.copyright_appeal_submit(uuid, text, jsonb) owner to postgres;
revoke execute on function public.copyright_appeal_submit(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.copyright_appeal_submit(uuid, text, jsonb) to service_role;

-- 7f. Resolución de la apelación (humana, con justificación obligatoria) --------------------------------------------------------
-- Aceptar restaura la publicación SOLO si sigue exactamente como la dejó la retirada (oculta, mismo autor, misma versión); si no,
-- se rechaza la operación (restore_unsafe) y la apelación sigue pendiente. Rechazar la mantiene oculta y el caso sigue activo.
create function public.copyright_appeal_resolve(
  p_actor_user_id uuid, p_claim_id uuid, p_expected_version integer, p_decision text, p_note text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_appeal public.copyright_appeals%rowtype;
  v_post public.community_posts%rowtype; v_note text; v_to text; v_email text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null or p_expected_version is null or p_expected_version < 1
     or p_decision is null or p_decision not in ('accept', 'reject') then
    raise exception 'invalid_argument';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is null then raise exception 'note_required'; end if;
  if not public.copyright_text_ok(v_note, 1, 1000) then raise exception 'invalid_argument'; end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  if v_claim.version <> p_expected_version then raise exception 'version_conflict'; end if;
  if v_claim.status <> 'appeal_pending' then raise exception 'invalid_transition'; end if;
  select * into v_appeal from public.copyright_appeals where claim_id = v_claim.id for update;
  if not found or v_appeal.status <> 'pending' then raise exception 'invalid_transition'; end if;
  if p_decision = 'accept' then
    select * into v_post from public.community_posts where id = v_claim.post_id for update;
    if not found or v_post.status <> 'hidden' or v_post.author_user_id is distinct from v_claim.post_author_user_id
       or v_post.version <> v_claim.removed_post_version then
      raise exception 'restore_unsafe';
    end if;
    update public.community_posts set status = 'published', version = version + 1, updated_at = v_now where id = v_post.id;
    v_to := 'restored';
    update public.copyright_claims set status = 'restored', restored_at = v_now, resolution_notice_pending = true,
        version = version + 1, updated_at = v_now where id = v_claim.id returning * into v_claim;
  else
    v_to := 'removed';
    update public.copyright_claims set status = 'removed', resolution_notice_pending = true,
        version = version + 1, updated_at = v_now where id = v_claim.id returning * into v_claim;
  end if;
  update public.copyright_appeals set status = case p_decision when 'accept' then 'accepted' else 'rejected' end,
      resolved_at = v_now, resolved_by = p_actor_user_id, resolution_note = v_note where id = v_appeal.id;
  insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, note, created_at)
    values (v_claim.id, case p_decision when 'accept' then 'appeal_accepted' else 'appeal_rejected' end, 'human', p_actor_user_id,
      'appeal_pending', v_to, v_note, v_now);
  if p_decision = 'accept' then
    insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, created_at)
      values (v_claim.id, 'restored', 'human', p_actor_user_id, v_to, v_to, v_now);
  end if;
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'copyright_claim', v_claim.id,
      case p_decision when 'accept' then 'copyright_appeal_accepted' else 'copyright_appeal_rejected' end,
      jsonb_build_object('reference', v_claim.reference, 'to_status', v_to, 'claim_version', v_claim.version), v_now);
  if p_decision = 'accept' then
    insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
      values ('human', p_actor_user_id, 'copyright_claim', v_claim.id, 'copyright_post_restored',
        jsonb_build_object('reference', v_claim.reference, 'to_status', v_to, 'claim_version', v_claim.version,
          'post_id', v_claim.post_id), v_now);
  end if;
  select u.email into v_email from auth.users u where u.id = v_claim.post_author_user_id;
  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status,
    'version', v_claim.version, 'updatedAt', v_claim.updated_at,
    'notice', jsonb_build_object('kind', case p_decision when 'accept' then 'appeal_accepted' else 'appeal_rejected' end,
      'authorEmail', v_email, 'reason', v_claim.removal_reason, 'windowMinutes', v_claim.removal_window_minutes,
      'resolutionNote', v_note));
end;
$$;
alter function public.copyright_appeal_resolve(uuid, uuid, integer, text, text) owner to postgres;
revoke execute on function public.copyright_appeal_resolve(uuid, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.copyright_appeal_resolve(uuid, uuid, integer, text, text) to service_role;

-- 7g. Eliminación definitiva MANUAL: repite TODAS las condiciones bajo lock y reutiliza la regla de archivos de la purga existente --
create function public.copyright_claim_purge(
  p_actor_user_id uuid, p_claim_id uuid, p_expected_version integer, p_confirm_reference text, p_note text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_post public.community_posts%rowtype; v_note text;
  v_blockers text[]; v_asset_ids uuid[] := array[]::uuid[]; v_marked uuid[] := array[]::uuid[]; v_deleted boolean := false;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null or p_expected_version is null or p_expected_version < 1 then raise exception 'invalid_argument'; end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is null then raise exception 'note_required'; end if;
  if not public.copyright_text_ok(v_note, 1, 1000) then raise exception 'invalid_argument'; end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  if v_claim.version <> p_expected_version then raise exception 'version_conflict'; end if;
  if p_confirm_reference is distinct from v_claim.reference then raise exception 'confirmation_mismatch'; end if;
  v_blockers := public.copyright_purge_blockers(v_claim, v_now);
  if cardinality(v_blockers) > 0 then raise exception 'purge_blocked'; end if;
  select * into v_post from public.community_posts where id = v_claim.post_id for update;
  if found then
    -- Solo se elimina lo que la retirada dejó oculto: cualquier otro estado lo gestiona otro circuito.
    if v_post.status <> 'hidden' or v_post.author_user_id is distinct from v_claim.post_author_user_id then
      raise exception 'post_state_conflict';
    end if;
    select coalesce(array_agg(pm.asset_id order by pm.position, pm.id), array[]::uuid[])
      into v_asset_ids from public.community_post_media pm where pm.post_id = v_post.id;
    -- La reclamación se cierra ANTES de borrar: deja de proteger la publicación (copyright_post_protected) y puede eliminarse.
    update public.copyright_claims set status = 'purged', purged_at = v_now, version = version + 1, updated_at = v_now
      where id = v_claim.id returning * into v_claim;
    -- Misma regla que community_purge_due_posts: solo los archivos usados EXCLUSIVAMENTE por esta publicación pasan a 'deleting'
    -- (el GC existente de R2 los recoge); los compartidos o de otro dominio se conservan.
    with marked as (
      update public.media_assets a set status = 'deleting', updated_at = v_now
       where a.id = any (v_asset_ids) and a.status = 'ready' and a.domain = 'community'
         and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id)
         and not exists (select 1 from public.community_post_media o where o.asset_id = a.id and o.post_id <> v_post.id)
      returning a.id)
    select coalesce(array_agg(id), array[]::uuid[]) into v_marked from marked;
    delete from public.community_posts where id = v_post.id;
    v_deleted := true;
  end if;
  if v_claim.status <> 'purged' then
    -- La publicación ya no existía: no había nada que borrar, y la reclamación se cierra igualmente.
    update public.copyright_claims set status = 'purged', purged_at = v_now, version = version + 1, updated_at = v_now
      where id = v_claim.id returning * into v_claim;
  end if;
  update public.copyright_claims set purge_asset_ids = v_marked where id = v_claim.id returning * into v_claim;
  insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, note, created_at)
    values (v_claim.id, 'purged', 'human', p_actor_user_id, 'removed', 'purged', v_note, v_now);
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'copyright_claim', v_claim.id, 'copyright_post_purged',
      jsonb_build_object('reference', v_claim.reference, 'to_status', 'purged', 'claim_version', v_claim.version,
        'post_id', v_claim.post_id, 'post_deleted', v_deleted, 'assets_marked', cardinality(v_marked),
        'assets_retained', cardinality(v_asset_ids) - cardinality(v_marked)), v_now);
  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status,
    'version', v_claim.version, 'updatedAt', v_claim.updated_at, 'postDeleted', v_deleted,
    'assetsMarked', cardinality(v_marked), 'assetsRetained', cardinality(v_asset_ids) - cardinality(v_marked));
end;
$$;
alter function public.copyright_claim_purge(uuid, uuid, integer, text, text) owner to postgres;
revoke execute on function public.copyright_claim_purge(uuid, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.copyright_claim_purge(uuid, uuid, integer, text, text) to service_role;
