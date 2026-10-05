-- Fase 9K-1 — Moderation Foundation. Migración NUEVA: no edita ninguna migración ya aplicada.
--
-- Investigación previa (ver el checkpoint 9K-1 completo):
--   - Roles ya existentes: admin/moderator/developer (admin_roles, admin-auth.ts). La capacidad
--     `moderation` YA está asignada a moderator/developer/admin en ROLE_CAPABILITIES — no se toca
--     admin_auth.ts ni se inventa un rol nuevo.
--   - community_posts.status YA admite 'hidden' desde 20261004120000_community_posts_media.sql,
--     reservado explícitamente para una futura moderación — esta migración NO lo usa todavía (9K-1
--     no implementa ocultar/restaurar, ver el checkpoint: "NO implementar todavía todas las
--     acciones destructivas"). Ese es el gap principal que 9K-2 cubrirá reutilizando esta columna.
--   - No existía ninguna tabla de reportes, moderación ni audit log de moderación: esta migración
--     los crea desde cero, reutilizando el patrón YA establecido por
--     cosplay_admin_audit_log/cosplay_admin_delete_post (RLS forzado sin policies, mutación
--     exclusiva vía RPC SECURITY DEFINER que re-verifica rol bajo lock, auditoría append-only e
--     inmutable, sin FK en las tablas que deben sobrevivir al borrado de su referente).
--
-- Alcance deliberadamente mínimo (foundation, no el sistema completo de moderación):
--   1. community_post_reports: modelo de un reporte sobre una publicación de Community.
--   2. moderation_audit_log: auditoría append-only e inmutable de acciones de moderación.
--   3. community_post_report_create: cualquier usuario autenticado reporta una publicación.
--   4. community_post_report_set_status: SOLO admin/moderator/developer cambia el estado de un
--      reporte (open → reviewing/resolved/dismissed). Audita cada transición.
--
-- Explícitamente FUERA de alcance de 9K-1 (ver el checkpoint): ocultar/restaurar publicaciones,
-- sancionar/suspender/banear usuarios, IA/clasificación automática, apelaciones. Esta migración no
-- las implementa ni las bloquea: solo deja el modelo de reportes y la auditoría listos para que
-- 9K-2+ las construya encima.

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1. community_post_reports: un reporte de un usuario sobre UNA publicación de Community.

-- SIN FK a community_posts/auth.users a propósito (mismo motivo que cosplay_admin_audit_log):
-- un reporte debe seguir siendo legible por moderación aunque la publicación se borre (borrado
-- DURO, ver community_post_delete) o la cuenta del reportante/reportado desaparezca después.
create table public.community_post_reports (
  id                 uuid primary key default gen_random_uuid(),
  reporter_user_id   uuid not null,
  post_id            uuid not null,
  reason             text not null,
  detail             text,
  status             text not null default 'open',
  resolved_by        uuid,
  resolution_note    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint community_post_reports_reason_check
    check (reason in ('spam', 'harassment', 'hate_speech', 'sexual_content', 'other')),
  constraint community_post_reports_status_check
    check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  constraint community_post_reports_detail_length
    check (detail is null or char_length(detail) <= 1000),
  constraint community_post_reports_resolution_note_length
    check (resolution_note is null or char_length(resolution_note) <= 1000),
  -- Coherencia mínima: un reporte resuelto/descartado sabe quién lo dejó en ese estado; uno
  -- todavía abierto o en revisión no debería cargar un resolutor todavía.
  constraint community_post_reports_resolution_consistency
    check (
      (status in ('resolved', 'dismissed') and resolved_by is not null)
      or (status in ('open', 'reviewing') and resolved_by is null)
    )
);

comment on table public.community_post_reports is
  'Reportes de usuarios sobre publicaciones de Community (Fase 9K-1). Sin FK: sobrevive al borrado duro de la publicación y a la desaparición de las cuentas involucradas. Mutación exclusiva vía community_post_report_create/community_post_report_set_status. Acceso exclusivo server-side (service_role vía requireCapability "moderation"); sin policy pública.';
comment on column public.community_post_reports.reporter_user_id is
  'Autor del reporte, verificado por JWT (requireAuthenticated) en community_post_report_create. Sin FK.';
comment on column public.community_post_reports.post_id is
  'Publicación reportada. Sin FK: sigue siendo legible aunque la publicación ya no exista (community_post_report_create solo exige que exista EN EL MOMENTO de reportar).';
comment on column public.community_post_reports.reason is
  'Categoría cerrada elegida por quien reporta. Lista fija: spam, harassment, hate_speech, sexual_content, other.';
comment on column public.community_post_reports.detail is
  'Explicación opcional en texto libre de quien reporta. Máximo 1000 caracteres.';
comment on column public.community_post_reports.status is
  'Ciclo de vida: open (recién creado) -> reviewing (un moderador lo tomó) -> resolved | dismissed. Solo lo cambia community_post_report_set_status.';
comment on column public.community_post_reports.resolved_by is
  'user_id de quien dejó el reporte en resolved/dismissed (re-verificado admin/moderator/developer dentro de la RPC). Sin FK. NULL mientras el reporte siga open/reviewing.';
comment on column public.community_post_reports.resolution_note is
  'Nota opcional de moderación al cambiar el estado (nunca visible para el usuario reportante ni el autor del post). Máximo 1000 caracteres.';

alter table public.community_post_reports enable row level security;
alter table public.community_post_reports force row level security;

revoke all on table public.community_post_reports from public;
revoke all on table public.community_post_reports from anon;
revoke all on table public.community_post_reports from authenticated;
grant select on table public.community_post_reports to service_role;

-- Lectura eficiente de la cola de moderación (más recientes primero) y de los reportes de una
-- publicación concreta.
create index community_post_reports_status_created_at_idx
  on public.community_post_reports (status, created_at desc, id desc);
create index community_post_reports_post_id_idx
  on public.community_post_reports (post_id);

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2. moderation_audit_log: auditoría append-only e inmutable de acciones de moderación.
-- Genérica por target_type/target_id (no solo reportes) para que las próximas fases de 9K
-- (ocultar publicación, sancionar usuario, etc.) reutilicen esta misma tabla añadiendo un nuevo
-- valor a moderation_audit_log_action_check, sin crear una tabla de auditoría por acción.
-- Mismo patrón exacto que cosplay_admin_audit_log: sin FK, inmutable vía trigger, sin acceso
-- directo para ningún rol de API (solo las RPC SECURITY DEFINER escriben).
create table public.moderation_audit_log (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid not null,
  target_type     text not null,
  target_id       uuid not null,
  action          text not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  constraint moderation_audit_log_target_type_check
    check (target_type in ('community_post_report')),
  constraint moderation_audit_log_action_check
    check (action in ('report_status_changed'))
);

comment on table public.moderation_audit_log is
  'Historial append-only de acciones de moderación (Fase 9K-1: solo cambios de estado de reportes). Sin FK: sobrevive al borrado del recurso auditado y a la desaparición de la cuenta del actor. Solo escriben las RPC SECURITY DEFINER de esta migración. Sin acceso directo para ningún rol de API.';
comment on column public.moderation_audit_log.actor_user_id is
  'Moderador/admin/developer que realizó la acción (verificado por requireCapability "moderation" + reconfirmado bajo lock en la RPC). Sin FK.';
comment on column public.moderation_audit_log.target_type is
  'Tipo de recurso afectado. Lista cerrada, ampliable en migraciones futuras según lo que 9K realmente construya.';
comment on column public.moderation_audit_log.target_id is
  'id del recurso afectado (p. ej. community_post_reports.id). Sin FK: sigue siendo legible aunque el recurso ya no exista.';
comment on column public.moderation_audit_log.metadata is
  'Metadata MÍNIMA de la transición (p. ej. from_status/to_status). Nunca URLs, claves de storage, tokens, ni el detail/resolution_note completos del reporte.';

alter table public.moderation_audit_log enable row level security;
alter table public.moderation_audit_log force row level security;

create or replace function public.moderation_audit_log_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'moderation_audit_log_immutable' using errcode = '23001';
end;
$$;

create trigger moderation_audit_log_no_update_delete
  before update or delete on public.moderation_audit_log
  for each row execute function public.moderation_audit_log_immutable();

create trigger moderation_audit_log_no_truncate
  before truncate on public.moderation_audit_log
  for each statement execute function public.moderation_audit_log_immutable();

revoke all privileges on table public.moderation_audit_log from public;
revoke all privileges on table public.moderation_audit_log from anon;
revoke all privileges on table public.moderation_audit_log from authenticated;
revoke all privileges on table public.moderation_audit_log from service_role;

revoke all on function public.moderation_audit_log_immutable()
  from public, anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 3. community_post_report_create: cualquier usuario AUTENTICADO reporta una publicación.
-- Sin requisito de rol/capacidad (requireAuthenticated en TypeScript, nunca requireCapability):
-- reportar contenido es una acción de usuario normal, no una acción de moderación. La RPC solo
-- exige que la publicación exista EN ESTE MOMENTO; no exige que esté 'published' (una publicación
-- ya 'hidden' por una moderación futura debería poder seguir acumulando reportes/contexto).
create or replace function public.community_post_report_create(
  p_reporter_user_id uuid,
  p_post_id uuid,
  p_reason text,
  p_detail text
)
returns table (id uuid, status text, created_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_detail text;
begin
  if p_reporter_user_id is null or p_post_id is null or p_reason is null then
    raise exception 'invalid_argument';
  end if;
  if p_reason not in ('spam', 'harassment', 'hate_speech', 'sexual_content', 'other') then
    raise exception 'invalid_reason';
  end if;

  -- `community_posts.id` está calificado a propósito: RETURNS TABLE(id uuid, ...) crea una
  -- variable OUT llamada `id` visible en todo el cuerpo de la función, que un `id` sin calificar
  -- referenciaría de forma ambigua frente a la columna real de la tabla.
  if not exists (select 1 from public.community_posts where community_posts.id = p_post_id) then
    raise exception 'post_not_found';
  end if;

  v_detail := nullif(btrim(p_detail), '');
  if v_detail is not null and char_length(v_detail) > 1000 then
    raise exception 'detail_too_long';
  end if;

  return query
    insert into public.community_post_reports
      (reporter_user_id, post_id, reason, detail, status, created_at, updated_at)
    values
      (p_reporter_user_id, p_post_id, p_reason, v_detail, 'open', clock_timestamp(), clock_timestamp())
    returning community_post_reports.id, community_post_reports.status, community_post_reports.created_at;
end;
$$;

comment on function public.community_post_report_create(uuid, uuid, text, text) is
  'Crea un reporte "open" sobre una publicación de Community. Exige que la publicación exista en este momento (no que siga published). SOLO service_role (EXECUTE) — el llamador ya verificó requireAuthenticated en TypeScript.';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 4. community_post_report_set_status: SOLO admin/moderator/developer cambia el estado de un
-- reporte. Re-verifica el rol del actor DENTRO de la función (nunca confía en que
-- requireCapability ya lo comprobó en TypeScript), mismo patrón que cosplay_admin_delete_post.
create or replace function public.community_post_report_set_status(
  p_actor_user_id uuid,
  p_report_id uuid,
  p_status text,
  p_note text
)
returns table (id uuid, status text, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current_status text;
  v_note text;
begin
  if p_actor_user_id is null or p_report_id is null or p_status is null then
    raise exception 'invalid_argument';
  end if;
  if p_status not in ('open', 'reviewing', 'resolved', 'dismissed') then
    raise exception 'invalid_status';
  end if;
  if not exists (
    select 1 from public.admin_roles
      where user_id = p_actor_user_id and role in ('admin', 'moderator', 'developer')
  ) then
    raise exception 'actor_not_moderator';
  end if;

  v_note := nullif(btrim(p_note), '');
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'note_too_long';
  end if;

  select community_post_reports.status into v_current_status
    from public.community_post_reports where community_post_reports.id = p_report_id for update;
  if not found then
    raise exception 'report_not_found';
  end if;

  update public.community_post_reports set
    status = p_status,
    resolved_by = case when p_status in ('resolved', 'dismissed') then p_actor_user_id else null end,
    resolution_note = case when p_status in ('resolved', 'dismissed') then v_note else null end,
    updated_at = clock_timestamp()
  where community_post_reports.id = p_report_id;

  insert into public.moderation_audit_log (actor_user_id, target_type, target_id, action, metadata, created_at)
    values (p_actor_user_id, 'community_post_report', p_report_id, 'report_status_changed',
            jsonb_build_object('from_status', v_current_status, 'to_status', p_status),
            clock_timestamp());

  return query
    select community_post_reports.id, community_post_reports.status, community_post_reports.updated_at
      from public.community_post_reports where community_post_reports.id = p_report_id;
end;
$$;

comment on function public.community_post_report_set_status(uuid, uuid, text, text) is
  'Cambia el estado de un reporte (open/reviewing/resolved/dismissed). Re-verifica que el actor sea admin/moderator/developer bajo lock. Audita la transición en moderation_audit_log. SOLO service_role (EXECUTE) — el llamador ya verificó requireCapability("moderation") en TypeScript.';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 5. EXECUTE: solo service_role, nunca anon/authenticated (mismo patrón que el resto de RPC
-- privilegiadas del proyecto).

revoke all on function public.community_post_report_create(uuid, uuid, text, text)
  from public;
revoke execute on function public.community_post_report_create(uuid, uuid, text, text)
  from anon;
revoke execute on function public.community_post_report_create(uuid, uuid, text, text)
  from authenticated;
grant execute on function public.community_post_report_create(uuid, uuid, text, text)
  to service_role;

revoke all on function public.community_post_report_set_status(uuid, uuid, text, text)
  from public;
revoke execute on function public.community_post_report_set_status(uuid, uuid, text, text)
  from anon;
revoke execute on function public.community_post_report_set_status(uuid, uuid, text, text)
  from authenticated;
grant execute on function public.community_post_report_set_status(uuid, uuid, text, text)
  to service_role;
