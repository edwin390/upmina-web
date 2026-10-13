-- COPY-1 fase 2A (cierre): copyright_claim_events_immutable() es una función de DISPARADOR y no debe ser ejecutable por ningún rol.
-- La migración 20261107120000 (ya aplicada) olvidó este REVOKE, de modo que heredaba el EXECUTE por defecto de public.
-- Cambio mínimo: solo permisos. No toca el cuerpo de la función, los disparadores, las tablas ni los datos.
-- (Un disparador no necesita EXECUTE del rol que escribe: el privilegio solo se comprueba al crear el disparador.)

revoke all on function public.copyright_claim_events_immutable()
  from public, anon, authenticated, service_role;
