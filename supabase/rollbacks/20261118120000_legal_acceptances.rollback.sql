drop trigger if exists legal_record_signup_acceptance on auth.users;
drop function if exists public.legal_record_signup_acceptance();
drop table if exists public.legal_acceptances;
drop table if exists public.legal_settings;
drop table if exists public.legal_document_versions;
