-- 9K-R4-E3: scheduler of the community media purge lifecycle (pg_cron + pg_net + Vault).
--
-- WHAT THIS IS: one DB-side tick that only WAKES the existing components. It decides nothing about
-- keys, buckets, assets, leases or finalization:
--   1. community_purge_due_posts(50)  — logical purge of expired removed posts (R4-E1, DB-decided).
--   2. media_gc_backlog()             — is any 'deleting' asset eligible NOW?
--   3. only if so: ONE async POST /api/media/gc through pg_net, signed with the domain-separated
--      HMAC "UPMINA-MEDIA-GC-V1" (same canonical form as src/lib/media-delivery-protocol.ts).
-- The backend (R4-E2) claims by lease, derives keys from the DB and deletes physically; E1 owns
-- claim/finalize/fail/backoff. A failed HTTP wake-up changes NOTHING in media_assets: the next tick
-- simply tries again.
--
-- SECRETS / CONFIG ARE NOT IN THIS FILE. They are operator steps (per environment), stored in
-- Supabase Vault and read at run time only inside the SECURITY DEFINER function:
--   vault secret 'media_gc_shared_secret' = the SAME value as MEDIA_GC_SHARED_SECRET of the backend
--   vault secret 'media_gc_endpoint_url'  = https://<backend-host>/api/media/gc
-- Without both, the tick still runs the logical purge and skips the HTTP wake-up (fail closed).
--
-- Forward-only: R4-E1's 20261020120000 is untouched.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.community_media_purge_tick()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  c_endpoint_path constant text := '/api/media/gc';
  v_purge jsonb := null;
  v_purge_failed boolean := false;
  v_backlog jsonb;
  v_eligible integer;
  v_secret text;
  v_url text;
  v_ts text;
  v_sig text;
  v_request_id bigint;
begin
  -- One tick at a time (pg_cron already does not start a job that is still running; this also
  -- covers a manual run). Transaction-level: released automatically, never leaks.
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

  -- 2. wake the physical GC only when something is eligible right now.
  v_backlog := public.media_gc_backlog();
  v_eligible := coalesce((v_backlog ->> 'eligibleNow')::integer, 0);
  if v_eligible = 0 then
    return jsonb_build_object('status', 'idle', 'purgeFailed', v_purge_failed, 'purge', v_purge,
      'eligible', 0);
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'media_gc_shared_secret' limit 1;
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'media_gc_endpoint_url' limit 1;
  if v_secret is null or length(v_secret) < 32 or v_url is null
     or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/api/media/gc$' then
    raise warning 'community_media_purge_tick: gc_not_configured';
    return jsonb_build_object('status', 'gc_not_configured', 'purgeFailed', v_purge_failed,
      'eligible', v_eligible);
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
    'purgeFailed', v_purge_failed, 'purge', v_purge, 'eligible', v_eligible);
end $$;

alter function public.community_media_purge_tick() owner to postgres;
revoke all on function public.community_media_purge_tick() from public, anon, authenticated, service_role;
grant execute on function public.community_media_purge_tick() to postgres;

-- Exactly ONE job. cron.schedule(name, ...) is an upsert by name, so re-applying is idempotent.
select cron.schedule(
  'community-media-purge-tick',
  '*/5 * * * *',
  $cron$select public.community_media_purge_tick();$cron$
);
