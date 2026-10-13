-- COPY-1: strikes MANUALES de Copyright, sobre el sistema de strikes de Community (community_user_strikes).
--
-- Reglas:
--   * Un strike de Copyright SOLO lo aplica una persona de moderación, con una acción explícita, y SOLO cuando la reclamación está
--     en `purged` (publicación eliminada definitivamente). Ningún trigger ni transición de estado crea ni revoca strikes.
--   * Un strike por reclamación (UNIQUE claim_id), para siempre. El historial es inmutable y se audita igual que en Community.
--   * El nivel (1-3) y la duración salen de las MISMAS reglas que Community: min(strikes NO revocados del autor + 1, 3); los de
--     Copyright y los de Community cuentan juntos. La restricción vigente sigue leyéndola community_author_restriction.
--   * La revocación sigue siendo la existente (community_strike_revoke: developer/admin, nunca quien lo aplicó). No hay apelación nueva.
--   * El aviso al autor se registra en copyright_strike_notices (enviado/fallido/pendiente) para reintentos seguros sin duplicados.
-- No se modifica ningún strike existente: las columnas nuevas son nulas/por defecto 'community' y no hay backfill.

-- 1. community_user_strikes: origen y reclamación ----------------------------------------------------------------------------------
alter table public.community_user_strikes
  add column source   text not null default 'community',
  add column claim_id uuid;

alter table public.community_user_strikes
  alter column case_id drop not null,
  alter column cycle_id drop not null,
  alter column decision_id drop not null;

alter table public.community_user_strikes
  add constraint community_user_strikes_source_check check (
    (source = 'community' and claim_id is null
      and case_id is not null and cycle_id is not null and decision_id is not null)
    or (source = 'copyright' and claim_id is not null
      and case_id is null and cycle_id is null and decision_id is null)),
  add constraint community_user_strikes_claim_unique unique (claim_id),
  add constraint community_user_strikes_claim_fk foreign key (claim_id) references public.copyright_claims (id);
-- (La FK compuesta de la decisión es MATCH SIMPLE: con decision_id nulo no se evalúa, justo lo que se quiere para Copyright.)

-- La inmutabilidad incluye ahora el origen y la reclamación; la única actualización permitida sigue siendo la revocación única.
create or replace function public.community_user_strikes_immutable()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE'
    and old.revoked_at is null
    and new.revoked_at is not null and new.revoked_by is not null and new.revocation_reason is not null
    and (new.id, new.user_id, new.case_id, new.cycle_id, new.decision_id, new.post_id, new.level,
         new.reason, new.applied_by, new.sanction_starts_at, new.sanction_ends_at, new.permanent,
         new.created_at, new.source, new.claim_id)
      is not distinct from
        (old.id, old.user_id, old.case_id, old.cycle_id, old.decision_id, old.post_id, old.level,
         old.reason, old.applied_by, old.sanction_starts_at, old.sanction_ends_at, old.permanent,
         old.created_at, old.source, old.claim_id) then
    return new;
  end if;
  raise exception 'community_user_strikes_immutable' using errcode = '23001';
end;
$$;

-- Defensa en profundidad: cualquier vía que inserte un strike de Copyright debe describir una reclamación `purged` real cuyo autor
-- registrado es el sancionado y cuya publicación es la del strike.
create or replace function public.community_user_strikes_context_check()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.source = 'copyright' then
    if not exists (
      select 1 from public.copyright_claims c
      where c.id = new.claim_id and c.status = 'purged'
        and c.post_author_user_id = new.user_id and c.post_id = new.post_id
    ) then
      raise exception 'community_user_strikes_context' using errcode = '23514';
    end if;
    return new;
  end if;
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

-- 2. Estado del aviso al autor (uno por strike de Copyright) ----------------------------------------------------------------------
create table public.copyright_strike_notices (
  claim_id    uuid primary key references public.copyright_claims (id),
  strike_id   uuid not null unique references public.community_user_strikes (id),
  created_at  timestamptz not null default now(),
  notified_at timestamptz,
  attempts    integer not null default 0 check (attempts >= 0),
  last_error  text check (last_error is null or last_error in
    ('not_configured', 'rejected', 'rate_limited', 'provider_unavailable', 'timeout', 'invalid_response', 'no_recipient')),
  check (notified_at is null or last_error is null)
);
alter table public.copyright_strike_notices enable row level security;
alter table public.copyright_strike_notices force row level security;
revoke all on table public.copyright_strike_notices from public, anon, authenticated, service_role;
comment on table public.copyright_strike_notices is
  'Estado del aviso por correo de un strike de Copyright. Privada: solo las funciones SECURITY DEFINER. Un registro por strike.';

alter table public.copyright_claim_events drop constraint copyright_claim_events_kind_check;
alter table public.copyright_claim_events add constraint copyright_claim_events_kind_check check (kind in
  ('received', 'review_started', 'info_requested', 'review_resumed', 'note', 'dismissed', 'withdrawn',
   'removed', 'notified', 'notification_failed', 'token_reissued', 'appeal_submitted', 'appeal_accepted',
   'appeal_rejected', 'restored', 'purged', 'strike_applied', 'strike_notified', 'strike_notification_failed'));

