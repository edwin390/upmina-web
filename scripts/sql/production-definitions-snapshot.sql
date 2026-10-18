-- SNAPSHOT de las definiciones que van a ser REDEFINIDAS por las 5 migraciones finales. SOLO LECTURA.
-- Guardar la salida JUNTO AL RESPALDO (-OutFile): sirve de referencia exacta para una corrección hacia delante.
set default_transaction_read_only = on;

select 'function' || '|' || p.proname || '|' || pg_get_functiondef(p.oid)
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('community_post_save','community_post_save_atomic','community_post_detach_media','community_post_reorder_media',
                    'community_media_delivery_state','media_abandoned_sweep','community_media_asset_discard',
                    'account_deletion_backlog','account_deletion_developer_retry')
union all
select 'constraint' || '|' || conname || '|' || pg_get_constraintdef(oid)
from pg_constraint
where conname in ('community_posts_status_check','moderation_audit_log_action_check')
order by 1;
