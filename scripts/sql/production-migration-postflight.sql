-- POSTFLIGHT de las 5 migraciones finales de Production. SOLO LECTURA. Mismo formato: check|OK/FAIL|detalle.
--   psql -X -A -t -F '|' -c "set default_transaction_read_only = on" -f scripts/sql/production-migration-postflight.sql
-- Los valores de los datos (users/profiles/posts/assets/admin_roles) deben ser IGUALES a los del preflight.

set default_transaction_read_only = on;

with hist as (select version from supabase_migrations.schema_migrations)
select 'history_last_is_20261128120000', case when (select max(version) from hist) = '20261128120000' then 'OK' else 'FAIL' end, 'last=' || (select max(version) from hist)
union all select 'history_has_the_5_selected_exact', case when (select count(*) from hist where version in ('20261119120000','20261120120000','20261121120000','20261127120000','20261128120000')) = 5 then 'OK' else 'FAIL' end, ''
union all select 'history_has_no_shadow', case when (select count(*) from hist where version between '20261122120000' and '20261126120000') = 0 then 'OK' else 'FAIL' end, ''
union all select 'history_count_is_70', case when (select count(*) from hist) = 70 then 'OK' else 'FAIL' end, 'count=' || (select count(*) from hist)
union all select 'no_shadow_objects', case when (select count(*) from pg_proc where proname like 'community_shadow%') = 0 and to_regclass('public.community_shadow_jobs') is null then 'OK' else 'FAIL' end, ''
union all select 'new_tables_exist_with_forced_rls', case when (select count(*) from pg_class where oid in (to_regclass('public.account_deletion_completion_notices'), to_regclass('public.community_post_pending_edits'), to_regclass('public.community_post_pending_edit_media')) and relrowsecurity and relforcerowsecurity) = 3 then 'OK' else 'FAIL' end, ''
union all select 'new_tables_no_api_privileges', case when (select count(*) from unnest(array['account_deletion_completion_notices','community_post_pending_edits','community_post_pending_edit_media']) t, unnest(array['anon','authenticated','service_role']) r, unnest(array['select','insert','update','delete']) p
    where has_table_privilege(r, 'public.' || t, p)) = 0 then 'OK' else 'FAIL' end, ''
union all select 'status_check_includes_held_for_review', case when exists (select 1 from pg_constraint where conname = 'community_posts_status_check' and pg_get_constraintdef(oid) like '%held_for_review%') then 'OK' else 'FAIL' end, ''
union all select 'audit_action_check_includes_content_actions', case when exists (select 1 from pg_constraint where conname = 'moderation_audit_log_action_check' and pg_get_constraintdef(oid) like '%content_edit_rejected%') then 'OK' else 'FAIL' end, ''
union all select 'expected_functions_exist', case when (select count(distinct proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in (
    'account_deletion_notice_capture','account_deletion_notice_claim','account_deletion_notice_finish','account_deletion_notice_purge',
    'account_deletion_notice_alerts','account_deletion_notice_developer_retry','community_content_review_read','community_content_review_decide',
    'community_post_pending_edit_submit','community_post_pending_edit_cancel','community_post_pending_edit_reject','community_post_pending_edit_approve',
    'community_post_create_held','community_post_hold_release','community_post_hold_reject','community_author_pending_read','community_pending_edit_close')) = 17 then 'OK' else 'FAIL' end, ''
union all select 'api_roles_cannot_execute_changed_or_new_functions', case when (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
    and (p.proname like 'account_deletion%' or p.proname like 'community_post_pending%' or p.proname like 'community_content_review%' or p.proname like 'community_post_hold%'
         or p.proname in ('community_post_save','community_post_save_atomic','community_post_detach_media','community_post_reorder_media','community_media_delivery_state','media_abandoned_sweep','community_media_asset_discard','community_post_create_held','community_author_pending_read','community_pending_edit_close'))
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) = 0 then 'OK' else 'FAIL' end, ''
union all select 'service_role_can_execute_notice_and_review_functions', case when (select count(*) from pg_proc p where p.proname in ('account_deletion_notice_capture','account_deletion_notice_alerts','community_content_review_read') and has_function_privilege('service_role', p.oid, 'execute')) = 3 then 'OK' else 'FAIL' end, ''
union all select 'secdef_all_have_search_path', case when (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) = 0 then 'OK' else 'FAIL' end, ''
union all select 'developer_retry_has_stalled_branch', case when (select prosrc from pg_proc where proname = 'account_deletion_developer_retry') like '%not_stalled%' then 'OK' else 'FAIL' end, ''
union all select 'backlog_includes_notices', case when (select prosrc from pg_proc where proname = 'account_deletion_backlog') like '%account_deletion_completion_notices%' then 'OK' else 'FAIL' end, ''
union all select 'tables_without_rls', case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) = 0 then 'OK' else 'FAIL' end, ''
union all select 'cron_unchanged_only_media_purge', case when (select count(*) from cron.job where jobname <> 'community-media-purge-tick') = 0 and (select count(*) from cron.job where command like '%account_deletion%') = 0 then 'OK' else 'FAIL' end, coalesce((select string_agg(jobname, ',') from cron.job), 'none')
union all select 'community_posts_by_status', 'INFO', coalesce((select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from public.community_posts group by status) s), 'none')
union all select 'row_counts', 'INFO', 'users=' || (select count(*) from auth.users) || ',profiles=' || (select count(*) from public.profiles) || ',posts=' || (select count(*) from public.community_posts) || ',assets=' || (select count(*) from public.media_assets) || ',admin_roles=' || (select count(*) from public.admin_roles)
union all select 'pending_edits_and_notices_empty', case when (select count(*) from public.community_post_pending_edits) = 0 and (select count(*) from public.account_deletion_completion_notices) = 0 then 'OK' else 'INFO' end, ''
order by 1;
