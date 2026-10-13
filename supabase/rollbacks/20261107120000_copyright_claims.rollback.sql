-- ROLLBACK de 20261107120000_copyright_claims.sql (NO es una migración: vive fuera de supabase/migrations para que
-- `db push` no lo aplique). Para usarlo, copiar a una migración NUEVA.
-- Se niega a ejecutarse si ya existe CUALQUIER reclamación o fila de auditoría de copyright (moderation_audit_log es append-only:
-- no se puede borrar, y el CHECK restaurado la rechazaría). No toca community_posts, reportes, casos, strikes ni R7.

do $$
begin
  if exists (select 1 from public.moderation_audit_log
             where target_type = 'copyright_claim' or action like 'copyright\_claim\_%') then
    raise exception 'rollback_blocked_copyright_audit_rows';
  end if;
  if exists (select 1 from public.copyright_claims) then
    raise exception 'rollback_blocked_claims_exist';
  end if;
end;
$$;

drop function public.copyright_claim_review(uuid, uuid, text, integer, text);
drop function public.copyright_claims_read(uuid, text, timestamptz, uuid, uuid);
drop function public.copyright_claim_create(text, text, text, jsonb);
drop function public.copyright_claim_hit_(text, text, interval, integer, timestamptz);
drop table public.copyright_claim_limits;
drop table public.copyright_claim_events;
drop function public.copyright_claim_events_immutable();
drop table public.copyright_claims;
drop sequence public.copyright_claim_ref_seq;
drop function public.copyright_urls_ok(text[]);
drop function public.copyright_text_ok(text, integer, integer);

alter table public.moderation_audit_log
  drop constraint moderation_audit_log_action_check,
  drop constraint moderation_audit_log_target_type_check;
alter table public.moderation_audit_log
  add constraint moderation_audit_log_action_check check (action in (
    'report_status_changed', 'post_hidden', 'post_restored', 'post_quarantined', 'case_rejected',
    'content_actioned', 'strike_applied', 'strike_revoked', 'post_purged')),
  add constraint moderation_audit_log_target_type_check check (target_type in (
    'community_post_report', 'community_post', 'community_moderation_case', 'community_user_strike'));
