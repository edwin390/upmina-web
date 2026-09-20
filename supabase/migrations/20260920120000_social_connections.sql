-- Conexiones OAuth de redes sociales (por ahora solo TikTok), a nivel de sitio.
--
-- SEGURIDAD: esta tabla guarda access_token y refresh_token en claro. Solo debe leerla
-- y escribirla código de servidor (Vercel Functions) con la service_role key.
--   * RLS activado y FORZADO, sin ninguna policy: anon y authenticated no pasan.
--   * Además se revocan todos los privilegios a anon/authenticated/PUBLIC (defensa en
--     profundidad: Supabase concede por defecto acceso a estos roles en `public`).
--   * service_role omite RLS (BYPASSRLS), pero se le conceden privilegios explícitos.
-- No se añade NINGUNA policy para clientes; si algún día hiciera falta exponer datos de
-- conexión al frontend, hazlo con una vista/endpoint que excluya los tokens.

create table if not exists public.social_connections (
  id                       uuid primary key default gen_random_uuid(),
  provider                 text not null check (provider in ('tiktok')),
  provider_user_id         text not null check (length(provider_user_id) > 0),
  access_token             text not null check (length(access_token) > 0),
  refresh_token            text not null check (length(refresh_token) > 0),
  access_token_expires_at  timestamptz not null,
  refresh_token_expires_at timestamptz not null,
  scope                    text not null default '',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.social_connections is
  'Conexiones OAuth del sitio con redes sociales. Contiene tokens: solo acceso server-side (service_role).';

-- Una sola cuenta autorizada por proveedor: evita duplicados accidentales y permite
-- upsert con onConflict = provider. Autorizar otra cuenta reemplaza la anterior.
create unique index if not exists social_connections_provider_key
  on public.social_connections (provider);

-- updated_at siempre al día en cada UPDATE (incluido el de un upsert).
create or replace function public.set_social_connections_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists social_connections_set_updated_at on public.social_connections;
create trigger social_connections_set_updated_at
  before update on public.social_connections
  for each row execute function public.set_social_connections_updated_at();

-- Protección contra acceso desde cliente.
alter table public.social_connections enable row level security;
alter table public.social_connections force row level security;

revoke all on table public.social_connections from public;
revoke all on table public.social_connections from anon;
revoke all on table public.social_connections from authenticated;
grant select, insert, update, delete on table public.social_connections to service_role;

revoke all on function public.set_social_connections_updated_at() from public;
revoke all on function public.set_social_connections_updated_at() from anon;
revoke all on function public.set_social_connections_updated_at() from authenticated;
