-- DEL-1: base de la eliminación definitiva e irreversible de cuentas (solo SQL; sin endpoints, correo ni interfaz: eso es DEL-2 / DEL-3).
--
-- Modelo:
--   * account_deletion_requests: máquina de estados de la solicitud. Antes de confirmar: pending_confirmation / expired / superseded.
--     La confirmación acepta el borrado Y bloquea el acceso en la MISMA transacción (access_blocked); a partir de ahí NO existe ninguna
--     transición hacia atrás (trigger): solo cleanup_in_progress / cleanup_retry_pending / cleanup_manual_required / completed.
--   * account_deletion_blocks: la BARRERA persistente (una fila por cuenta, inmutable). No depende de cerrar sesión ni de caducar JWT:
--     triggers de escritura la aplican sobre Community, reportes, archivos, perfil y roles; account_deletion_gate la expone a los endpoints.
--   * account_deletion_steps: progreso idempotente por etapa (auth_block, copyright_claims, community_content, profile, media_gc, auth_delete).
--   * account_deletion_events: auditoría propia append-only (sin tokens, sin correos).
--   * Alertas para Developer: persisten en la propia solicitud (alert_open) hasta que la limpieza se COMPLETA; nada las "resuelve" por leerlas.
--   * Reintentos: backoff exponencial con tope y límite de fallos consecutivos; al agotarse, cleanup_manual_required (alerta abierta).
--     El reintento manual (solo developer) reutiliza la misma cola (reprograma; no ejecuta nada por sí mismo).
--   * Retención: catálogo account_deletion_retention_catalog (sin plazos inventados: pending_legal_review).
-- No se tocan strikes, reportes, casos, ciclos, decisiones ni auditoría de moderación existentes. Copyright: nuevo estado de reclamación
-- author_deleted (cierre técnico, ver sección 1) sin cambiar ninguna regla de retirada, apelación o purga.
-- Rollback (solo local/operador): supabase/rollbacks/20261113120000_account_deletion_foundation.rollback.sql

-- 1. Copyright: cierre técnico por borrado de la cuenta autora -------------------------------------------------------------------
-- Solo se amplían listas cerradas (estado, tipo de evento, actor 'system'); ningún trigger ni función existente cambia.
alter table public.copyright_claims drop constraint copyright_claims_status_check;
alter table public.copyright_claims add constraint copyright_claims_status_check check (status in
  ('received', 'in_review', 'needs_info', 'dismissed', 'withdrawn', 'removed', 'appeal_pending', 'restored', 'purged', 'author_deleted'));

