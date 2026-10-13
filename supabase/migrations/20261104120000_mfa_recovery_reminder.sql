-- MFA FASE 2 — RECORDATORIO del aviso de aprobación. PROPUESTA LOCAL: NO aplicada en ningún entorno.
-- Forward-only, posterior a 20261103120000 (que no se modifica).
--
-- Problema: «Reenviar aviso» solo puede reenviar el aviso de aprobación mientras NO esté entregado (reenviarlo
-- rota el enlace de cancelación y, una vez entregado, reiniciaría la espera de 15 minutos porque la espera se mide
-- desde la entrega del ÚLTIMO aviso de tipo 'approved'). El enlace original no se puede reenviar: solo se guarda su hash.
--
-- Decisiones (una frase cada una):
--   * Nuevo tipo de correo 'reminder', INDEPENDIENTE del de aprobación: admin_mfa_recovery_ready_at/readiness y el
--     estado del aviso de las listas solo miran kind = 'approved', así que un recordatorio NO cambia el estado de la
--     recuperación, NO reinicia la espera de 15 minutos y NO toca el enlace de cancelación (no se rota ni se
--     reenvía; el recordatorio no lleva ningún enlace de cancelación).
--   * admin_mfa_recovery_reminder_start(recovery) decide y reserva el envío bajo el bloqueo de la fila de la
--     recuperación: solo con la recuperación en 'approved' y vigente cuyo aviso de aprobación YA está entregado
--     (readiness 'waiting' o 'ready'); máximo 3 recordatorios (los fallidos no cuentan para el máximo) y al menos
--     60 s entre dos recordatorios (cuentan todos los intentos). Nunca tras cancelación, ejecución, cierre o
--     finalización (status distinto de 'approved').
--   * La reserva inserta la fila de correo con clave de idempotencia 'recovery:<id>:reminder:<n>'; el envío y el
--     registro del resultado reutilizan admin_mfa_recovery_mail_start / _result y la verificación de entrega por el
--     webhook firmado (el evento queda como 'mail_state' con detalle 'reminder:accepted|delivered|failed').
--   * AUDITORÍA del solicitante: la función recibe el actor (Admin o Developer, del JWT verificado en el backend), lo
--     revalida bajo el lock de roles (que sea Admin o Developer vigente y no el titular de la solicitud) y registra en
--     admin_mfa_recovery_events —la infraestructura de auditoría existente, sin tocar su restricción— un evento
--     'mail_state' con actor_user_id = el solicitante y detalle 'reminder:requested'. Los eventos de envío y entrega del
--     proveedor ('reminder:accepted|delivered|failed') siguen registrándose como hasta ahora.
--   * Garantía sobre la carrera cancelación/envío (ver docs): la reserva y la comprobación del estado ocurren en UNA
--     transacción con la fila bloqueada; tras confirmarse una cancelación NO se puede reservar ningún recordatorio nuevo.
--     Un recordatorio ya reservado y entregado al proveedor no puede retirarse.
--   * Solo service_role.
-- Rollback (solo local/operador): supabase/rollbacks/20261104120000_mfa_recovery_reminder.rollback.sql

alter table public.admin_mfa_recovery_mail drop constraint admin_mfa_recovery_mail_kind_check;
alter table public.admin_mfa_recovery_mail add constraint admin_mfa_recovery_mail_kind_check
  check (kind in ('challenge', 'approved', 'closed', 'completed', 'reminder'));

create function public.admin_mfa_recovery_reminder_start(p_recovery_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  r public.admin_mfa_recoveries;
  v_ready text;
  v_sent integer;
  v_total integer;
  v_last timestamptz;
  v_key text;
begin
  if p_recovery_id is null or p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  -- El lock compartido de roles va PRIMERO (regla de 9B).
  perform public.upmina_lock_admin_roles();
  if not exists (select 1 from public.admin_roles ar
                  where ar.user_id = p_actor_user_id and ar.role in ('admin', 'developer')) then
    raise exception 'actor_not_admin';
  end if;
  select * into r from public.admin_mfa_recoveries where id = p_recovery_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.user_id = p_actor_user_id then return jsonb_build_object('ok', false, 'reason', 'self_approval'); end if;
  -- Solo mientras la recuperación está aprobada y pendiente de ejecutar.
  if r.status <> 'approved' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  v_ready := public.admin_mfa_recovery_readiness(r.id);
  if v_ready in ('notice_pending', 'notice_failed') then
    -- El aviso de aprobación aún no se entregó: para eso existe el reenvío normal (que rota el enlace).
    return jsonb_build_object('ok', false, 'reason', 'notice_not_delivered');
  end if;
  if v_ready not in ('waiting', 'ready') then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  select count(*) filter (where m.state <> 'failed'), count(*), max(m.created_at)
    into v_sent, v_total, v_last
    from public.admin_mfa_recovery_mail m
   where m.recovery_id = r.id and m.kind = 'reminder';
  if v_sent >= 3 then return jsonb_build_object('ok', false, 'reason', 'reminder_limit'); end if;
  if v_last is not null and v_last > clock_timestamp() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon',
      'retryAfterSeconds', ceil(extract(epoch from (v_last + interval '60 seconds' - clock_timestamp())))::integer);
  end if;
  v_key := 'recovery:' || r.id::text || ':reminder:' || (v_total + 1)::text;
  insert into public.admin_mfa_recovery_mail (recovery_id, kind, idempotency_key)
    values (r.id, 'reminder', v_key);
  perform public.admin_mfa_recovery_log(r.id, r.user_id, 'mail_state', p_actor_user_id, 'reminder:requested');
  return jsonb_build_object('ok', true, 'recoveryId', r.id, 'baseKey', v_key, 'number', v_total + 1,
    'email', (select u.email::text from auth.users u where u.id = r.user_id));
end;
$$;
alter function public.admin_mfa_recovery_reminder_start(uuid, uuid) owner to postgres;

revoke execute on function public.admin_mfa_recovery_reminder_start(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_mfa_recovery_reminder_start(uuid, uuid) to service_role;