-- 3. Aplicar el strike (manual) ----------------------------------------------------------------------------------------------------
-- Orden de bloqueos como en Community: rol (share) -> perfil del autor (no key update) -> reclamación (update) -> strike (insert).
create function public.copyright_strike_apply(
  p_actor_user_id uuid, p_claim_id uuid, p_reason text, p_expected_level integer default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_reason text := nullif(btrim(p_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '');
  v_role text; v_claim public.copyright_claims%rowtype; v_author uuid;
  v_active integer; v_level integer; v_now timestamptz; v_ends timestamptz; v_id uuid := gen_random_uuid();
begin
  if p_actor_user_id is null or p_claim_id is null
     or (p_expected_level is not null and p_expected_level not between 1 and 3) then
    raise exception 'invalid_argument';
  end if;
  if v_reason is null then raise exception 'reason_required'; end if;
  if char_length(v_reason) > 1000 then raise exception 'invalid_argument'; end if;

  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;

  -- Lectura sin bloqueo solo para localizar al autor (la reclamación cerrada no cambia); se vuelve a leer bajo bloqueo.
  select * into v_claim from public.copyright_claims where id = p_claim_id;
  if not found then raise exception 'claim_not_found'; end if;
  if v_claim.status <> 'purged' then raise exception 'claim_not_purged'; end if;
  v_author := v_claim.post_author_user_id;
  if v_author is null or v_claim.post_id is null then raise exception 'author_unavailable'; end if;
  if v_author = p_actor_user_id then raise exception 'self_strike_forbidden'; end if;

  perform 1 from public.profiles where user_id = v_author for no key update;
  if not found then raise exception 'author_unavailable'; end if;

  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  if v_claim.status <> 'purged' then raise exception 'claim_not_purged'; end if;
  if exists (select 1 from public.community_user_strikes where claim_id = v_claim.id) then
    raise exception 'strike_already_issued';
  end if;

  -- Nivel: strikes NO revocados del autor (Community y Copyright juntos), igual que community_strike_apply.
  select count(*) into v_active from public.community_user_strikes where user_id = v_author and revoked_at is null;
  v_level := least(v_active + 1, 3);
  if p_expected_level is not null and p_expected_level <> v_level then raise exception 'level_changed'; end if;

  v_now := pg_catalog.clock_timestamp();
  v_ends := case v_level
    when 1 then ((v_now at time zone 'UTC') + interval '14 days') at time zone 'UTC'
    when 2 then ((v_now at time zone 'UTC') + interval '1 month') at time zone 'UTC'
    else null end;

  begin
    insert into public.community_user_strikes
      (id, user_id, case_id, cycle_id, decision_id, post_id, level, reason, applied_by,
       sanction_starts_at, sanction_ends_at, permanent, created_at, source, claim_id)
    values (v_id, v_author, null, null, null, v_claim.post_id, v_level, v_reason, p_actor_user_id,
      v_now, v_ends, v_level = 3, v_now, 'copyright', v_claim.id);
  exception when unique_violation then
    raise exception 'strike_already_issued';
  end;
  insert into public.copyright_strike_notices (claim_id, strike_id, created_at) values (v_claim.id, v_id, v_now);

  insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, created_at)
    values (v_claim.id, 'strike_applied', 'human', p_actor_user_id, v_claim.status, v_claim.status, v_now);
  -- Metadatos mínimos: nada de motivo, ni identidad del reclamante.
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'community_user_strike', v_id, 'strike_applied',
      jsonb_build_object('source', 'copyright', 'claim_id', v_claim.id, 'reference', v_claim.reference, 'level', v_level), v_now);

  return jsonb_build_object('strikeId', v_id, 'claimId', v_claim.id, 'reference', v_claim.reference,
    'level', v_level, 'permanent', v_level = 3, 'startsAt', v_now, 'endsAt', v_ends);
