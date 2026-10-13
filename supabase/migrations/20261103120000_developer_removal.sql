-- DEVELOPER PANEL V1 — «Quitar acceso» a un Developer. PROPUESTA LOCAL: NO aplicada.
-- Forward-only, posterior a 20261102120000 (que no se modifica).
--
-- Decisiones (una frase cada una):
--   * admin_remove_developer(actor, target) retira la fila de admin_roles del Developer objetivo (y revoca sus
--     invitaciones estándar pendientes, como cualquier salida de Admin) y, EN LA MISMA TRANSACCIÓN, registra la
--     limpieza MFA con la infraestructura de la fase 1 (admin_mfa_resets: instantánea atómica de los ids de sus
--     factores TOTP; la misma que escribe admin_remove_member_with_mfa_reset para Admin y Moderator). NO borra la
--     cuenta de auth ni su perfil ni sus contenidos. Los factores los borra después el backend con el flujo
--     existente (runMfaResetCleanup: solo los ids de la instantánea, idempotente, con reintento y auditoría
--     'mfa_reset_completed'); un fallo del borrado deja la limpieza PENDIENTE y nunca devuelve privilegios.
--     remove_admin_member sigue rechazando developer: la lógica de retirada de Developer vive solo aquí.
--   * Solo lo ejecuta service_role. El actor sale del JWT verificado en el backend (nunca del cliente) y la
--     función lo revalida: debe ser ADMIN vigente bajo el lock de roles. Nadie se retira a sí mismo.
--   * El lock compartido upmina_lock_admin_roles() va PRIMERO, antes de cualquier FOR UPDATE (regla de 9B); el
--     objetivo se bloquea después. Dos retiradas simultáneas se serializan: la segunda ve «not_found».
--   * No se retira a un Developer con una recuperación de MFA ACTIVA que dependa de él:
--       - recuperación propia en curso (su rol cambiaría y se cancelaría por role_changed);
--       - recuperación que él APROBÓ y sigue activa (approved/executing/factors_deleted): su salida no debe
--         alterar una ejecución ya autorizada;
--       - si es el ÚLTIMO Developer y hay una solicitud de un Admin pendiente que no tiene otro Admin elegible
--         (solo un Developer podría aprobarla): quitarlo la dejaría sin ruta.
--     Sin esas dependencias se permite, incluso si es el último Developer: entonces devuelve lastDeveloper = true
--     para que la interfaz avise de la pérdida de la capacidad de aprobación excepcional.
--   * Auditoría append-only: admin_developer_audit recibe una fila 'removed' (actor, objetivo, developer -> sin rol) y
--     admin_team_audit una fila 'access_removed' (misma convención que cualquier otra retirada). new_role de
--     admin_developer_audit pasa a admitir NULL (resultado = sin rol de equipo), solo para 'removed'.
--   * No se crea ninguna vía para conceder Developer; el único camino sigue siendo la autotransferencia.
-- Rollback (solo local/operador): supabase/rollbacks/20261103120000_developer_removal.rollback.sql

-- ---------------------------------------------------------------------------------------------
-- 1. Auditoría de Developer: acción 'removed' (el resultado es «sin rol de equipo»: new_role NULL)
-- ---------------------------------------------------------------------------------------------
alter table public.admin_developer_audit alter column new_role drop not null;
alter table public.admin_developer_audit drop constraint admin_developer_audit_shape_check;
alter table public.admin_developer_audit add constraint admin_developer_audit_shape_check check (
  (action = 'granted' and previous_role = 'moderator' and new_role = 'developer'
     and actor_user_id is null and operator_note is not null)
  or (action = 'revoked' and previous_role = 'developer' and new_role = 'moderator'
     and actor_user_id is null and operator_note is not null)
  or (action = 'self_transferred' and previous_role = 'admin' and new_role = 'developer'
     and actor_user_id = target_user_id and operator_note is null)
  or (action = 'restored' and previous_role = 'developer' and new_role in ('admin', 'moderator')
     and actor_user_id is not null and actor_user_id <> target_user_id and operator_note is null)
  or (action = 'removed' and previous_role = 'developer' and new_role is null
     and actor_user_id is not null and actor_user_id <> target_user_id and operator_note is null));

