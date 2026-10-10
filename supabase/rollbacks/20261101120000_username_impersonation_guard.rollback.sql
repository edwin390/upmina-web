-- ROLLBACK de 20261101120000_username_impersonation_guard.sql (NO es una migración).
--
-- Vive fuera de supabase/migrations a propósito: `supabase db push` no la ve ni la aplica. Si hiciera
-- falta, se copia a una MIGRACIÓN NUEVA con timestamp posterior (nunca se edita la ya aplicada) y se
-- aplica con autorización explícita. Procedimiento completo: docs/USERNAME-IMPERSONATION-GUARD.md.
--
-- Qué hace: desactiva la protección (quita los triggers de public.profiles y las funciones de detección y de
-- excepciones). Qué NO hace: no toca filas de profiles, auth.users, admin_roles, roles/privilegios de
-- usuarios, ni nada de media/R7/cron/moderación. Es idempotente.
--
-- Las tablas username_reservation_grants y username_reservation_audit (y su trigger append-only) se
-- CONSERVAN: son el registro de auditoría. Si se quisieran eliminar (decisión explícita), usar el bloque
-- opcional del final.

drop trigger if exists profiles_guard_reserved_identity_insert on public.profiles;
drop trigger if exists profiles_guard_reserved_identity_update on public.profiles;

drop function if exists public.profiles_guard_reserved_identity();
drop function if exists public.community_identity_reservation_grant(uuid, uuid, text, text, text);
drop function if exists public.community_identity_reservation_revoke(uuid, uuid, text);
drop function if exists public.community_assert_identity_allowed(uuid, text, text);
drop function if exists public.community_identity_grant_value(text, text);
drop function if exists public.community_username_impersonation(text);
drop function if exists public.community_display_name_impersonation(text);
drop function if exists public.community_identity_impersonation(text, text);
drop function if exists public.community_username_within_one_edit(text, text);
drop function if exists public.community_username_skeleton(text, boolean);

-- OPCIONAL (destruye la auditoría; no ejecutar sin decisión expresa):
-- drop table if exists public.username_reservation_grants;
-- drop trigger if exists username_reservation_audit_no_update_delete on public.username_reservation_audit;
-- drop trigger if exists username_reservation_audit_no_truncate on public.username_reservation_audit;
-- drop table if exists public.username_reservation_audit;
-- drop function if exists public.username_reservation_audit_append_only();
