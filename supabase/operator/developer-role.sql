-- Developer Panel V1 — PROCEDIMIENTOS DEL OPERADOR (emergencia y configuración).
--
-- NO es una migración y ninguna herramienta del proyecto lo ejecuta (ni tests, ni build, ni dev). Lo
-- ejecuta una persona, a mano, en el editor SQL de Supabase (rol propietario `postgres`), SOLO tras la
-- autorización expresa del propietario del proyecto. Las funciones operator_* NO son ejecutables por
-- service_role ni por ningún rol de API: ni el backend de la aplicación, ni un Admin, ni un Developer
-- pueden usarlas; solo quien tenga acceso de propietario a la base de datos.
--
-- IMPORTANTE — el rol Developer YA NO se asigna aquí. operator_grant_developer se retiró (migración
-- 20261102120000). El camino normal es:
--   1. Un Admin invita a la persona como ADMIN (panel de equipo) y esta completa la activación y su TOTP.
--   2. Esa persona usa «Convertirme en Developer» en su panel Admin (solo transfiere SU PROPIA cuenta, con
--      otro Admin elegible, sin recuperaciones activas, aceptación explícita y TOTP reciente).
--   3. Otro Admin puede devolver a un Developer a Admin o Moderador desde la gestión del equipo.
-- Este archivo solo conserva (a) la revocación de emergencia y (b) la configuración de la espera de seguridad.
--
-- Sustituye SOLO los marcadores <...>. Mientras queden marcadores, las sentencias fallan al convertir
-- el texto a uuid y no hacen nada. No pegues identificadores ni notas en chats, tickets ni logs.

-- 0) Comprobación de solo lectura (no modifica nada): rol actual y factores verificados de la cuenta.
select ar.role,
       (select count(*) from auth.mfa_factors f
         where f.user_id = ar.user_id and f.factor_type::text = 'totp' and f.status::text = 'verified') as totp_verificados
  from public.admin_roles ar
 where ar.user_id = '<ID_DE_LA_CUENTA>'::uuid;

-- 1) REVOCACIÓN DE EMERGENCIA: developer -> moderator (nunca borra el acceso). Úsala solo si ningún Admin
--    elegible puede restaurar a un Developer desde el panel. Deja una fila en admin_developer_audit.
-- select public.operator_revoke_developer('<ID_DE_LA_CUENTA>'::uuid, '<motivo breve>');

-- 2) ESPERA DE SEGURIDAD antes de que un Developer recién transferido pueda APROBAR recuperaciones
--    excepcionales (0–10080 minutos). La fuente de configuración es la tabla admin_developer_settings:
--      * sin fila, el valor por defecto es CONSERVADOR: 1440 min (24 h). La migración no fija otro valor;
--      * DEV usa 60 min, que se configura de forma EXPLÍCITA aquí (nunca se aplica solo a Production);
--      * el cambio afecta a los Developers existentes (se evalúa con el valor vigente sobre su última
--        transferencia): bajarlo habilita antes a quien ya esperaba; subirlo vuelve a bloquear a quien ya podía;
--      * cada cambio queda en admin_developer_settings_audit (valor anterior, valor nuevo y nota).
-- select public.operator_set_developer_cooldown(60, '<motivo breve, p. ej. DEV 60 min>');

-- 3) Verificación posterior (solo lectura).
-- select key, int_value, updated_at from public.admin_developer_settings;
-- select key, old_value, new_value, note, created_at from public.admin_developer_settings_audit order by created_at desc;
-- select action, previous_role, new_role, created_at from public.admin_developer_audit
--  where target_user_id = '<ID_DE_LA_CUENTA>'::uuid order by created_at desc;

-- Si el Developer pierde su autenticador:
--   * Pide la recuperación normal desde /admin/mfa/recovery (fase 2): la aprueba un ADMIN elegible y
--     conserva el rol Developer. No hay aprobación excepcional para un Developer.
--   * Si no hubiera ningún admin elegible, el propietario del proyecto elimina el factor TOTP desde los
--     controles de Supabase (Authentication > Users > la cuenta > Factors) y la persona enrola uno nuevo
--     al volver a iniciar sesión.
