-- Bloque 9D: revocación de invitaciones standard mediante una RPC SECURITY DEFINER específica.
-- Migración NUEVA: no modifica ninguna migración anterior (9B queda intacta).
--
-- Por qué existe: 9B dejó a service_role solo con SELECT + INSERT sobre admin_invitations (sin
-- UPDATE/DELETE). La revocación es una transición PENDING -> REVOKED que el backend no puede hacer
-- con un UPDATE directo, así que se expone como la ÚNICA vía de revocación. NO se concede UPDATE a
-- service_role. La creación de invitaciones standard NO necesita RPC: el INSERT directo ya pasa por
-- admin_invitations_before_insert (creador ADMIN bajo el lock compartido, estado inicial limpio).
--
-- Cumple la regla de 9B: toma public.upmina_lock_admin_roles() PRIMERO, antes de cualquier
-- SELECT ... FOR UPDATE. Consumir y revocar quedan serializados por ese lock, y una degradación del
-- actor (que toma el mismo lock) no puede intercalarse entre la comprobación del actor y el UPDATE.
--
-- Errores (RAISE EXCEPTION sin SQLSTATE propio => P0001; los literales son un contrato con
-- src/lib/admin-team-invitations.ts, que los reconoce como lista cerrada):
--   actor_not_admin, invitation_not_found, invitation_not_revocable (no es standard),
--   invitation_already_consumed, invitation_already_revoked, invitation_expired.
-- No se capturan excepciones (tampoco last_admin_protected / 23001).

create or replace function public.revoke_admin_invitation(
  p_invitation_id uuid,
  p_actor_user_id uuid
)
returns table(out_revoked_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.admin_invitations%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  perform public.upmina_lock_admin_roles();

  -- El actor debe seguir siendo ADMIN AHORA (bajo el lock): el handler ya autorizó con un JWT
  -- aal2, pero el rol pudo cambiar entre esa comprobación y esta transacción.
  if p_actor_user_id is null
     or not exists (
       select 1 from public.admin_roles ar
        where ar.user_id = p_actor_user_id and ar.role = 'admin'
     ) then
    raise exception 'actor_not_admin';
  end if;

  if p_invitation_id is null then
    raise exception 'invitation_not_found';
  end if;

  select * into v_row
    from public.admin_invitations i
    where i.id = p_invitation_id
    for update;

  if not found then
    raise exception 'invitation_not_found';
  end if;
  if v_row.invitation_type <> 'standard' then
    raise exception 'invitation_not_revocable';
  end if;
  if v_row.consumed_at is not null then
    raise exception 'invitation_already_consumed';
  end if;
  if v_row.revoked_at is not null then
    raise exception 'invitation_already_revoked';
  end if;
  if v_row.expires_at < v_now then
    raise exception 'invitation_expired';
  end if;

  update public.admin_invitations
     set revoked_at = v_now, revoked_by = p_actor_user_id
   where id = p_invitation_id;

  return query select v_now;
end;
$$;

comment on function public.revoke_admin_invitation(uuid, uuid) is
  'Revoca de forma atómica una admin_invitations standard pendiente (única vía de revocación). SOLO service_role (EXECUTE). p_actor_user_id debe venir de un JWT verificado con aal2 y capacidad team_admin (responsabilidad del backend); la función además exige que siga siendo ADMIN. Rechaza: actor no ADMIN, id inexistente, no standard, consumida, ya revocada, expirada.';

revoke all on function public.revoke_admin_invitation(uuid, uuid) from public;
revoke execute on function public.revoke_admin_invitation(uuid, uuid) from anon;
revoke execute on function public.revoke_admin_invitation(uuid, uuid) from authenticated;
grant execute on function public.revoke_admin_invitation(uuid, uuid) to service_role;