-- ---------------------------------------------------------------------------------------------
-- 2. Retirada del acceso de un Developer por un Admin
-- ---------------------------------------------------------------------------------------------
create function public.admin_remove_developer(p_actor_user_id uuid, p_target_user_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_old text;
  v_now timestamptz;
  v_revoked integer := 0;
  v_last boolean;
  v_ids uuid[];
  v_reset_id uuid;
begin
  if p_actor_user_id is null or p_target_user_id is null then
    raise exception 'invalid_argument';
  end if;
  -- El lock compartido de roles va PRIMERO (regla de 9B).
  perform public.upmina_lock_admin_roles();
  v_now := pg_catalog.clock_timestamp();
  if not exists (select 1 from public.admin_roles ar where ar.user_id = p_actor_user_id and ar.role = 'admin') then
    raise exception 'actor_not_admin';
  end if;
  if p_actor_user_id = p_target_user_id then raise exception 'self_change_not_allowed'; end if;
  select ar.role into v_old from public.admin_roles ar where ar.user_id = p_target_user_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_old <> 'developer' then return jsonb_build_object('ok', false, 'reason', 'not_developer'); end if;

  -- Recuperación propia en curso: su rol cambiaría bajo ella.
  if exists (select 1 from public.admin_mfa_recoveries r
              where r.user_id = p_target_user_id
                and r.status in ('pending_email', 'pending_approval', 'approved', 'executing', 'factors_deleted')) then
    return jsonb_build_object('ok', false, 'reason', 'recovery_in_progress');
  end if;
  -- Recuperación que él aprobó y sigue activa: no se altera una ejecución ya autorizada.
  if exists (select 1 from public.admin_mfa_recoveries r
              where r.approved_by = p_target_user_id
                and r.status in ('approved', 'executing', 'factors_deleted')) then
    return jsonb_build_object('ok', false, 'reason', 'approval_in_progress');
  end if;

  -- Una limpieza MFA pendiente del objetivo no puede coexistir con un rol (la activación la bloquea): se rechaza
  -- antes que dejar dos instantáneas pendientes o mezclar factores.
  if exists (select 1 from public.admin_mfa_resets mr where mr.user_id = p_target_user_id and mr.status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'mfa_cleanup_pending');
  end if;

  v_last := not exists (select 1 from public.admin_roles ar
                         where ar.role = 'developer' and ar.user_id <> p_target_user_id);
  -- Último Developer: una solicitud de Admin activa SIN otro Admin elegible solo la podría aprobar un Developer.
  if v_last and exists (select 1 from public.admin_mfa_recoveries r
                         where r.role_at_request = 'admin'
                           and r.status in ('pending_email', 'pending_approval')
                           and not public.admin_mfa_recovery_peer_available(r.user_id)) then
    return jsonb_build_object('ok', false, 'reason', 'recovery_depends_on_developer');
  end if;

  delete from public.admin_roles where user_id = p_target_user_id;
  -- Como al dejar de ser Admin: sus invitaciones estándar pendientes se revocan.
  update public.admin_invitations i
     set revoked_at = v_now, revoked_by = p_actor_user_id
   where i.invitation_type = 'standard' and i.created_by = p_target_user_id
     and i.consumed_at is null and i.revoked_at is null and i.expires_at >= v_now;
  get diagnostics v_revoked = row_count;

  -- Limpieza MFA con la infraestructura existente: instantánea ATÓMICA con la retirada de los TOTP existentes
  -- ahora (igual que admin_remove_member_with_mfa_reset). Un factor creado después no está en la lista y nunca lo
  -- borrará esta operación ni sus reintentos; mientras esté pendiente, la activación de una invitación se bloquea.
  v_ids := coalesce(
    array(select f.id from auth.mfa_factors f
           where f.user_id = p_target_user_id and f.factor_type::text = 'totp'
           order by f.created_at, f.id),
    '{}'::uuid[]);
  insert into public.admin_mfa_resets
    (user_id, status, old_role, requested_by, requested_at, factor_ids, completed_at, factors_deleted)
  values (
    p_target_user_id,
    case when cardinality(v_ids) = 0 then 'completed' else 'pending' end,
    'developer', p_actor_user_id, v_now, v_ids,
    case when cardinality(v_ids) = 0 then v_now end,
    case when cardinality(v_ids) = 0 then 0 end)
  returning id into v_reset_id;

  insert into public.admin_developer_audit (action, target_user_id, actor_user_id, previous_role, new_role, created_at)
    values ('removed', p_target_user_id, p_actor_user_id, 'developer', null, v_now);
  insert into public.admin_team_audit (action, actor_user_id, target_user_id, old_role, new_role, created_at)
    values ('access_removed', p_actor_user_id, p_target_user_id, 'developer', null, v_now);

  return jsonb_build_object('ok', true, 'removedAt', v_now, 'revokedInvitations', v_revoked,
    'lastDeveloper', v_last, 'mfaResetId', v_reset_id, 'mfaFactorCount', cardinality(v_ids));
end;
$$;
alter function public.admin_remove_developer(uuid, uuid) owner to postgres;

-- ---------------------------------------------------------------------------------------------
-- 3. Permisos: solo service_role
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.admin_remove_developer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_remove_developer(uuid, uuid) to service_role;
