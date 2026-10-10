-- 9K-R7 · Detección automática de reservas de medios abandonadas (PROPUESTA — NO aplicada).
--
-- Reutiliza el cron EXISTENTE (`community-media-purge-tick`, cada 5 min): no crea jobs. La detección
-- solo MARCA `deleting`; el borrado físico (incluido el aborto de sesiones multipart con su
-- identificador intacto) sigue siendo del GC de 20261020/20261027. Se entrega DESACTIVADA:
-- aplicar esta migración no cambia ningún comportamiento hasta que una persona autorizada ponga
-- `media_abandon_policy.enabled = true`.
--
--   1. media_abandon_policy                 — fila única: enabled, min_age, batch_limit, protected_before
--                                             y métricas de la última ejecución. Solo `postgres`.
--   2. media_abandoned_reservations_mark()  — selecciona, revalida bajo lock y marca. ACL: solo postgres.
--   3. community_media_purge_tick()         — idéntico a 20261021 + paso «marcar abandonadas» aislado
--                                             (un fallo ahí NUNCA impide la purga lógica ni el wake-up del GC).
--
-- QUÉ ES «ABANDONADA». Estados pendientes (reserved, uploaded, verifying, processing) cuya última
-- actividad (`updated_at`, que el trigger media_assets_touch_activity renueva en CADA cambio de
-- estado) es anterior a `min_age` (24 h por defecto, mínimo duro 2 h). No existe heartbeat durante la
-- subida, pero NO hace falta: las URLs prefirmadas de subida caducan a los 15 min (PUT único) y a los
-- 30 min (partes multipart) desde la reserva y cada petición se valida al empezar, de modo que pasadas
-- 2 h ninguna subida legítima puede seguir escribiendo, y `uploaded/verifying/processing` ocurren dentro
-- de UNA petición de /api/media/complete (segundos). `ready` y `failed` NO se tocan aquí (un `ready` puede
-- estar esperando en un editor abierto y un `failed` admite reintento del usuario).
--
-- HISTÓRICOS. `protected_before` (por defecto y como suelo mínimo: 2026-10-09 23:00:00+00, posterior al
-- último asset existente en DEV) excluye en la PROPIA consulta todo asset creado antes de esa fecha. La
-- columna solo puede subirse (CHECK), nunca bajarse del suelo documentado.
--
-- Concurrencia: lock de fila de la política (serializa ejecuciones), FOR UPDATE SKIP LOCKED en la
-- selección, revalidación bajo lock de estado/antigüedad/corte, límite por lote. Idempotente.
-- `media_abandoned_sweep` (20261026) NO se toca ni se programa; sigue sin corte histórico: no ejecutarlo.
-- Producción: NO aplicar hasta que DEV Testing la haya validado.

-- ---------------------------------------------------------------------------------------------
-- 1. Política (fila única)
-- ---------------------------------------------------------------------------------------------
create table public.media_abandon_policy (
  singleton         boolean primary key default true check (singleton),
  enabled           boolean not null default false,
  min_age           interval not null default interval '24 hours'
    check (min_age >= interval '2 hours' and min_age <= interval '30 days'),
  batch_limit       integer not null default 20 check (batch_limit between 1 and 100),
  protected_before  timestamptz not null default timestamptz '2026-10-09 23:00:00+00'
    constraint media_abandon_policy_cutoff_floor
    check (protected_before >= timestamptz '2026-10-09 23:00:00+00'),
  last_run_at       timestamptz,
  last_candidates   integer,
  last_marked       integer,
  last_skipped      integer,
  last_duration_ms  integer,
  last_error_class  text check (last_error_class is null or last_error_class ~ '^[a-z0-9_]{1,40}$')
);
alter table public.media_abandon_policy enable row level security;
-- Sin policies para anon/authenticated/service_role; el propietario (postgres) la gestiona.
revoke all on public.media_abandon_policy from public, anon, authenticated, service_role;
insert into public.media_abandon_policy (singleton) values (true);

comment on table public.media_abandon_policy is
  'R7: política de detección de reservas abandonadas. enabled=false por defecto. Solo postgres.';