end;
$$;
alter function public.copyright_strike_apply(uuid, uuid, text, integer) owner to postgres;
revoke execute on function public.copyright_strike_apply(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.copyright_strike_apply(uuid, uuid, text, integer) to service_role;

-- 4. Estado (lectura) para el panel: elegibilidad, nivel que correspondería, strike aplicado y estado del aviso ------------------
create function public.copyright_strike_state(p_actor_user_id uuid, p_claim_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_strike public.community_user_strikes%rowtype;
  v_notice public.copyright_strike_notices%rowtype; v_active integer; v_blocker text;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null then raise exception 'invalid_argument'; end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id;
  if not found then raise exception 'claim_not_found'; end if;
  select * into v_strike from public.community_user_strikes where claim_id = v_claim.id;
  if found then
    select * into v_notice from public.copyright_strike_notices where claim_id = v_claim.id;
    return jsonb_build_object('eligible', false, 'blocker', 'strike_already_issued', 'nextLevel', null,
      'strike', jsonb_build_object('id', v_strike.id, 'level', v_strike.level, 'permanent', v_strike.permanent,
        'startsAt', v_strike.sanction_starts_at, 'endsAt', v_strike.sanction_ends_at, 'reason', v_strike.reason,
        'revokedAt', v_strike.revoked_at),
      'notice', jsonb_build_object(
        'status', case when v_notice.notified_at is not null then 'sent' when v_notice.attempts > 0 then 'failed' else 'pending' end,
        'attempts', coalesce(v_notice.attempts, 0), 'error', v_notice.last_error));
  end if;
  v_blocker := case
    when v_claim.status <> 'purged' then 'claim_not_purged'
    when v_claim.post_author_user_id is null or v_claim.post_id is null
      or not exists (select 1 from public.profiles p where p.user_id = v_claim.post_author_user_id) then 'author_unavailable'
    when v_claim.post_author_user_id = p_actor_user_id then 'self_strike_forbidden'
    else null end;
  select count(*) into v_active from public.community_user_strikes
    where user_id = v_claim.post_author_user_id and revoked_at is null;
  return jsonb_build_object('eligible', v_blocker is null, 'blocker', v_blocker,
    'nextLevel', case when v_blocker is null then least(v_active + 1, 3) end, 'strike', null, 'notice', null);
end;
$$;
alter function public.copyright_strike_state(uuid, uuid) owner to postgres;
revoke execute on function public.copyright_strike_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.copyright_strike_state(uuid, uuid) to service_role;

-- 5. Aviso al autor: contexto (bajo bloqueo) y registro del resultado --------------------------------------------------------------
create function public.copyright_strike_notice_context(p_actor_user_id uuid, p_claim_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_strike public.community_user_strikes%rowtype;
  v_notice public.copyright_strike_notices%rowtype; v_email text;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null then raise exception 'invalid_argument'; end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  select * into v_notice from public.copyright_strike_notices where claim_id = v_claim.id for update;
  if not found or v_notice.notified_at is not null then raise exception 'invalid_transition'; end if;
  select * into v_strike from public.community_user_strikes where id = v_notice.strike_id;
  select u.email into v_email from auth.users u where u.id = v_strike.user_id;
  return jsonb_build_object('id', v_claim.id, 'reference', v_claim.reference, 'status', v_claim.status,
    'version', v_claim.version, 'updatedAt', v_claim.updated_at,
    'strike', jsonb_build_object('authorEmail', v_email, 'level', v_strike.level, 'permanent', v_strike.permanent,
      'endsAt', v_strike.sanction_ends_at, 'reason', v_strike.reason));
end;
$$;
alter function public.copyright_strike_notice_context(uuid, uuid) owner to postgres;
revoke execute on function public.copyright_strike_notice_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.copyright_strike_notice_context(uuid, uuid) to service_role;

create function public.copyright_strike_notice_record(
  p_actor_user_id uuid, p_claim_id uuid, p_ok boolean, p_error_class text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_claim public.copyright_claims%rowtype; v_notice public.copyright_strike_notices%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_claim_id is null or p_ok is null or (p_ok and p_error_class is not null)
     or (not p_ok and (p_error_class is null or p_error_class not in
       ('not_configured', 'rejected', 'rate_limited', 'provider_unavailable', 'timeout', 'invalid_response', 'no_recipient'))) then
    raise exception 'invalid_argument';
  end if;
  select * into v_claim from public.copyright_claims where id = p_claim_id for update;
  if not found then raise exception 'claim_not_found'; end if;
  select * into v_notice from public.copyright_strike_notices where claim_id = v_claim.id for update;
  if not found then raise exception 'invalid_transition'; end if;
  -- Idempotente: un segundo registro de un aviso ya enviado no repite nada.
  if v_notice.notified_at is not null then
    return jsonb_build_object('id', v_claim.id, 'alreadyNotified', true);
  end if;
  if p_ok then
    update public.copyright_strike_notices set notified_at = v_now, last_error = null where claim_id = v_claim.id;
  else
    update public.copyright_strike_notices set attempts = attempts + 1, last_error = p_error_class where claim_id = v_claim.id;
  end if;
  insert into public.copyright_claim_events (claim_id, kind, actor_kind, actor_user_id, from_status, to_status, note, created_at)
    values (v_claim.id, case when p_ok then 'strike_notified' else 'strike_notification_failed' end, 'human', p_actor_user_id,
      v_claim.status, v_claim.status, case when p_ok then null else p_error_class end, v_now);
  insert into public.moderation_audit_log (actor_kind, actor_user_id, target_type, target_id, action, metadata, created_at)
    values ('human', p_actor_user_id, 'copyright_claim', v_claim.id,
      case when p_ok then 'copyright_notification_sent' else 'copyright_notification_failed' end,
      jsonb_build_object('reference', v_claim.reference, 'to_status', v_claim.status, 'claim_version', v_claim.version,
        'notice', 'strike') || case when p_ok then '{}'::jsonb else jsonb_build_object('error_class', p_error_class) end, v_now);
  return jsonb_build_object('id', v_claim.id, 'alreadyNotified', false);
end;
$$;
alter function public.copyright_strike_notice_record(uuid, uuid, boolean, text) owner to postgres;
revoke execute on function public.copyright_strike_notice_record(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.copyright_strike_notice_record(uuid, uuid, boolean, text) to service_role;
