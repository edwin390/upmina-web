-- Aviso por correo (en inglés) al autor cuando se CONFIRMA un strike de Community, con el mismo mecanismo que los strikes de Copyright.
--
--   * No se toca community_strike_apply ni ninguna regla de sanciones, periodos, revocación o acumulación.
--   * El registro del aviso reutiliza copyright_strike_notices, que pasa a estar identificada por el STRIKE (strike_id) en vez de por la
--     reclamación: claim_id queda nulo para los strikes de Community y sigue siendo único para los de Copyright.
--   * El aviso solo existe para un strike REAL y no revocado; un segundo intento nunca repite un aviso ya enviado (notified_at).
--   * No se escribe auditoría adicional: el strike ya queda auditado al aplicarse y el resultado del aviso queda en esta tabla
--     (no se amplía el CHECK de acciones de auditoría que lee el historial de casos).
-- No se modifica ningún strike ni ningún aviso existente.

alter table public.copyright_strike_notices drop constraint copyright_strike_notices_pkey;
alter table public.copyright_strike_notices drop constraint copyright_strike_notices_strike_id_key;
alter table public.copyright_strike_notices add constraint copyright_strike_notices_pkey primary key (strike_id);
alter table public.copyright_strike_notices alter column claim_id drop not null;
create unique index copyright_strike_notices_claim_idx on public.copyright_strike_notices (claim_id) where claim_id is not null;
comment on table public.copyright_strike_notices is
  'Estado del aviso por correo de un strike (Copyright: claim_id no nulo y único; Community: claim_id nulo). Privada: solo las funciones SECURITY DEFINER. Un registro por strike.';

-- Contexto (bajo bloqueo) para enviar el aviso de un strike de Community. Crea el registro del aviso la primera vez.
create function public.community_strike_notice_context(p_actor_user_id uuid, p_strike_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_strike public.community_user_strikes%rowtype; v_notice public.copyright_strike_notices%rowtype; v_email text;
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_strike_id is null then raise exception 'invalid_argument'; end if;
  select * into v_strike from public.community_user_strikes where id = p_strike_id;
  if not found or v_strike.source <> 'community' then raise exception 'strike_not_found'; end if;
  -- Un strike ya revocado no se notifica: la sanción ya no existe.
  if v_strike.revoked_at is not null then raise exception 'invalid_transition'; end if;
  insert into public.copyright_strike_notices (claim_id, strike_id) values (null, v_strike.id) on conflict (strike_id) do nothing;
  select * into v_notice from public.copyright_strike_notices where strike_id = v_strike.id for update;
  if v_notice.notified_at is not null then raise exception 'invalid_transition'; end if;
  select u.email into v_email from auth.users u where u.id = v_strike.user_id;
  return jsonb_build_object('strikeId', v_strike.id,
    'strike', jsonb_build_object('authorEmail', v_email, 'level', v_strike.level, 'permanent', v_strike.permanent,
      'endsAt', v_strike.sanction_ends_at, 'reason', v_strike.reason));
end;
$$;
alter function public.community_strike_notice_context(uuid, uuid) owner to postgres;
revoke execute on function public.community_strike_notice_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.community_strike_notice_context(uuid, uuid) to service_role;

create function public.community_strike_notice_record(
  p_actor_user_id uuid, p_strike_id uuid, p_ok boolean, p_error_class text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text; v_notice public.copyright_strike_notices%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select role into v_role from public.admin_roles where user_id = p_actor_user_id for share;
  if v_role is null or v_role not in ('moderator', 'developer', 'admin') then raise exception 'actor_not_moderator'; end if;
  if p_strike_id is null or p_ok is null or (p_ok and p_error_class is not null)
     or (not p_ok and (p_error_class is null or p_error_class not in
       ('not_configured', 'rejected', 'rate_limited', 'provider_unavailable', 'timeout', 'invalid_response', 'no_recipient'))) then
    raise exception 'invalid_argument';
  end if;
  select * into v_notice from public.copyright_strike_notices where strike_id = p_strike_id and claim_id is null for update;
  if not found then raise exception 'invalid_transition'; end if;
  -- Idempotente: un segundo registro de un aviso ya enviado no repite nada.
  if v_notice.notified_at is not null then
    return jsonb_build_object('strikeId', p_strike_id, 'alreadyNotified', true);
  end if;
  if p_ok then
    update public.copyright_strike_notices set notified_at = v_now, last_error = null where strike_id = p_strike_id;
  else
    update public.copyright_strike_notices set attempts = attempts + 1, last_error = p_error_class where strike_id = p_strike_id;
  end if;
  return jsonb_build_object('strikeId', p_strike_id, 'alreadyNotified', false);
end;
$$;
alter function public.community_strike_notice_record(uuid, uuid, boolean, text) owner to postgres;
revoke execute on function public.community_strike_notice_record(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.community_strike_notice_record(uuid, uuid, boolean, text) to service_role;
