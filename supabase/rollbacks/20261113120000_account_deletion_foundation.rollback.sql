-- Rollback de 20261113120000_account_deletion_foundation.sql (solo local/operador; nunca se aplica sobre una base con eliminaciones confirmadas).
-- Se rechaza si existe alguna solicitud confirmada o alguna reclamación author_deleted: borrar la barrera reactivaría cuentas en eliminación.
-- Si hiciera falta de verdad, se copia a una migración nueva (el historial es de solo avance).

do $$
begin
  if exists (select 1 from public.account_deletion_blocks) or exists (select 1 from public.copyright_claims where status = 'author_deleted')
     or exists (select 1 from public.community_moderation_cycles where closure_kind = 'author_deleted')
     or exists (select 1 from public.copyright_claim_events where kind = 'author_deleted' or actor_kind = 'system') then
    raise exception 'rollback_refused_account_deletion_in_use';
  end if;
end
$$;

drop trigger account_deletion_roles_insert on public.admin_roles;
drop trigger account_deletion_profile_insert on public.profiles;
drop trigger account_deletion_profile_update on public.profiles;
drop trigger account_deletion_post_media_write on public.community_post_media;
drop trigger account_deletion_media_insert on public.media_assets;
drop trigger account_deletion_reports_insert on public.community_post_reports;
drop trigger account_deletion_likes_insert on public.community_post_likes;
drop trigger account_deletion_posts_edit on public.community_posts;
drop trigger account_deletion_posts_insert on public.community_posts;

drop function public.account_deletion_developer_retry(uuid, uuid);
drop function public.account_deletion_alerts(uuid);
drop function public.account_deletion_stage_media(uuid, text);
drop function public.account_deletion_stage_profile(uuid, text);
drop function public.account_deletion_stage_content(uuid, text);
drop function public.account_deletion_stage_copyright(uuid, text);
drop function public.account_deletion_release(uuid, text);
drop function public.account_deletion_step_finish(uuid, text, text, boolean, text, integer);
drop function public.account_deletion_step_start(uuid, text, text);
drop function public.account_deletion_assert_running(uuid, text, text);
drop function public.account_deletion_claim(text, integer, integer);
drop function public.account_deletion_expire_pending(integer);
drop function public.account_deletion_confirm(uuid, text);
drop function public.account_deletion_preview(uuid, text);
drop function public.account_deletion_request(uuid, text, integer);
drop function public.account_deletion_gate(uuid);
drop function public.account_deletion_post_media_guard();
drop function public.account_deletion_write_guard();
drop function public.account_deletion_is_blocked(uuid);

drop table public.account_deletion_retention_catalog;
drop table public.account_deletion_events;
drop table public.account_deletion_steps;
drop table public.account_deletion_blocks;
drop table public.account_deletion_requests;
drop function public.account_deletion_steps_guard();
drop function public.account_deletion_permanent_guard();
drop function public.account_deletion_requests_guard();

alter table public.copyright_claim_events drop constraint copyright_claim_events_actor_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_actor_kind_check
  check (actor_kind in ('claimant', 'human'));
alter table public.copyright_claim_events drop constraint copyright_claim_events_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_kind_check check (kind in
  ('received', 'review_started', 'info_requested', 'review_resumed', 'note', 'dismissed', 'withdrawn',
   'removed', 'notified', 'notification_failed', 'token_reissued', 'appeal_submitted', 'appeal_accepted',
   'appeal_rejected', 'restored', 'purged', 'strike_applied', 'strike_notified', 'strike_notification_failed'));

alter table public.copyright_claims drop constraint copyright_claims_removal_check;
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
alter table public.copyright_claims drop constraint copyright_claims_status_check;
alter table public.copyright_claims add constraint copyright_claims_status_check check (status in
  ('received', 'in_review', 'needs_info', 'dismissed', 'withdrawn', 'removed', 'appeal_pending', 'restored', 'purged'));

alter table public.community_moderation_cycles drop constraint community_moderation_cycles_closure_kind_check;
alter table public.community_moderation_cycles add constraint community_moderation_cycles_closure_kind_check
  check (closure_kind in ('legacy', 'decision'));
