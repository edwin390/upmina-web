-- Rollback de 20261111120000_copyright_strikes.sql. Se niega a ejecutarse si ya existe algún strike de Copyright (historial inmutable).
-- Restaura las dos funciones de trigger a su definición original de 20261023120000 y quita columnas, restricciones y tabla de avisos.
do $rollback$
begin
  if exists (select 1 from public.community_user_strikes where source = 'copyright')
     or exists (select 1 from public.copyright_claim_events where kind in ('strike_applied', 'strike_notified', 'strike_notification_failed')) then
    raise exception 'rollback_blocked_copyright_strikes_exist';
  end if;
end;
$rollback$;

drop function public.copyright_strike_notice_record(uuid, uuid, boolean, text);
drop function public.copyright_strike_notice_context(uuid, uuid);
drop function public.copyright_strike_state(uuid, uuid);
drop function public.copyright_strike_apply(uuid, uuid, text, integer);
drop table public.copyright_strike_notices;

alter table public.copyright_claim_events drop constraint copyright_claim_events_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_kind_check check (kind in
  ('received', 'review_started', 'info_requested', 'review_resumed', 'note', 'dismissed', 'withdrawn',
   'removed', 'notified', 'notification_failed', 'token_reissued', 'appeal_submitted', 'appeal_accepted',
   'appeal_rejected', 'restored', 'purged'));

create or replace function public.community_user_strikes_immutable()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE'
    and old.revoked_at is null
    and new.revoked_at is not null and new.revoked_by is not null and new.revocation_reason is not null
    and (new.id, new.user_id, new.case_id, new.cycle_id, new.decision_id, new.post_id, new.level,
         new.reason, new.applied_by, new.sanction_starts_at, new.sanction_ends_at, new.permanent,
         new.created_at)
      is not distinct from
        (old.id, old.user_id, old.case_id, old.cycle_id, old.decision_id, old.post_id, old.level,
         old.reason, old.applied_by, old.sanction_starts_at, old.sanction_ends_at, old.permanent,
         old.created_at) then
    return new;
  end if;
  raise exception 'community_user_strikes_immutable' using errcode = '23001';
end;
$$;

create or replace function public.community_user_strikes_context_check()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (
    select 1
    from public.community_moderation_decisions d
    join public.community_moderation_cases c on c.id = d.case_id
    where d.id = new.decision_id and d.decision = 'content_actioned'
      and c.author_identity = 'known' and c.target_author_user_id = new.user_id
  ) then
    raise exception 'community_user_strikes_context' using errcode = '23514';
  end if;
  return new;
end;
$$;

alter table public.community_user_strikes
  drop constraint community_user_strikes_claim_fk,
  drop constraint community_user_strikes_claim_unique,
  drop constraint community_user_strikes_source_check;
alter table public.community_user_strikes
  alter column case_id set not null,
  alter column cycle_id set not null,
  alter column decision_id set not null,
  drop column claim_id,
  drop column source;
