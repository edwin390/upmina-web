-- Aceptación de documentos legales y declaración de mayoría de edad (18+) en el registro. Siembra la v1.0 vigente de los 4
-- documentos; legal_settings.enforce_signup queda en false (se activa como paso operativo aparte).
--
-- Diseño:
--   * legal_document_versions: versiones publicadas por la persona operadora (vacía = nada es exigible).
--   * legal_settings.enforce_signup (false por defecto): si es true, un alta SIN las tres aceptaciones vigentes se rechaza.
--     Con false, el trigger solo REGISTRA las aceptaciones válidas que lleguen y nunca bloquea nada.
--   * legal_acceptances: (user_id, document, version, accepted_at). Sin IP, sin agente de usuario, sin correo. Sin FK a
--     auth.users a propósito: la conservación de esta evidencia tras eliminar la cuenta es una decisión jurídica pendiente.
--   * La metadata de alta (raw_user_meta_data->'legal_acceptance') la controla el cliente: es una DECLARACIÓN del
--     reconocimiento, validada contra las versiones vigentes; nada de autorización (roles, permisos) se deriva de ella.
--   * Usuarios existentes: no se tocan ni se bloquean. Una futura versión nueva requerirá un aviso/aceptación posterior a
--     iniciar sesión (no implementado aquí) sin impedir acceso a datos ni ejercicio de derechos.
create table public.legal_document_versions (
  document   text not null check (document in ('adult_declaration', 'terms', 'privacy', 'community_rules')),
  version    text not null check (version ~ '^v[0-9]+(\.[0-9]+)*$'),
  is_current boolean not null default false,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (document, version)
);
create unique index legal_document_versions_one_current on public.legal_document_versions (document) where is_current;

create table public.legal_settings (
  singleton boolean primary key default true check (singleton),
  enforce_signup boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.legal_settings default values;

create table public.legal_acceptances (
  user_id     uuid not null,
  document    text not null,
  version     text not null,
  accepted_at timestamptz not null default now(),
  source      text not null default 'signup' check (source in ('signup')),
  primary key (user_id, document, version),
  foreign key (document, version) references public.legal_document_versions (document, version)
);

alter table public.legal_document_versions enable row level security;
alter table public.legal_document_versions force row level security;
alter table public.legal_settings enable row level security;
alter table public.legal_settings force row level security;
alter table public.legal_acceptances enable row level security;
alter table public.legal_acceptances force row level security;
revoke all on public.legal_document_versions, public.legal_settings, public.legal_acceptances
  from public, anon, authenticated;
grant select on public.legal_document_versions, public.legal_settings, public.legal_acceptances to service_role;

create function public.legal_record_signup_acceptance()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_meta jsonb := case when jsonb_typeof(new.raw_user_meta_data -> 'legal_acceptance') = 'object'
                       then new.raw_user_meta_data -> 'legal_acceptance' else '{}'::jsonb end;
  v_doc text; v_ok integer := 0;
begin
  foreach v_doc in array array['adult_declaration', 'terms', 'privacy', 'community_rules'] loop
    if exists (select 1 from public.legal_document_versions d
                where d.document = v_doc and d.is_current and d.approved_at is not null
                  and d.version = v_meta ->> v_doc) then
      insert into public.legal_acceptances (user_id, document, version)
        values (new.id, v_doc, v_meta ->> v_doc) on conflict do nothing;
      v_ok := v_ok + 1;
    end if;
  end loop;
  if v_ok < 4 and (select enforce_signup from public.legal_settings) then
    raise exception 'legal_acceptance_required' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
alter function public.legal_record_signup_acceptance() owner to postgres;
revoke all on function public.legal_record_signup_acceptance() from public, anon, authenticated;

create trigger legal_record_signup_acceptance
  after insert on auth.users
  for each row execute function public.legal_record_signup_acceptance();

insert into public.legal_document_versions (document, version, is_current, approved_at) values
  ('adult_declaration', 'v1.0', true, now()),
  ('terms', 'v1.0', true, now()),
  ('privacy', 'v1.0', true, now()),
  ('community_rules', 'v1.0', true, now());