-- ---------------------------------------------------------------------------------------------
-- 2. Marcado
-- ---------------------------------------------------------------------------------------------
create function public.media_abandoned_reservations_mark(p_now timestamptz default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_pol public.media_abandon_policy%rowtype;
  v_t0 timestamptz := clock_timestamp();
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_age interval;
  v_cand record;
  v_a public.media_assets%rowtype;
  v_candidates integer := 0;
  v_marked integer := 0;
  v_skipped integer := 0;
  v_ms integer;
begin
  -- Lock de la fila de política: serializa ejecuciones concurrentes (el tick ya usa advisory lock).
  select * into v_pol from public.media_abandon_policy where singleton for update;
  if not found or not v_pol.enabled then
    return jsonb_build_object('status', 'disabled');
  end if;
  -- Defensa en profundidad además del CHECK de la tabla.
  v_age := greatest(v_pol.min_age, interval '2 hours');

  begin
    for v_cand in
      select a.id from public.media_assets a
       where a.status in ('reserved', 'uploaded', 'verifying', 'processing')
         and a.domain in ('community', 'cosplay')
         and a.created_at >= v_pol.protected_before          -- históricos: excluidos EN la consulta
         and a.created_at <= v_now - v_age
         and a.updated_at <= v_now - v_age
       order by a.updated_at, a.id
       limit v_pol.batch_limit
       for update skip locked
    loop
      v_candidates := v_candidates + 1;
      -- Revalidación bajo lock: el estado/actividad pudieron cambiar desde la selección.
      select * into v_a from public.media_assets where id = v_cand.id for update;
      if not found
        or v_a.status not in ('reserved', 'uploaded', 'verifying', 'processing')
        or v_a.created_at < v_pol.protected_before
        or v_a.created_at > v_now - v_age
        or v_a.updated_at > v_now - v_age then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      -- Solo cambia el estado: multipart_upload_id y private_original_key quedan intactos para que
      -- el GC aborte la sesión con el identificador exacto antes de finalizar.
      update public.media_assets set status = 'deleting', failure_code = null where id = v_a.id;
      v_marked := v_marked + 1;
    end loop;
  exception when others then
    v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::integer;
    update public.media_abandon_policy
       set last_run_at = clock_timestamp(), last_duration_ms = v_ms,
           last_error_class = 'mark_failed'
     where singleton;
    raise warning 'media_abandoned_reservations_mark: failed sqlstate=%', sqlstate;
    return jsonb_build_object('status', 'error', 'durationMs', v_ms);
  end;

  v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::integer;
  update public.media_abandon_policy
     set last_run_at = clock_timestamp(), last_candidates = v_candidates, last_marked = v_marked,
         last_skipped = v_skipped, last_duration_ms = v_ms, last_error_class = null
   where singleton;
  return jsonb_build_object('status', 'ran', 'candidates', v_candidates, 'marked', v_marked,
    'skipped', v_skipped, 'durationMs', v_ms, 'minAge', v_age::text, 'batchLimit', v_pol.batch_limit);
end;
$$;
alter function public.media_abandoned_reservations_mark(timestamptz) owner to postgres;
revoke all on function public.media_abandoned_reservations_mark(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.media_abandoned_reservations_mark(timestamptz) to postgres;

-- ---------------------------------------------------------------------------------------------
-- 3. Tick: IDÉNTICO a 20261021 salvo el paso 1b (marcar abandonadas) y el campo `abandoned`.
--    El paso 1b va ANTES de consultar el backlog para que lo marcado se despierte en el mismo tick.
-- ---------------------------------------------------------------------------------------------
create or replace function public.community_media_purge_tick()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  c_endpoint_path constant text := '/api/media/gc';
  v_purge jsonb := null;
  v_purge_failed boolean := false;
  v_abandoned jsonb := null;
  v_abandoned_failed boolean := false;
  v_backlog jsonb;
  v_eligible integer;
  v_secret text;
  v_url text;
  v_ts text;
  v_sig text;
  v_request_id bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('upmina.community_media_purge_tick', 0)) then
    return jsonb_build_object('status', 'skipped_overlap');
  end if;

  -- 1. logical purge (DB-decided). An error here must not stop the GC wake-up: report SQLSTATE only.
  begin
    v_purge := public.community_purge_due_posts(50);
  exception when others then
    v_purge_failed := true;
    raise warning 'community_media_purge_tick: purge_failed sqlstate=%', sqlstate;
  end;

  -- 1b. R7: mark abandoned reservations 'deleting' (no-op while media_abandon_policy.enabled = false).
  --     Isolated: a failure here changes nothing else and never blocks the GC wake-up.
  begin
    v_abandoned := public.media_abandoned_reservations_mark();
  exception when others then
    v_abandoned_failed := true;
    raise warning 'community_media_purge_tick: abandoned_mark_failed sqlstate=%', sqlstate;
  end;

  -- 2. wake the physical GC only when something is eligible right now.
  v_backlog := public.media_gc_backlog();
  v_eligible := coalesce((v_backlog ->> 'eligibleNow')::integer, 0);
  if v_eligible = 0 then
    return jsonb_build_object('status', 'idle', 'purgeFailed', v_purge_failed, 'purge', v_purge,
      'abandoned', v_abandoned, 'abandonedFailed', v_abandoned_failed, 'eligible', 0);
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'media_gc_shared_secret' limit 1;
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'media_gc_endpoint_url' limit 1;
  if v_secret is null or length(v_secret) < 32 or v_url is null
     or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/api/media/gc$' then
    raise warning 'community_media_purge_tick: gc_not_configured';
    return jsonb_build_object('status', 'gc_not_configured', 'purgeFailed', v_purge_failed,
      'abandoned', v_abandoned, 'abandonedFailed', v_abandoned_failed, 'eligible', v_eligible);
  end if;

  v_ts := floor(extract(epoch from clock_timestamp()))::bigint::text;
  v_sig := rtrim(translate(encode(extensions.hmac(
      convert_to('UPMINA-MEDIA-GC-V1' || chr(10) || 'POST' || chr(10) || c_endpoint_path
        || chr(10) || v_ts, 'UTF8'),
      convert_to(v_secret, 'UTF8'), 'sha256'), 'base64'), '+/', '-_'), '=');

  -- The request carries NOTHING chosen by the tick: no assets, keys, bucket or limit.
  v_request_id := net.http_post(
    url := v_url,
    headers := jsonb_build_object('x-media-timestamp', v_ts, 'x-media-signature', v_sig),
    timeout_milliseconds := 30000);

  return jsonb_build_object('status', 'gc_enqueued', 'requestId', v_request_id,
    'purgeFailed', v_purge_failed, 'purge', v_purge, 'abandoned', v_abandoned,
    'abandonedFailed', v_abandoned_failed, 'eligible', v_eligible);
end $$;
