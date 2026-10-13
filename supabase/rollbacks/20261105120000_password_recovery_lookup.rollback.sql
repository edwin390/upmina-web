-- ROLLBACK de 20261105120000_password_recovery_lookup.sql. Solo local/operador: NO es una migración y no se aplica sola.
-- No hay datos que conservar: las tablas solo contienen contadores efímeros y la sal. Tras el rollback, el backend de
-- «Olvidé mi contraseña» (acción password-recovery de /api/profile) responde 502 y la pantalla muestra el error genérico
-- mientras VITE_PASSWORD_RECOVERY_LOOKUP esté activo; apagarlo devuelve el flujo neutro anterior.
drop function if exists public.auth_email_lookup(text, text, text);
drop function if exists public.auth_lookup_hit_(text, text, interval, integer, timestamptz);
drop table if exists public.auth_lookup_limits;
drop table if exists public.auth_lookup_salt;
