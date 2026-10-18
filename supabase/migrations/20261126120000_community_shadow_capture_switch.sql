-- F4-F: interruptor REVERSIBLE de la captura shadow. Forward-only; LOCAL, NO aplicada en ningún entorno.
--
-- Qué hace: con `enabled = false`, community_shadow_private.capture() sigue obsoletando y borrando la copia de texto de los jobs
-- anteriores cuando el contenido cambia, pero NO crea jobs nuevos ni snapshot_text. Los triggers, el resto de tablas y todas las
-- funciones de Community quedan igual (capture ya tolera cualquier fallo y nunca cancela la transacción de la publicación).
-- Esta migración deja la captura APAGADA (estado de suspensión sin IA). Reactivar: `update public.community_shadow_capture_control
-- set enabled = true;` (SQL de administrador; la API no puede cambiarlo). Después puede ejecutarse `select public.community_shadow_reconcile(100);`
-- para capturar el contenido vigente de las últimas 24 h. Cuerpo copiado de 20261122120000 con UN solo bloque añadido.

create table public.community_shadow_capture_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null
);
insert into public.community_shadow_capture_control (singleton, enabled) values (true, false);
alter table public.community_shadow_capture_control enable row level security;
alter table public.community_shadow_capture_control force row level security;
revoke all on table public.community_shadow_capture_control from public, anon, authenticated, service_role;

create or replace function community_shadow_private.capture(k text, target uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public set lock_timeout = '100ms' as $$
declare s jsonb; inserted integer;
begin
  -- Capture failures roll back only this block. Parent content failures are never swallowed here.
  -- Serialize only shadow capture for this target, without waiting on another capture's UNIQUE insertion.
  if not pg_try_advisory_xact_lock(hashtextextended('upmina.community_shadow:' || k || ':' || target::text,0)) then
    return false;
  end if;
  s := community_shadow_private.current_snapshot(k,target);
  -- NOWAIT is deliberate: lock_timeout alone can lose to a shorter parent statement_timeout.
  with locked as materialized (select j.id from public.community_shadow_jobs j
    where j.target_kind = k and coalesce(j.edit_id,j.post_id) = target and j.obsolete_at is null
      and (s is null or j.version <> (s->>'version')::integer or j.snapshot_hash <> s->>'hash') for update nowait)
  update public.community_shadow_jobs j set obsolete_at = clock_timestamp(),
    obsolete_reason = case when k = 'pending_edit' and s is null and not exists
      (select 1 from public.community_post_pending_edits e where e.id=target and e.status='pending')
      then 'edit_closed' else 'version_changed' end,
    state = case when state in ('queued','processing','retry_wait') then 'cancelled' else state end,
    snapshot_text = null, lease_until = null, claim_token = null, updated_at = clock_timestamp()
    from locked where j.id = locked.id;
  -- SUSPENSIÓN: con el interruptor apagado solo se obsoletan/borran las copias antiguas (arriba); no se crea ningún job ni snapshot_text.
  if not coalesce((select c.enabled from public.community_shadow_capture_control c where c.singleton), true) then
    return false;
  end if;
  if s is null or (s->>'expires')::timestamptz <= clock_timestamp() then return false; end if;
  if exists (select 1 from public.community_shadow_jobs j where j.environment='dev' and j.target_kind=k
    and j.post_id=(s->>'post_id')::uuid and j.edit_id is not distinct from (s->>'edit_id')::uuid
    and j.version=(s->>'version')::integer and j.snapshot_hash=s->>'hash' and j.config_revision='shadow-v1') then
    return false;
  end if;
  insert into public.community_shadow_jobs(target_kind, post_id, edit_id, author_user_id, version, base_version,
    snapshot_text, assets, snapshot_hash, snapshot_expires_at)
    values (k,(s->>'post_id')::uuid,(s->>'edit_id')::uuid,(s->>'author')::uuid,(s->>'version')::integer,
      case when k = 'pending_edit' then (s->>'version')::integer end,s->>'text',s->'assets',s->>'hash',
      (s->>'expires')::timestamptz) on conflict do nothing;
  get diagnostics inserted = row_count;
  return inserted = 1;
exception when others then
  -- No SQLERRM, content, object keys or identifiers. Server log only; no human audit mutation.
  raise warning 'community_shadow_capture_failed sqlstate=%', sqlstate;
  return false;
end $$;