alter table public.copyright_claims drop constraint copyright_claims_removal_check;
alter table public.copyright_claims
  add constraint copyright_claims_removal_check check (
    -- author_deleted conserva la retirada (removed_at...) si la hubo; los demás estados mantienen la regla original.
    ((status in ('removed', 'appeal_pending', 'restored', 'purged')) = (removed_at is not null) or status = 'author_deleted')
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

alter table public.copyright_claim_events drop constraint copyright_claim_events_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_kind_check check (kind in
  ('received', 'review_started', 'info_requested', 'review_resumed', 'note', 'dismissed', 'withdrawn',
   'removed', 'notified', 'notification_failed', 'token_reissued', 'appeal_submitted', 'appeal_accepted',
   'appeal_rejected', 'restored', 'purged', 'strike_applied', 'strike_notified', 'strike_notification_failed', 'author_deleted'));
alter table public.copyright_claim_events drop constraint copyright_claim_events_actor_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_actor_kind_check
  check (actor_kind in ('claimant', 'human', 'system'));

-- 1b. Community: cierre administrativo de un ciclo por eliminación de la autora (D15) ------------------------------------------------
-- Es un MOTIVO DE CIERRE más (como 'legacy'), no una decisión: no crea fila en community_moderation_decisions, ni strike, ni aviso a la autora,
-- ni cuenta como resolución procede/no procede. El contexto diferido ya exige decisión solo para closure_kind = 'decision'.
alter table public.community_moderation_cycles drop constraint community_moderation_cycles_closure_kind_check;
alter table public.community_moderation_cycles add constraint community_moderation_cycles_closure_kind_check
  check (closure_kind in ('legacy', 'decision', 'author_deleted'));

-- 2. Solicitudes ---------------------------------------------------------------------------------------------------------------
create table public.account_deletion_requests (
  id                    uuid primary key default gen_random_uuid(),
  -- Sin FK a auth.users (como strikes, casos y auditoría): el registro debe sobrevivir al borrado de la identidad. El UUID es un dato
  -- potencialmente identificable (no anonimización): acceso solo service_role, retención sujeta al catálogo.
  user_id               uuid not null,
  status                text not null default 'pending_confirmation' check (status in
    ('pending_confirmation', 'expired', 'superseded', 'access_blocked', 'cleanup_in_progress',
     'cleanup_retry_pending', 'cleanup_manual_required', 'completed')),
  token_hash            text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at      timestamptz not null,
  created_at            timestamptz not null default now(),
  confirmed_at          timestamptz,
  access_blocked_at     timestamptz,
  completed_at          timestamptz,
  version               integer not null default 1 check (version >= 1),
  total_attempts        integer not null default 0 check (total_attempts >= 0),
  consecutive_failures  integer not null default 0 check (consecutive_failures >= 0),
  manual_retry_count    integer not null default 0 check (manual_retry_count >= 0),
  next_retry_at         timestamptz,
  lease_owner           text check (lease_owner is null or char_length(lease_owner) between 1 and 80),
  lease_until           timestamptz,
  last_attempt_at       timestamptz,
  failed_stage          text,
  last_error_code       text,
  last_error_at         timestamptz,
  alert_open            boolean not null default false,
  alert_opened_at       timestamptz,
  media_asset_ids       uuid[] not null default array[]::uuid[],
  check ((status = 'pending_confirmation') = (token_hash is not null)),
  check ((status in ('pending_confirmation', 'expired', 'superseded')) = (confirmed_at is null)),
  check ((confirmed_at is null) = (access_blocked_at is null)),
  check ((status = 'completed') = (completed_at is not null)),
  check ((lease_owner is null) = (lease_until is null)),
  check (lease_owner is null or status = 'cleanup_in_progress'),
  check (not alert_open or confirmed_at is not null),
  check (status <> 'completed' or not alert_open),
  check (alert_open = (alert_opened_at is not null))
);
create unique index account_deletion_requests_pending_idx on public.account_deletion_requests (user_id)
  where status = 'pending_confirmation';
create unique index account_deletion_requests_confirmed_idx on public.account_deletion_requests (user_id)
  where confirmed_at is not null;
create unique index account_deletion_requests_token_idx on public.account_deletion_requests (token_hash)
  where token_hash is not null;
create index account_deletion_requests_work_idx on public.account_deletion_requests (status, next_retry_at, lease_until)
  where status in ('access_blocked', 'cleanup_in_progress', 'cleanup_retry_pending');
create index account_deletion_requests_alert_idx on public.account_deletion_requests (alert_opened_at) where alert_open;
alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_requests force row level security;
revoke all on table public.account_deletion_requests from public, anon, authenticated, service_role;
comment on table public.account_deletion_requests is
  'DEL-1: solicitudes de eliminación de cuenta. Privada (solo funciones SECURITY DEFINER). Tras la confirmación el estado solo avanza; nunca vuelve a activo. token_hash se borra al consumirse.';

create function public.account_deletion_requests_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'account_deletion_record_permanent' using errcode = '23001';
  end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.created_at <> old.created_at
     or (old.confirmed_at is not null and (new.confirmed_at is distinct from old.confirmed_at
                                           or new.access_blocked_at is distinct from old.access_blocked_at)) then
    raise exception 'account_deletion_identity_immutable' using errcode = '23001';
  end if;
  if old.status in ('expired', 'superseded', 'completed') then
    raise exception 'account_deletion_terminal_state' using errcode = '23001';
  end if;
  if new.status <> old.status and not ((old.status || '>' || new.status) = any (array[
       'pending_confirmation>expired', 'pending_confirmation>superseded', 'pending_confirmation>access_blocked',
       'access_blocked>cleanup_in_progress',
       'cleanup_in_progress>cleanup_retry_pending', 'cleanup_in_progress>cleanup_manual_required', 'cleanup_in_progress>completed',
       'cleanup_retry_pending>cleanup_in_progress', 'cleanup_manual_required>cleanup_retry_pending'])) then
    raise exception 'account_deletion_invalid_transition' using errcode = '23001';
  end if;
  return new;
end;
$$;
revoke all on function public.account_deletion_requests_guard() from public, anon, authenticated, service_role;
create trigger account_deletion_requests_transitions before update or delete on public.account_deletion_requests
  for each row execute function public.account_deletion_requests_guard();
create trigger account_deletion_requests_no_truncate before truncate on public.account_deletion_requests
  for each statement execute function public.account_deletion_requests_guard();

-- 3. Barrera persistente -------------------------------------------------------------------------------------------------------
create table public.account_deletion_blocks (
  user_id    uuid primary key,
  request_id uuid not null unique references public.account_deletion_requests (id),
  blocked_at timestamptz not null default now()
);
alter table public.account_deletion_blocks enable row level security;
alter table public.account_deletion_blocks force row level security;
revoke all on table public.account_deletion_blocks from public, anon, authenticated, service_role;
comment on table public.account_deletion_blocks is
  'DEL-1: barrera irreversible. Una fila por cuenta con eliminación confirmada. Inmutable: no hay UPDATE, DELETE ni TRUNCATE (no existe el desbloqueo).';

create function public.account_deletion_permanent_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  raise exception 'account_deletion_record_permanent' using errcode = '23001';
end;
$$;
revoke all on function public.account_deletion_permanent_guard() from public, anon, authenticated, service_role;
create trigger account_deletion_blocks_permanent before update or delete on public.account_deletion_blocks
  for each row execute function public.account_deletion_permanent_guard();
create trigger account_deletion_blocks_no_truncate before truncate on public.account_deletion_blocks
  for each statement execute function public.account_deletion_permanent_guard();

create function public.account_deletion_is_blocked(p_user_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.account_deletion_blocks b where b.user_id = p_user_id)
$$;
alter function public.account_deletion_is_blocked(uuid) owner to postgres;
revoke all on function public.account_deletion_is_blocked(uuid) from public, anon, authenticated, service_role;

-- Guard de escritura: la cuenta bloqueada no crea ni edita nada, tenga o no un JWT todavía válido. Solo INSERT/UPDATE: los DELETE de la
-- propia limpieza (y las cascadas) deben seguir pasando. TG_ARGV[0] es la columna con el id de la cuenta.
create function public.account_deletion_write_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid;
begin
  v_user := nullif(pg_catalog.to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if v_user is not null and public.account_deletion_is_blocked(v_user) then
    raise exception 'account_deletion_blocked';
  end if;
  return new;
end;
$$;
alter function public.account_deletion_write_guard() owner to postgres;
revoke all on function public.account_deletion_write_guard() from public, anon, authenticated, service_role;

create function public.account_deletion_post_media_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_author uuid;
begin
  select author_user_id into v_author from public.community_posts where id = new.post_id;
  if v_author is not null and public.account_deletion_is_blocked(v_author) then
    raise exception 'account_deletion_blocked';
  end if;
  return new;
end;
$$;
alter function public.account_deletion_post_media_guard() owner to postgres;
revoke all on function public.account_deletion_post_media_guard() from public, anon, authenticated, service_role;

create trigger account_deletion_posts_insert before insert on public.community_posts
  for each row execute function public.account_deletion_write_guard('author_user_id');
create trigger account_deletion_posts_edit before update of text on public.community_posts
  for each row when (new.text is distinct from old.text) execute function public.account_deletion_write_guard('author_user_id');
create trigger account_deletion_likes_insert before insert on public.community_post_likes
  for each row execute function public.account_deletion_write_guard('user_id');
create trigger account_deletion_reports_insert before insert on public.community_post_reports
  for each row execute function public.account_deletion_write_guard('reporter_user_id');
create trigger account_deletion_media_insert before insert on public.media_assets
  for each row execute function public.account_deletion_write_guard('created_by');
create trigger account_deletion_post_media_write before insert or update on public.community_post_media
  for each row execute function public.account_deletion_post_media_guard();
create trigger account_deletion_profile_update before update on public.profiles
  for each row execute function public.account_deletion_write_guard('user_id');
-- Una cuenta bloqueada tampoco puede (re)crear su perfil: sin esto podria volver a reservar un username recien liberado.
create trigger account_deletion_profile_insert before insert on public.profiles
  for each row execute function public.account_deletion_write_guard('user_id');
create trigger account_deletion_roles_insert before insert on public.admin_roles
  for each row execute function public.account_deletion_write_guard('user_id');

-- 4. Etapas, auditoría y retención -----------------------------------------------------------------------------------------------
create table public.account_deletion_steps (
  request_id      uuid not null references public.account_deletion_requests (id),
  stage           text not null check (stage in
    ('auth_block', 'copyright_claims', 'community_content', 'profile', 'media_gc', 'auth_delete')),
  ord             integer not null check (ord between 1 and 6),
  status          text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  last_error_code text,
  started_at      timestamptz,
  finished_at     timestamptz,
  primary key (request_id, stage),
  unique (request_id, ord),
  check ((status = 'done') = (finished_at is not null))
);
alter table public.account_deletion_steps enable row level security;
alter table public.account_deletion_steps force row level security;
revoke all on table public.account_deletion_steps from public, anon, authenticated, service_role;

create function public.account_deletion_steps_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then raise exception 'account_deletion_step_immutable' using errcode = '23001'; end if;
  if old.status = 'done' or new.request_id <> old.request_id or new.stage <> old.stage or new.ord <> old.ord then
    raise exception 'account_deletion_step_immutable' using errcode = '23001';
  end if;
  return new;
end;
$$;
revoke all on function public.account_deletion_steps_guard() from public, anon, authenticated, service_role;
create trigger account_deletion_steps_transitions before update or delete on public.account_deletion_steps
  for each row execute function public.account_deletion_steps_guard();
create trigger account_deletion_steps_no_truncate before truncate on public.account_deletion_steps
  for each statement execute function public.account_deletion_steps_guard();

create table public.account_deletion_events (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.account_deletion_requests (id),
  kind          text not null check (kind in
    ('requested', 'superseded', 'expired', 'confirmed', 'cleanup_claimed', 'stage_started', 'stage_done', 'stage_failed',
     'retry_scheduled', 'manual_required', 'developer_retry', 'released', 'case_closed', 'completed')),
  stage         text,
  actor_kind    text not null check (actor_kind in ('user', 'system', 'human')),
  actor_user_id uuid,
  error_code    text,
  metadata      jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'
    and not (metadata ?| array['token', 'token_hash', 'email', 'password'])),
  created_at    timestamptz not null default now(),
  check ((actor_kind = 'system') = (actor_user_id is null))
);
create index account_deletion_events_request_idx on public.account_deletion_events (request_id, created_at, id);
alter table public.account_deletion_events enable row level security;
alter table public.account_deletion_events force row level security;
revoke all on table public.account_deletion_events from public, anon, authenticated, service_role;
create trigger account_deletion_events_immutable before update or delete on public.account_deletion_events
  for each row execute function public.account_deletion_permanent_guard();
create trigger account_deletion_events_no_truncate before truncate on public.account_deletion_events
  for each statement execute function public.account_deletion_permanent_guard();

create table public.account_deletion_retention_catalog (
  dataset        text primary key,
  class          text not null check (class in
    ('delete', 'retain_justified', 'retain_pending_process', 'anonymize_when_possible', 'restricted_evidence')),
  retention_days integer check (retention_days is null or retention_days > 0),
  basis_status   text not null default 'pending_legal_review' check (basis_status in ('pending_legal_review', 'approved')),
  note           text not null,
  check (basis_status <> 'approved' or retention_days is not null or class = 'delete')
);
alter table public.account_deletion_retention_catalog enable row level security;
alter table public.account_deletion_retention_catalog force row level security;
revoke all on table public.account_deletion_retention_catalog from public, anon, authenticated, service_role;
comment on table public.account_deletion_retention_catalog is
  'DEL-1: clasificación de datos al eliminar una cuenta. Ningún plazo está aprobado: todo pending_legal_review (ver docs/REP-1-COPY-1.md). Un plazo solo se aplica cuando basis_status = approved.';
insert into public.account_deletion_retention_catalog (dataset, class, note) values
  ('profile_data', 'delete', 'Perfil, nombre visible, biografia y avatar: se borran en la etapa profile.'),
  ('username', 'delete', 'Se libera al borrar el perfil (profiles.username es la unica fuente); sin cuarentena ni reserva. Los registros historicos usan el UUID, nunca el username.'),
  ('moderation_case_closure', 'restricted_evidence', 'Cierre administrativo author_deleted de ciclos pendientes: sin decision, sin strike, sin aviso.'),
  ('backups_and_issued_signed_urls', 'retain_pending_process', 'Copias de seguridad del proveedor y URLs firmadas ya emitidas: fuera de nuestro control inmediato; caducan/rotan segun el proveedor. Informar en la politica de privacidad.'),
  ('community_posts_and_media', 'delete', 'Publicaciones propias y archivos exclusivos (R2 via GC).'),
  ('community_likes', 'delete', 'Interacciones propias.'),
  ('auth_identity', 'delete', 'Identidad de Supabase Auth (etapa auth_delete).'),
  ('moderation_reports_sent', 'retain_justified', 'Reportes enviados: evidencia de casos; sin FK a la cuenta. Plazo por definir.'),
  ('moderation_cases_cycles_decisions', 'restricted_evidence', 'Casos, ciclos y decisiones: inmutables, UUID original, acceso solo servidor.'),
  ('community_strikes', 'restricted_evidence', 'Strikes historicos (Community y Copyright): inmutables, no se revocan ni se borran.'),
  ('moderation_audit_log', 'restricted_evidence', 'Auditoria de moderacion: append-only.'),
  ('copyright_claims_and_events', 'restricted_evidence', 'Reclamaciones, historial y snapshot minimo; las activas pasan a author_deleted.'),
  ('copyright_appeals_contact', 'anonymize_when_possible', 'Nombre y correo de contacto de la autora en apelaciones: pendiente de definir como anonimizar.'),
  ('account_deletion_records', 'retain_justified', 'Solicitud, etapas y eventos de esta tabla (UUID de la cuenta): plazo por definir.'),
  ('account_deletion_token_hash', 'retain_pending_process', 'Solo hasta consumirse o caducar; luego es NULL.'),
  ('shared_media_assets', 'retain_pending_process', 'Archivos aun referenciados por otro recurso: se conservan hasta liberarse.');

-- 5. Funciones internas (solo service_role) ----------------------------------------------------------------------------------------
create function public.account_deletion_gate(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
  select case when b.user_id is null then jsonb_build_object('blocked', false)
              else jsonb_build_object('blocked', true, 'requestId', b.request_id, 'status', r.status) end
    from (select 1) x
    left join public.account_deletion_blocks b on b.user_id = p_user_id
    left join public.account_deletion_requests r on r.id = b.request_id
$$;
alter function public.account_deletion_gate(uuid) owner to postgres;
revoke execute on function public.account_deletion_gate(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_gate(uuid) to service_role;

create function public.account_deletion_request(p_user_id uuid, p_token_hash text, p_ttl_minutes integer default 30)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_email text; v_prev public.account_deletion_requests%rowtype; v_new public.account_deletion_requests%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_user_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_ttl_minutes is null or p_ttl_minutes not between 5 and 60 then
    raise exception 'invalid_argument';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account_deletion:' || p_user_id::text, 0));
  if public.account_deletion_is_blocked(p_user_id) then raise exception 'account_deletion_in_progress'; end if;
  select u.email into v_email from auth.users u where u.id = p_user_id;
  if not found then raise exception 'user_not_found'; end if;
  if v_email is null then raise exception 'no_email'; end if;
  -- Las cuentas privilegiadas siguen un procedimiento separado (D10): el flujo ordinario nunca las borra.
  if exists (select 1 from public.admin_roles r where r.user_id = p_user_id) then
    raise exception 'privileged_account_requires_procedure';
  end if;
  if (select count(*) from public.account_deletion_requests r
       where r.user_id = p_user_id and r.created_at > v_now - interval '24 hours') >= 5 then
    raise exception 'too_many_requests';
  end if;
  select * into v_prev from public.account_deletion_requests
    where user_id = p_user_id and status = 'pending_confirmation' for update;
  if found then
    if v_prev.created_at > v_now - interval '60 seconds' then raise exception 'request_too_soon'; end if;
    update public.account_deletion_requests set status = 'superseded', token_hash = null, version = version + 1
      where id = v_prev.id;
    insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
      values (v_prev.id, 'superseded', 'user', p_user_id, v_now);
  end if;
  insert into public.account_deletion_requests (user_id, token_hash, token_expires_at, created_at)
    values (p_user_id, p_token_hash, v_now + pg_catalog.make_interval(mins => p_ttl_minutes), v_now)
    returning * into v_new;
  insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
    values (v_new.id, 'requested', 'user', p_user_id, v_now);
  return jsonb_build_object('requestId', v_new.id, 'expiresAt', v_new.token_expires_at, 'email', v_email);
end;
$$;
alter function public.account_deletion_request(uuid, text, integer) owner to postgres;
revoke execute on function public.account_deletion_request(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.account_deletion_request(uuid, text, integer) to service_role;

-- Vista previa del enlace: SOLO lectura (nunca consume ni destruye).
create function public.account_deletion_preview(p_user_id uuid, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_req public.account_deletion_requests%rowtype;
begin
  if p_user_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_argument'; end if;
  if public.account_deletion_is_blocked(p_user_id) then return jsonb_build_object('state', 'already_deleting'); end if;
  select * into v_req from public.account_deletion_requests
    where token_hash = p_token_hash and user_id = p_user_id and status = 'pending_confirmation';
  if not found then return jsonb_build_object('state', 'invalid'); end if;
  if v_req.token_expires_at <= pg_catalog.clock_timestamp() then return jsonb_build_object('state', 'expired'); end if;
  return jsonb_build_object('state', 'valid', 'expiresAt', v_req.token_expires_at);
end;
$$;
alter function public.account_deletion_preview(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_preview(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_preview(uuid, text) to service_role;

-- Confirmación final: token + identidad de la sesión (p_user_id lo verifica el endpoint por JWT) + consumo + barrera + etapas, UNA transacción.
-- Los resultados esperados se devuelven (no se lanzan) para que la caducidad quede registrada.
create function public.account_deletion_confirm(p_user_id uuid, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_req public.account_deletion_requests%rowtype; v_block public.account_deletion_blocks%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_user_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_argument'; end if;
  perform public.upmina_lock_admin_roles(); -- regla del proyecto: primero el lock de roles, luego filas
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account_deletion:' || p_user_id::text, 0));
  select * into v_block from public.account_deletion_blocks where user_id = p_user_id;
  if found then return jsonb_build_object('outcome', 'already_deleting', 'requestId', v_block.request_id); end if;
  select * into v_req from public.account_deletion_requests
    where token_hash = p_token_hash and user_id = p_user_id and status = 'pending_confirmation' for update;
  if not found then return jsonb_build_object('outcome', 'invalid_token'); end if;
  if v_req.token_expires_at <= v_now then
    update public.account_deletion_requests set status = 'expired', token_hash = null, version = version + 1 where id = v_req.id;
    insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
      values (v_req.id, 'expired', 'system', null, v_now);
    return jsonb_build_object('outcome', 'expired');
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then return jsonb_build_object('outcome', 'user_not_found'); end if;
  if exists (select 1 from public.admin_roles r where r.user_id = p_user_id) then
    return jsonb_build_object('outcome', 'privileged_account');
  end if;
  update public.account_deletion_requests
     set status = 'access_blocked', token_hash = null, confirmed_at = v_now, access_blocked_at = v_now, version = version + 1
   where id = v_req.id;
  insert into public.account_deletion_blocks (user_id, request_id, blocked_at) values (p_user_id, v_req.id, v_now);
  insert into public.account_deletion_steps (request_id, stage, ord)
    select v_req.id, s.stage, s.ord from (values ('auth_block', 1), ('copyright_claims', 2), ('community_content', 3),
      ('profile', 4), ('media_gc', 5), ('auth_delete', 6)) as s(stage, ord);
  insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
    values (v_req.id, 'confirmed', 'user', p_user_id, v_now);
  return jsonb_build_object('outcome', 'confirmed', 'requestId', v_req.id, 'blockedAt', v_now);
end;
$$;
alter function public.account_deletion_confirm(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_confirm(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_confirm(uuid, text) to service_role;

create function public.account_deletion_expire_pending(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_now timestamptz := pg_catalog.clock_timestamp(); v_id uuid; v_n integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then raise exception 'invalid_argument'; end if;
  for v_id in select id from public.account_deletion_requests
               where status = 'pending_confirmation' and token_expires_at <= v_now order by token_expires_at limit p_limit
               for update skip locked loop
    update public.account_deletion_requests set status = 'expired', token_hash = null, version = version + 1 where id = v_id;
    insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
      values (v_id, 'expired', 'system', null, v_now);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
alter function public.account_deletion_expire_pending(integer) owner to postgres;
revoke execute on function public.account_deletion_expire_pending(integer) from public, anon, authenticated;
grant execute on function public.account_deletion_expire_pending(integer) to service_role;

-- Cola con lease: reclama solicitudes listas, en reintento vencido o con lease caducado (worker caído). Devuelve el user_id solo al servidor.
create function public.account_deletion_claim(p_worker text, p_lease_seconds integer default 300, p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp(); v_req public.account_deletion_requests%rowtype; v_out jsonb := '[]'::jsonb;
  v_resumed boolean;
begin
  if p_worker is null or char_length(p_worker) not between 1 and 80 or p_lease_seconds is null or p_lease_seconds not between 30 and 1800
     or p_limit is null or p_limit not between 1 and 20 then
    raise exception 'invalid_argument';
  end if;
  for v_req in select * from public.account_deletion_requests
                where status = 'access_blocked'
                   or (status = 'cleanup_retry_pending' and next_retry_at <= v_now)
                   or (status = 'cleanup_in_progress' and lease_until <= v_now)
                order by access_blocked_at, id limit p_limit for update skip locked loop
    v_resumed := v_req.status <> 'access_blocked';
    -- Una etapa que quedó "running" con el worker caído se repite (todas son idempotentes).
    update public.account_deletion_steps set status = 'pending' where request_id = v_req.id and status = 'running';
    update public.account_deletion_requests
       set status = 'cleanup_in_progress', lease_owner = p_worker, lease_until = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
           last_attempt_at = v_now, next_retry_at = null, version = version + 1
     where id = v_req.id;
    insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, metadata, created_at)
      values (v_req.id, 'cleanup_claimed', 'system', null, jsonb_build_object('resumed', v_resumed), v_now);
    v_out := v_out || jsonb_build_array(jsonb_build_object('requestId', v_req.id, 'userId', v_req.user_id, 'resumed', v_resumed,
      'nextStage', (select s.stage from public.account_deletion_steps s where s.request_id = v_req.id and s.status <> 'done'
                     order by s.ord limit 1)));
  end loop;
  return v_out;
end;
$$;
alter function public.account_deletion_claim(text, integer, integer) owner to postgres;
revoke execute on function public.account_deletion_claim(text, integer, integer) from public, anon, authenticated;
grant execute on function public.account_deletion_claim(text, integer, integer) to service_role;

create function public.account_deletion_assert_running(p_request_id uuid, p_worker text, p_stage text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_req public.account_deletion_requests%rowtype; v_step public.account_deletion_steps%rowtype;
begin
  select * into v_req from public.account_deletion_requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_req.status <> 'cleanup_in_progress' or v_req.lease_owner is distinct from p_worker
     or v_req.lease_until <= pg_catalog.clock_timestamp() then
    raise exception 'lease_lost';
  end if;
  select * into v_step from public.account_deletion_steps where request_id = p_request_id and stage = p_stage for update;
  if not found then raise exception 'invalid_argument'; end if;
  if v_step.status <> 'running' then raise exception 'stage_not_running'; end if;
  return v_req.user_id;
end;
$$;
alter function public.account_deletion_assert_running(uuid, text, text) owner to postgres;
revoke all on function public.account_deletion_assert_running(uuid, text, text) from public, anon, authenticated, service_role;

create function public.account_deletion_step_start(p_request_id uuid, p_worker text, p_stage text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_req public.account_deletion_requests%rowtype; v_step public.account_deletion_steps%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_request_id is null or p_worker is null or p_stage is null then raise exception 'invalid_argument'; end if;
  select * into v_req from public.account_deletion_requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_req.status <> 'cleanup_in_progress' or v_req.lease_owner is distinct from p_worker or v_req.lease_until <= v_now then
    raise exception 'lease_lost';
  end if;
  select * into v_step from public.account_deletion_steps where request_id = p_request_id and stage = p_stage for update;
  if not found then raise exception 'invalid_argument'; end if;
  if v_step.status = 'done' then return jsonb_build_object('stage', p_stage, 'alreadyDone', true); end if;
  if exists (select 1 from public.account_deletion_steps s where s.request_id = p_request_id and s.ord < v_step.ord and s.status <> 'done') then
    raise exception 'stage_out_of_order';
  end if;
  update public.account_deletion_steps set status = 'running', attempts = attempts + 1, started_at = v_now where request_id = p_request_id and stage = p_stage;
  update public.account_deletion_requests set total_attempts = total_attempts + 1, last_attempt_at = v_now where id = p_request_id;
  insert into public.account_deletion_events (request_id, kind, stage, actor_kind, actor_user_id, created_at)
    values (p_request_id, 'stage_started', p_stage, 'system', null, v_now);
  return jsonb_build_object('stage', p_stage, 'alreadyDone', false);
end;
$$;
alter function public.account_deletion_step_start(uuid, text, text) owner to postgres;
revoke execute on function public.account_deletion_step_start(uuid, text, text) from public, anon, authenticated;
grant execute on function public.account_deletion_step_start(uuid, text, text) to service_role;

create function public.account_deletion_step_finish(
  p_request_id uuid, p_worker text, p_stage text, p_ok boolean, p_error_code text default null, p_retry_after_seconds integer default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_req public.account_deletion_requests%rowtype; v_now timestamptz := pg_catalog.clock_timestamp(); v_failures integer; v_delay integer;
  v_manual boolean;
begin
  if p_request_id is null or p_worker is null or p_stage is null or p_ok is null
     or (p_ok and p_error_code is not null)
     or (not p_ok and (p_error_code is null or p_error_code not in
       ('r2_unavailable', 'auth_unavailable', 'db_error', 'media_gc_pending', 'last_admin_protected', 'avatar_not_supported', 'timeout', 'unexpected')))
     or (p_retry_after_seconds is not null and p_retry_after_seconds < 0) then
    raise exception 'invalid_argument';
  end if;
  perform public.account_deletion_assert_running(p_request_id, p_worker, p_stage);
  select * into v_req from public.account_deletion_requests where id = p_request_id;
  if p_ok then
    update public.account_deletion_steps set status = 'done', finished_at = v_now, last_error_code = null
      where request_id = p_request_id and stage = p_stage;
    insert into public.account_deletion_events (request_id, kind, stage, actor_kind, actor_user_id, created_at)
      values (p_request_id, 'stage_done', p_stage, 'system', null, v_now);
    if not exists (select 1 from public.account_deletion_steps s where s.request_id = p_request_id and s.status <> 'done') then
      update public.account_deletion_requests
         set status = 'completed', completed_at = v_now, lease_owner = null, lease_until = null, next_retry_at = null,
             consecutive_failures = 0, failed_stage = null, last_error_code = null, alert_open = false, alert_opened_at = null,
             media_asset_ids = array[]::uuid[], version = version + 1
       where id = p_request_id;
      insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
        values (p_request_id, 'completed', 'system', null, v_now);
      return jsonb_build_object('stage', p_stage, 'completed', true);
    end if;
    update public.account_deletion_requests
       set consecutive_failures = 0, failed_stage = case when failed_stage = p_stage then null else failed_stage end,
           version = version + 1
     where id = p_request_id;
    return jsonb_build_object('stage', p_stage, 'completed', false);
  end if;
  v_failures := v_req.consecutive_failures + 1;
  v_manual := v_failures >= 8 or p_error_code in ('last_admin_protected', 'avatar_not_supported');
  v_delay := least(21600, greatest(30, coalesce(p_retry_after_seconds, 30 * (2 ^ least(v_failures - 1, 10))::integer)));
  update public.account_deletion_steps set status = 'failed', last_error_code = p_error_code where request_id = p_request_id and stage = p_stage;
  update public.account_deletion_requests
     set status = case when v_manual then 'cleanup_manual_required' else 'cleanup_retry_pending' end,
         consecutive_failures = v_failures, failed_stage = p_stage, last_error_code = p_error_code, last_error_at = v_now,
         alert_open = true, alert_opened_at = coalesce(alert_opened_at, v_now),
         next_retry_at = case when v_manual then null else v_now + pg_catalog.make_interval(secs => v_delay) end,
         lease_owner = null, lease_until = null, version = version + 1
   where id = p_request_id;
  insert into public.account_deletion_events (request_id, kind, stage, actor_kind, actor_user_id, error_code, created_at)
    values (p_request_id, 'stage_failed', p_stage, 'system', null, p_error_code, v_now);
  insert into public.account_deletion_events (request_id, kind, stage, actor_kind, actor_user_id, error_code, metadata, created_at)
    values (p_request_id, case when v_manual then 'manual_required' else 'retry_scheduled' end, p_stage, 'system', null, p_error_code,
      case when v_manual then '{}'::jsonb else jsonb_build_object('delaySeconds', v_delay) end, v_now);
  return jsonb_build_object('stage', p_stage, 'completed', false, 'manualRequired', v_manual, 'retryInSeconds', case when v_manual then null else v_delay end);
end;
$$;
alter function public.account_deletion_step_finish(uuid, text, text, boolean, text, integer) owner to postgres;
revoke execute on function public.account_deletion_step_finish(uuid, text, text, boolean, text, integer) from public, anon, authenticated;
grant execute on function public.account_deletion_step_finish(uuid, text, text, boolean, text, integer) to service_role;

-- El worker termina antes de acabar (presupuesto de tiempo): devuelve la solicitud a la cola sin contar fallo.
create function public.account_deletion_release(p_request_id uuid, p_worker text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_req public.account_deletion_requests%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v_req from public.account_deletion_requests where id = p_request_id for update;
  if not found or v_req.status <> 'cleanup_in_progress' or v_req.lease_owner is distinct from p_worker then raise exception 'lease_lost'; end if;
  update public.account_deletion_steps set status = 'pending' where request_id = p_request_id and status = 'running';
  update public.account_deletion_requests set status = 'cleanup_retry_pending', next_retry_at = v_now, lease_owner = null, lease_until = null,
         version = version + 1 where id = p_request_id;
  insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
    values (p_request_id, 'released', 'system', null, v_now);
end;
$$;
alter function public.account_deletion_release(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_release(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_release(uuid, text) to service_role;

-- 6. Etapas SQL (idempotentes; cada una en UNA transacción: o todo o nada) -------------------------------------------------------------
-- copyright_claims: cierre TÉCNICO de las reclamaciones activas sobre publicaciones de la cuenta. No decide nada sobre el fondo, no toca la
-- apelación (sigue como esté), la retirada ni los strikes; sí invalida el enlace de apelación (la autora ya no existe) y el aviso pendiente.
create function public.account_deletion_stage_copyright(p_request_id uuid, p_worker text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid; v_claim record; v_n integer := 0; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_user := public.account_deletion_assert_running(p_request_id, p_worker, 'copyright_claims');
  for v_claim in select id, status from public.copyright_claims
                  where post_author_user_id = v_user
                    and status in ('received', 'in_review', 'needs_info', 'removed', 'appeal_pending')
                  order by created_at, id for update loop
    update public.copyright_claims
       set status = 'author_deleted', appeal_token_hash = null, resolution_notice_pending = false,
           version = version + 1, updated_at = v_now
     where id = v_claim.id;
    insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, created_at)
      values (v_claim.id, 'author_deleted', 'system', null, v_claim.status, 'author_deleted', v_now);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('claimsClosed', v_n);
end;
$$;
alter function public.account_deletion_stage_copyright(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_stage_copyright(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_stage_copyright(uuid, text) to service_role;

-- community_content: mismas reglas que community_purge_due_posts / copyright_claim_purge: solo los archivos usados EXCLUSIVAMENTE por estas
-- publicaciones pasan a 'deleting' (el GC de R2 los recoge); los compartidos se conservan. Nunca una cascada ciega de auth.users.
create function public.account_deletion_stage_content(p_request_id uuid, p_worker text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_user uuid; v_post_ids uuid[]; v_asset_ids uuid[]; v_marked uuid[]; v_likes integer; v_posts integer; v_case record; v_cases integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_user := public.account_deletion_assert_running(p_request_id, p_worker, 'community_content');
  -- Una publicación con reclamación activa seguiría protegida: la etapa anterior (copyright_claims) debe haberla cerrado.
  perform 1 from public.community_posts p where p.author_user_id = v_user order by p.id for update;
  select coalesce(array_agg(p.id), array[]::uuid[]) into v_post_ids from public.community_posts p where p.author_user_id = v_user;
  if exists (select 1 from unnest(v_post_ids) pid where public.copyright_post_protected(pid)) then
    raise exception 'copyright_stage_incomplete';
  end if;
  select coalesce(array_agg(distinct pm.asset_id), array[]::uuid[]) into v_asset_ids
    from public.community_post_media pm where pm.post_id = any (v_post_ids);
  with marked as (
    update public.media_assets a set status = 'deleting', updated_at = v_now
     where a.id = any (v_asset_ids) and a.status = 'ready' and a.domain = 'community'
       and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id)
       and not exists (select 1 from public.community_post_media o where o.asset_id = a.id and o.post_id <> all (v_post_ids))
    returning a.id)
  select coalesce(array_agg(id), array[]::uuid[]) into v_marked from marked;
  update public.account_deletion_requests
     set media_asset_ids = (select coalesce(array_agg(distinct x), array[]::uuid[]) from unnest(media_asset_ids || v_marked) x)
   where id = p_request_id;
  -- D15: casos pendientes de sus publicaciones (o con ella como autora objetivo, aunque la publicación ya no exista). Mismo orden de bloqueo que
  -- el resto de Community (publicación -> caso). Cierre en la MISMA transacción que el borrado: el contexto diferido (cuarentena/ciclo) nunca ve
  -- una publicación en cuarentena con ciclo cerrado. Solo ciclos 'pending' y vigentes: un caso ya cerrado no se toca ni se reabre; repetir no duplica.
  for v_case in select c.id, c.post_id from public.community_moderation_cases c
                 where c.status = 'pending' and (c.target_author_user_id = v_user or c.post_id = any (v_post_ids))
                 order by c.id for update loop
    update public.community_moderation_cycles set status = 'closed', closure_kind = 'author_deleted', closed_at = v_now
      where case_id = v_case.id and status = 'pending';
    update public.community_moderation_cases set status = 'closed', closed_at = v_now, activity_at = v_now, version = version + 1
      where id = v_case.id;
    insert into public.account_deletion_events (request_id, kind, stage, actor_kind, actor_user_id, metadata, created_at)
      values (p_request_id, 'case_closed', 'community_content', 'system', null,
        jsonb_build_object('caseId', v_case.id, 'closureKind', 'author_deleted'), v_now);
    v_cases := v_cases + 1;
  end loop;
  delete from public.community_post_likes where user_id = v_user;
  get diagnostics v_likes = row_count;
  delete from public.community_posts where author_user_id = v_user; -- arrastra post_media y los likes recibidos
  get diagnostics v_posts = row_count;
  return jsonb_build_object('postsDeleted', v_posts, 'likesDeleted', v_likes, 'casesClosed', v_cases, 'assetsMarked', cardinality(v_marked),
    'assetsRetained', cardinality(v_asset_ids) - cardinality(v_marked));
end;
$$;
alter function public.account_deletion_stage_content(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_stage_content(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_stage_content(uuid, text) to service_role;

create function public.account_deletion_stage_profile(p_request_id uuid, p_worker text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid; v_avatar text;
begin
  v_user := public.account_deletion_assert_running(p_request_id, p_worker, 'profile');
  select avatar_path into v_avatar from public.profiles where user_id = v_user for update;
  -- Hoy ningun flujo escribe avatar_path. Si apareciera uno, no se borra la fila a ciegas: la etapa falla (fail-closed) y exige intervencion.
  if v_avatar is not null then raise exception 'avatar_not_supported'; end if;
  -- El username se libera borrando esta fila (única fuente de verdad: profiles.username unique). Solo cuando ya no queda NADA público de la cuenta
  -- (publicaciones, me gusta): el orden de etapas lo garantiza y aquí se comprueba por si se invocara fuera de orden.
  if exists (select 1 from public.community_posts where author_user_id = v_user)
     or exists (select 1 from public.community_post_likes where user_id = v_user) then
    raise exception 'content_stage_incomplete';
  end if;
  delete from public.profiles where user_id = v_user;
  return jsonb_build_object('profileDeleted', true, 'usernameReleased', true);
end;
$$;
alter function public.account_deletion_stage_profile(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_stage_profile(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_stage_profile(uuid, text) to service_role;

-- media_gc: re-marca archivos propios huerfanos (p. ej. subidas en curso que terminaron despues) y cuenta lo que el GC aun no ha borrado.
-- pending > 0 => el ejecutor termina la etapa con media_gc_pending (reintento); pending = 0 => se puede borrar la identidad.
create function public.account_deletion_stage_media(p_request_id uuid, p_worker text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid; v_ids uuid[]; v_pending integer; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_user := public.account_deletion_assert_running(p_request_id, p_worker, 'media_gc');
  update public.media_assets a set status = 'deleting', updated_at = v_now
   where a.created_by = v_user and a.domain = 'community' and a.status in ('ready', 'failed')
     and not exists (select 1 from public.community_post_media pm where pm.asset_id = a.id)
     and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id);
  select media_asset_ids into v_ids from public.account_deletion_requests where id = p_request_id;
  select count(*) into v_pending from public.media_assets a
   where a.id = any (v_ids)
      or (a.created_by = v_user and a.domain = 'community'
          and not exists (select 1 from public.cosplay_post_images ci where ci.asset_id = a.id));
  return jsonb_build_object('pending', v_pending);
end;
$$;
alter function public.account_deletion_stage_media(uuid, text) owner to postgres;
revoke execute on function public.account_deletion_stage_media(uuid, text) from public, anon, authenticated;
grant execute on function public.account_deletion_stage_media(uuid, text) to service_role;

-- 7. Developer: alertas y reintento manual (rol developer verificado en servidor, bajo lock) ---------------------------------------------
create function public.account_deletion_alerts(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_role text; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id;
  if v_role is distinct from 'developer' then raise exception 'actor_not_developer'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'requestId', r.id, 'status', r.status, 'accessBlocked', true,
      'failedStage', r.failed_stage, 'errorCode', r.last_error_code, 'lastErrorAt', r.last_error_at,
      'lastAttemptAt', r.last_attempt_at, 'totalAttempts', r.total_attempts, 'consecutiveFailures', r.consecutive_failures,
      'nextRetryAt', r.next_retry_at, 'manualRequired', r.status = 'cleanup_manual_required',
      'stalled', (not r.alert_open),
      'pendingStages', (select coalesce(jsonb_agg(s.stage order by s.ord), '[]'::jsonb)
                          from public.account_deletion_steps s where s.request_id = r.id and s.status <> 'done'))
      order by coalesce(r.alert_opened_at, r.access_blocked_at), r.id)
    from public.account_deletion_requests r
    where r.status <> 'completed' and r.confirmed_at is not null
      and (r.alert_open
        or (r.status = 'access_blocked' and r.access_blocked_at < v_now - interval '15 minutes')
        or (r.status = 'cleanup_in_progress' and r.lease_until < v_now - interval '15 minutes'))), '[]'::jsonb);
end;
$$;
alter function public.account_deletion_alerts(uuid) owner to postgres;
revoke execute on function public.account_deletion_alerts(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_alerts(uuid) to service_role;

create function public.account_deletion_developer_retry(p_actor_user_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_role text; v_req public.account_deletion_requests%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is distinct from 'developer' then raise exception 'actor_not_developer'; end if;
  if p_request_id is null then raise exception 'invalid_argument'; end if;
  select * into v_req from public.account_deletion_requests where id = p_request_id for update;
  if not found or v_req.confirmed_at is null then raise exception 'request_not_found'; end if;
  if v_req.status = 'completed' then raise exception 'already_completed'; end if;
  if v_req.status not in ('cleanup_retry_pending', 'cleanup_manual_required') then raise exception 'retry_not_applicable'; end if;
  -- Solo se reprograma: el ejecutor (mismo claim que los reintentos automáticos) reprocesa las etapas incompletas. No se toca la barrera.
  update public.account_deletion_steps set status = 'pending' where request_id = p_request_id and status = 'failed';
  update public.account_deletion_requests
     set status = 'cleanup_retry_pending', next_retry_at = v_now, consecutive_failures = 0, manual_retry_count = manual_retry_count + 1,
         version = version + 1
   where id = p_request_id;
  insert into public.account_deletion_events (request_id, kind, actor_kind, actor_user_id, created_at)
    values (p_request_id, 'developer_retry', 'human', p_actor_user_id, v_now);
  return jsonb_build_object('requestId', p_request_id, 'status', 'cleanup_retry_pending');
end;
$$;
alter function public.account_deletion_developer_retry(uuid, uuid) owner to postgres;
revoke execute on function public.account_deletion_developer_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_developer_retry(uuid, uuid) to service_role;
