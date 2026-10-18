-- PREFLIGHT de las 5 migraciones finales de Production (20261119, 20261120, 20261121, 20261127, 20261128). SOLO LECTURA.
-- Uso (psql del cliente instalado, con la conexión de Production en variables de entorno PG*; ver docs/PRODUCTION-MIGRATION-RUNBOOK.md):
--   psql -X -A -t -F '|' -c "set default_transaction_read_only = on" -f scripts/sql/production-migration-preflight.sql
-- Cada fila: check|OK/FAIL|detalle. CUALQUIER "FAIL" ⇒ DETENERSE y no aplicar nada.
-- Las huellas son md5(replace(prosrc, chr(13), '')) del cuerpo vigente con las migraciones hasta 20261118120000 (ensayo local PGlite).

set default_transaction_read_only = on;

with
expected_hashes(proname, args, h) as (values
  ('community_post_save', 'p_actor_user_id uuid, p_post_id uuid, p_expected_version integer, p_text text, p_media jsonb', 'e2132e2bef4960340ea81cda315ef414'),
  ('community_post_save_atomic', 'p_actor_user_id uuid, p_post_id uuid, p_expected_version integer, p_text text, p_media jsonb, p_removed_media_ids uuid[]', '90e7955778b622cad861d91db3ba4dec'),
  ('community_post_detach_media', 'p_actor_user_id uuid, p_post_id uuid, p_expected_version integer, p_media_id uuid', '56ef5e8f8bf39f14740bd8bee21291db'),
  ('community_post_reorder_media', 'p_actor_user_id uuid, p_post_id uuid, p_expected_version integer, p_positions jsonb', '83fe647a044363bb0b7da31ab704e07a'),
  ('community_media_delivery_state', 'p_asset_id uuid', '69310e1ce96db66181f3a875bd8ef8ac'),
  ('media_abandoned_sweep', 'p_ready_min_age interval, p_pending_min_age interval, p_failed_min_age interval, p_limit integer, p_include_cosplay_ready boolean', 'e3cd5cef3f773600a8270368a2dbd375'),
  ('community_media_asset_discard', 'p_asset_id uuid, p_actor_user_id uuid', 'c40c667c6956f0ad1252f9801e0f5dfa'),
  ('account_deletion_backlog', '', '13d790b03a8f76b26bb5f8b41464f0bb'),
  ('account_deletion_developer_retry', 'p_actor_user_id uuid, p_request_id uuid', '71aaf1adb212beca80b1d98e6534f636')
),
hist as (select version from supabase_migrations.schema_migrations)
select 'history_last_is_20261118120000', case when (select max(version) from hist) = '20261118120000' then 'OK' else 'FAIL' end, 'last=' || coalesce((select max(version) from hist), 'null')
union all select 'history_has_17_and_18', case when (select count(*) from hist where version in ('20261117120000','20261118120000')) = 2 then 'OK' else 'FAIL' end, ''
union all select 'history_has_deletion_foundation_runtime_media_username', case when (select count(*) from hist where version in ('20261113120000','20261114120000','20261115120000','20261116120000')) = 4 then 'OK' else 'FAIL' end, ''
union all select 'history_count_is_65', case when (select count(*) from hist) = 65 then 'OK' else 'FAIL' end, 'count=' || (select count(*) from hist)
union all select 'none_of_the_10_pending_applied', case when (select count(*) from hist where version >= '20261119120000') = 0 then 'OK' else 'FAIL' end, 'applied_after_18=' || (select count(*) from hist where version >= '20261119120000')
union all select 'new_objects_absent', case when to_regclass('public.account_deletion_completion_notices') is null and to_regclass('public.community_post_pending_edits') is null
    and (select count(*) from pg_proc where proname in ('account_deletion_notice_capture','account_deletion_notice_alerts','community_content_review_read','community_post_pending_edit_submit')) = 0 then 'OK' else 'FAIL' end, ''
union all select 'shadow_objects_absent', case when (select count(*) from pg_proc where proname like 'community_shadow%') = 0 and to_regclass('public.community_shadow_jobs') is null then 'OK' else 'FAIL' end, ''
union all select 'fn_hash_' || e.proname, case when p.oid is null then 'FAIL' when md5(replace(p.prosrc, chr(13), '')) = e.h then 'OK' else 'FAIL' end,
    coalesce(md5(replace(p.prosrc, chr(13), '')), 'missing')
  from expected_hashes e
  left join pg_proc p on p.proname = e.proname and p.pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(p.oid) = e.args
union all select 'community_posts_status_check_without_held', case when exists (select 1 from pg_constraint where conname = 'community_posts_status_check'
    and pg_get_constraintdef(oid) = 'CHECK ((status = ANY (ARRAY[''published''::text, ''hidden_pending_review''::text, ''hidden''::text, ''removed_pending_purge''::text])))') then 'OK' else 'FAIL' end, ''
union all select 'moderation_audit_log_action_check_without_content_actions', case when exists (select 1 from pg_constraint where conname = 'moderation_audit_log_action_check'
    and pg_get_constraintdef(oid) not like '%content_hold_released%') then 'OK' else 'FAIL' end, ''
union all select 'community_posts_by_status', 'INFO', coalesce((select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from public.community_posts group by status) s), 'none')
union all select 'text_only_posts_without_media', 'INFO', (select count(*)::text from public.community_posts p where not exists (select 1 from public.community_post_media m where m.post_id = p.id))
union all select 'row_counts', 'INFO', 'users=' || (select count(*) from auth.users) || ',profiles=' || (select count(*) from public.profiles) || ',posts=' || (select count(*) from public.community_posts) || ',assets=' || (select count(*) from public.media_assets) || ',admin_roles=' || (select count(*) from public.admin_roles)
union all select 'deletion_requests_by_status', 'INFO', coalesce((select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from public.account_deletion_requests group by status) s), 'none')
union all select 'no_active_deletion_jobs', case when (select count(*) from public.account_deletion_requests where status in ('access_blocked','cleanup_in_progress','cleanup_retry_pending','cleanup_manual_required')) = 0 then 'OK' else 'FAIL' end, 'revisar antes de migrar: hay eliminaciones en curso'
union all select 'tables_without_rls', case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) = 0 then 'OK' else 'FAIL' end, ''
union all select 'secdef_without_fixed_search_path', case when (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) = 0 then 'OK' else 'FAIL' end, ''
union all select 'cron_jobs', case when (select count(*) from cron.job where jobname <> 'community-media-purge-tick') = 0 then 'OK' else 'FAIL' end, coalesce((select string_agg(jobname || '@' || schedule, ',') from cron.job), 'none')
union all select 'no_deletion_cron', case when (select count(*) from cron.job where command like '%account_deletion%') = 0 then 'OK' else 'FAIL' end, ''
union all select 'vault_secret_names_info', 'INFO', coalesce((select string_agg(name, ',' order by name) from vault.secrets), 'none')
union all select 'extensions', case when (select count(*) from pg_extension where extname in ('pg_cron','pg_net')) = 2 then 'OK' else 'FAIL' end, ''
order by 1;
