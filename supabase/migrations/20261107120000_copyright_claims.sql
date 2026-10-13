-- COPY-1 · FASE 2A — reclamaciones de copyright: modelo mínimo, creación pública (texto y enlaces) y revisión humana.
-- PROPUESTA LOCAL: NO aplicada en ningún entorno. Forward-only, posterior a 20261106120000.
--
-- ALCANCE (fase 2A): crear, consultar y REVISAR reclamaciones. NO hay retirada, restauración, purga, borrado de R2 ni correo
-- de retirada (fase 2B). Una reclamación NUNCA toca community_posts, casos, ciclos, reportes ordinarios ni strikes:
--   * es un circuito aparte: no cuenta para el umbral de ocultación, no abre casos de moderación y no usa decisiones de reportes;
--   * ningún estado de esta fase oculta ni elimina nada (los estados son received, in_review, needs_info, dismissed, withdrawn).
--
-- Piezas:
--   1. copyright_claims            expediente (reclamante, obra, enlaces de prueba, publicación reclamada con copia congelada).
--   2. copyright_claim_events      historial propio, append-only (recepción, revisión, notas, descarte, retirada del reclamante).
--   3. copyright_claim_limits      contadores de abuso del canal PÚBLICO: solo digests HMAC de 64 hex calculados por el backend.
--   4. moderation_audit_log        se AMPLÍA (acciones copyright_claim_* y target_type 'copyright_claim'): las decisiones de
--      revisión van al MISMO historial general de moderación. Las decisiones de reportes ordinarios no se modifican.
--   5. RPC copyright_claim_create (pública vía backend), copyright_claims_read y copyright_claim_review (moderación).
--
-- Seguridad: las tablas y la secuencia son privadas (RLS + FORCE RLS, sin policies ni grants para anon/authenticated/service_role);
-- solo las funciones SECURITY DEFINER (search_path fijo, propietario postgres, EXECUTE solo service_role) las tocan.
-- La evidencia son ENLACES (http/https) y texto: no hay subida de archivos. El correo y la IP del reclamante nunca se usan como
-- clave de contador en claro: el backend envía digests HMAC (ip, red /24-/48 y correo) y la base nunca ve una IP.
-- Los moderadores se verifican bajo lock con admin_roles (moderator, developer o admin), igual que el resto de RPC de moderación.
-- Rollback (solo local/operador): supabase/rollbacks/20261107120000_copyright_claims.rollback.sql

-- 1. Texto de usuario: longitud tras recortar y sin caracteres de control (salvo tabulador y saltos de línea) ------------------
create function public.copyright_text_ok(p_text text, p_min integer, p_max integer)
returns boolean language sql immutable set search_path = pg_catalog, public as $$
  select p_text is not null
     and char_length(btrim(p_text)) between p_min and p_max
     and p_text !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
$$;

create function public.copyright_urls_ok(p_urls text[])
returns boolean language sql immutable set search_path = pg_catalog, public as $$
  select p_urls is not null
     and cardinality(p_urls) between 1 and 5
     and not exists (
       select 1 from unnest(p_urls) u
        where u is null or char_length(u) not between 8 and 500 or u !~ '^https?://[^[:space:]]+$'
           or u ~ '[\x01-\x1f\x7f]')
$$;
alter function public.copyright_text_ok(text, integer, integer) owner to postgres;
alter function public.copyright_urls_ok(text[]) owner to postgres;
revoke execute on function public.copyright_text_ok(text, integer, integer) from public, anon, authenticated, service_role;
revoke execute on function public.copyright_urls_ok(text[]) from public, anon, authenticated, service_role;

-- 2. Expediente ------------------------------------------------------------------------------------------------------------
create sequence public.copyright_claim_ref_seq as bigint minvalue 1 maxvalue 999999 no cycle;
revoke all on sequence public.copyright_claim_ref_seq from public, anon, authenticated, service_role;

