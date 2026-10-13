-- ROLLBACK de 20261108120000_copyright_events_immutable_revoke.sql (NO es una migración: vive fuera de supabase/migrations).
-- Restaura el EXECUTE por defecto que tenía la función antes del REVOKE. Solo permisos; no toca datos.
grant execute on function public.copyright_claim_events_immutable() to public;