create table public.copyright_claims (
  id                       uuid primary key default gen_random_uuid(),
  reference                text not null unique check (reference ~ '^CPY-[0-9]{4}-[0-9]{6}$'),
  status                   text not null default 'received'
    check (status in ('received', 'in_review', 'needs_info', 'dismissed', 'withdrawn')),
  version                  integer not null default 1 check (version >= 1),
  claimant_name            text not null check (public.copyright_text_ok(claimant_name, 2, 120)),
  claimant_email           text not null check (char_length(claimant_email) between 3 and 254
    and claimant_email = lower(btrim(claimant_email))
    and claimant_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  claimant_organization    text check (claimant_organization is null or public.copyright_text_ok(claimant_organization, 1, 120)),
  relationship             text not null check (relationship in ('owner', 'authorized_representative')),
  work_description         text not null check (public.copyright_text_ok(work_description, 10, 2000)),
  infringement_description text not null check (public.copyright_text_ok(infringement_description, 10, 2000)),
  evidence_urls            text[] not null check (public.copyright_urls_ok(evidence_urls)),
  claimed_post_url         text not null check (char_length(claimed_post_url) between 1 and 500
    and claimed_post_url !~ '[\x01-\x1f\x7f]'),
  -- Sin FK (como los reportes): el expediente sobrevive al borrado de la publicación.
  post_id                  uuid,
  post_found               boolean not null default false,
  post_author_user_id      uuid,
  post_text_snapshot       text check (post_text_snapshot is null or char_length(post_text_snapshot) <= 2000),
  post_media_count         integer check (post_media_count is null or post_media_count >= 0),
  statement_version        text not null check (statement_version ~ '^[a-z0-9._-]{1,20}$'),
  statements_accepted      boolean not null check (statements_accepted),
  signature                text not null check (public.copyright_text_ok(signature, 2, 120)),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (post_found = (post_id is not null)),
  check (post_found or (post_author_user_id is null and post_text_snapshot is null and post_media_count is null))
);
create index copyright_claims_status_created_idx on public.copyright_claims (status, created_at, id);
alter table public.copyright_claims enable row level security;
alter table public.copyright_claims force row level security;
revoke all on table public.copyright_claims from public, anon, authenticated, service_role;
comment on table public.copyright_claims is
  'Reclamaciones de copyright (fase 2A). Circuito separado de los reportes ordinarios. Privada: sin acceso para ningún rol de API; solo las funciones SECURITY DEFINER. post_id sin FK.';

create table public.copyright_claim_events (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references public.copyright_claims (id),
  kind          text not null check (kind in
    ('received', 'review_started', 'info_requested', 'review_resumed', 'note', 'dismissed', 'withdrawn')),
  actor_kind    text not null check (actor_kind in ('claimant', 'human')),
  actor_user_id uuid,
  from_status   text,
  to_status     text,
  note          text check (note is null or public.copyright_text_ok(note, 1, 1000)),
  created_at    timestamptz not null default now(),
  check ((actor_kind = 'human') = (actor_user_id is not null))
);
create index copyright_claim_events_claim_idx on public.copyright_claim_events (claim_id, created_at, id);
alter table public.copyright_claim_events enable row level security;
alter table public.copyright_claim_events force row level security;
revoke all on table public.copyright_claim_events from public, anon, authenticated, service_role;

create function public.copyright_claim_events_immutable()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  raise exception 'copyright_claim_events_immutable' using errcode = '23001';
end;
$$;
create trigger copyright_claim_events_no_update_delete
  before update or delete on public.copyright_claim_events
  for each row execute function public.copyright_claim_events_immutable();
create trigger copyright_claim_events_no_truncate
  before truncate on public.copyright_claim_events
  for each statement execute function public.copyright_claim_events_immutable();

-- 3. Límites del canal público -----------------------------------------------------------------------------------------------
create table public.copyright_claim_limits (
  scope        text        not null check (scope in ('ip_hour', 'ip_day', 'net_hour', 'email_day')),
  key_digest   text        not null check (key_digest ~ '^[0-9a-f]{64}$' or key_digest = 'unknown'),
  window_start timestamptz not null,
  hits         integer     not null default 0 check (hits >= 0),
  primary key (scope, key_digest, window_start)
);
create index copyright_claim_limits_window_idx on public.copyright_claim_limits (window_start);
alter table public.copyright_claim_limits enable row level security;
alter table public.copyright_claim_limits force row level security;
revoke all on table public.copyright_claim_limits from public, anon, authenticated, service_role;
comment on table public.copyright_claim_limits is
  'Contadores de abuso de copyright_claim_create por ventana fija. Solo digests HMAC (nunca IP ni correo en claro). Privada; se purga sola (>3 días).';

create function public.copyright_claim_hit_(
  p_scope text, p_digest text, p_len interval, p_limit integer, p_now timestamptz
) returns integer
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_start timestamptz := date_bin(p_len, p_now, timestamptz '2000-01-01 00:00:00+00');
  v_hits integer;
begin
  insert into public.copyright_claim_limits as l (scope, key_digest, window_start, hits)
    values (p_scope, p_digest, v_start, 1)
    on conflict (scope, key_digest, window_start)
    do update set hits = least(l.hits + 1, 1000000)
    returning l.hits into v_hits;
  if v_hits > p_limit then
    return greatest(1, ceil(extract(epoch from (v_start + p_len - p_now)))::integer);
  end if;
  return 0;
end;
$$;
alter function public.copyright_claim_hit_(text, text, interval, integer, timestamptz) owner to postgres;
revoke execute on function public.copyright_claim_hit_(text, text, interval, integer, timestamptz)
  from public, anon, authenticated, service_role;

-- 4. Historial unificado: el MISMO moderation_audit_log, con acciones y tipo de objetivo nuevos --------------------------------
-- (moderation_audit_log_actor_check y moderation_audit_log_system_action_check no cambian: estas acciones son siempre humanas.)
alter table public.moderation_audit_log
  drop constraint moderation_audit_log_action_check,
  drop constraint moderation_audit_log_target_type_check;
alter table public.moderation_audit_log
  add constraint moderation_audit_log_action_check check (action in (
    'report_status_changed', 'post_hidden', 'post_restored', 'post_quarantined', 'case_rejected',
    'content_actioned', 'strike_applied', 'strike_revoked', 'post_purged',
    'copyright_claim_review_started', 'copyright_claim_info_requested', 'copyright_claim_review_resumed',
    'copyright_claim_note_added', 'copyright_claim_dismissed', 'copyright_claim_withdrawn')),
  add constraint moderation_audit_log_target_type_check check (target_type in (
    'community_post_report', 'community_post', 'community_moderation_case', 'community_user_strike',
    'copyright_claim'));

-- 5a. Creación (backend público). p_ip, p_net y p_email_key son digests HMAC de 64 hex (o 'unknown' para la IP y la red). -------
create function public.copyright_claim_create(p_ip text, p_net text, p_email_key text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_keys constant text[] := array['claimantName', 'claimantEmail', 'organization', 'relationship', 'workDescription',
    'infringementDescription', 'evidenceUrls', 'postUrl', 'postId', 'signature', 'statementVersion', 'statementsAccepted'];
  v_name text; v_email text; v_org text; v_rel text; v_work text; v_infr text; v_url text; v_sig text; v_ver text;
  v_urls text[]; v_post_id uuid;
  v_post_found boolean := false; v_author uuid; v_text text; v_media integer;
  v_retry integer; v_claim public.copyright_claims%rowtype; v_ref text;
begin
  if p_ip is null or p_net is null or p_email_key is null or p_input is null
     or (p_ip <> 'unknown' and p_ip !~ '^[0-9a-f]{64}$')
     or (p_net <> 'unknown' and p_net !~ '^[0-9a-f]{64}$')
     or p_email_key !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_argument';
  end if;
  if jsonb_typeof(p_input) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_input) k where k <> all (v_keys)) then
    raise exception 'invalid_input';
  end if;
  if jsonb_typeof(p_input->'claimantName') is distinct from 'string'
     or jsonb_typeof(p_input->'claimantEmail') is distinct from 'string'
     or jsonb_typeof(p_input->'relationship') is distinct from 'string'
     or jsonb_typeof(p_input->'workDescription') is distinct from 'string'
     or jsonb_typeof(p_input->'infringementDescription') is distinct from 'string'
     or jsonb_typeof(p_input->'evidenceUrls') is distinct from 'array'
     or jsonb_typeof(p_input->'postUrl') is distinct from 'string'
     or jsonb_typeof(p_input->'signature') is distinct from 'string'
     or jsonb_typeof(p_input->'statementVersion') is distinct from 'string'
     or p_input->'statementsAccepted' is distinct from 'true'::jsonb
     or (p_input ? 'organization' and jsonb_typeof(p_input->'organization') not in ('string', 'null'))
     or (p_input ? 'postId' and jsonb_typeof(p_input->'postId') not in ('string', 'null')) then
    raise exception 'invalid_input';
  end if;
  v_name := btrim(p_input->>'claimantName');
  v_email := lower(btrim(p_input->>'claimantEmail'));
  v_org := nullif(btrim(coalesce(p_input->>'organization', '')), '');
  v_rel := p_input->>'relationship';
  v_work := btrim(p_input->>'workDescription');
  v_infr := btrim(p_input->>'infringementDescription');
  v_url := btrim(p_input->>'postUrl');
  v_sig := btrim(p_input->>'signature');
  v_ver := p_input->>'statementVersion';
  if jsonb_array_length(p_input->'evidenceUrls') not between 1 and 5
     or exists (select 1 from jsonb_array_elements(p_input->'evidenceUrls') e where jsonb_typeof(e) <> 'string') then
    raise exception 'invalid_input';
  end if;
  select array_agg(btrim(e #>> '{}') order by o) into v_urls
    from jsonb_array_elements(p_input->'evidenceUrls') with ordinality as t(e, o);
  if p_input->>'postId' is not null then
    if p_input->>'postId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_input';
    end if;
    v_post_id := (p_input->>'postId')::uuid;
  end if;
  if v_rel not in ('owner', 'authorized_representative')
     or not public.copyright_text_ok(v_name, 2, 120)
     or char_length(v_email) not between 3 and 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (v_org is not null and not public.copyright_text_ok(v_org, 1, 120))
     or not public.copyright_text_ok(v_work, 10, 2000)
     or not public.copyright_text_ok(v_infr, 10, 2000)
     or not public.copyright_urls_ok(v_urls)
     or char_length(v_url) not between 1 and 500 or v_url ~ '[\x01-\x1f\x7f]'
     or not public.copyright_text_ok(v_sig, 2, 120)
     or v_ver !~ '^[a-z0-9._-]{1,20}$' then
    raise exception 'invalid_input';
  end if;

  -- Retención de contadores caducados (>3 días), en lotes pequeños.
  delete from public.copyright_claim_limits l
   where l.ctid in (select x.ctid from public.copyright_claim_limits x
                     where x.window_start < v_now - interval '3 days' limit 100);
  -- Límites por capas (orden fijo): IP/hora, IP/día, red/hora y correo/día. Solo cuentan envíos válidos.
  v_retry := public.copyright_claim_hit_('ip_hour', p_ip, interval '1 hour', 4, v_now);
  if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;
  v_retry := public.copyright_claim_hit_('ip_day', p_ip, interval '1 day', 10, v_now);
  if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;
  if p_net <> 'unknown' then
    v_retry := public.copyright_claim_hit_('net_hour', p_net, interval '1 hour', 20, v_now);
    if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;
  end if;
  v_retry := public.copyright_claim_hit_('email_day', p_email_key, interval '1 day', 5, v_now);
  if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;

  -- Copia congelada del material reclamado (si la publicación existe): borrarla después no destruye la evidencia.
  if v_post_id is not null then
    select p.author_user_id, left(p.text, 2000) into v_author, v_text
      from public.community_posts p where p.id = v_post_id;
    if found then
      v_post_found := true;
      select count(*)::integer into v_media from public.community_post_media m where m.post_id = v_post_id;
    else
      v_author := null; v_text := null; v_media := null;
    end if;
  end if;

  v_ref := 'CPY-' || to_char(v_now at time zone 'UTC', 'YYYY') || '-' || lpad(nextval('public.copyright_claim_ref_seq')::text, 6, '0');
  insert into public.copyright_claims
    (reference, claimant_name, claimant_email, claimant_organization, relationship, work_description,
     infringement_description, evidence_urls, claimed_post_url, post_id, post_found, post_author_user_id,
     post_text_snapshot, post_media_count, statement_version, statements_accepted, signature, created_at, updated_at)
    values (v_ref, v_name, v_email, v_org, v_rel, v_work, v_infr, v_urls, v_url,
      case when v_post_found then v_post_id end, v_post_found, v_author, v_text, v_media, v_ver, true, v_sig, v_now, v_now)
    returning * into v_claim;
  insert into public.copyright_claim_events (claim_id, kind, actor_kind, to_status, created_at)
    values (v_claim.id, 'received', 'claimant', 'received', v_now);
  return jsonb_build_object('status', 'received', 'reference', v_claim.reference);
end;
$$;
alter function public.copyright_claim_create(text, text, text, jsonb) owner to postgres;
revoke execute on function public.copyright_claim_create(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.copyright_claim_create(text, text, text, jsonb) to service_role;

-- 5b. Lectura para moderación: cola (open = más antiguas primero; closed = más recientes primero) y detalle. --------------------
create function public.copyright_claims_read(
  p_actor_user_id uuid, p_scope text default 'open',
  p_before_created timestamptz default null, p_before_id uuid default null,
  p_claim_id uuid default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_items jsonb; v_count integer; v_next jsonb := null;
  c_page constant integer := 25;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is not null then
    select * into v_claim from public.copyright_claims where id = p_claim_id;
    if not found then raise exception 'claim_not_found'; end if;
    return jsonb_build_object('item', jsonb_build_object(
      'id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status, 'version', v_claim.version,
      'claimantName', v_claim.claimant_name, 'claimantEmail', v_claim.claimant_email,
      'organization', v_claim.claimant_organization, 'relationship', v_claim.relationship,
      'workDescription', v_claim.work_description, 'infringementDescription', v_claim.infringement_description,
      'evidenceUrls', to_jsonb(v_claim.evidence_urls), 'claimedPostUrl', v_claim.claimed_post_url,
      'postId', v_claim.post_id, 'postFound', v_claim.post_found,
      'postTextSnapshot', v_claim.post_text_snapshot, 'postMediaCount', v_claim.post_media_count,
      'currentPostStatus', (select p.status from public.community_posts p where p.id = v_claim.post_id),
      'statementVersion', v_claim.statement_version, 'signature', v_claim.signature,
      'createdAt', v_claim.created_at, 'updatedAt', v_claim.updated_at,
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
               where status in ('received', 'in_review', 'needs_info')
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
               where status in ('dismissed', 'withdrawn')
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

-- 5c. Revisión humana. Solo cambia estado de la RECLAMACIÓN (nunca la publicación). Una fila bloqueada + versión esperada. ------
create function public.copyright_claim_review(
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
  if v_claim.status in ('dismissed', 'withdrawn') then raise exception 'invalid_transition'; end if;
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
