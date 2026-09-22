-- Instagram en social_connections.
--
-- Instagram (API con Instagram Login) no tiene un refresh token separado: el propio access
-- token largo (~60 días) se renueva con `ig_refresh_token`. Por eso las columnas de refresh
-- pasan a admitir NULL, pero SOLO para Instagram: un CHECK por proveedor conserva para
-- TikTok exactamente la garantía anterior (ambas columnas obligatorias) e impide guardar
-- valores ficticios en Instagram.
--
-- NO cambia: RLS activado y forzado, ausencia de policies, revoke/grants (solo service_role),
-- primary key, índice único por proveedor, trigger de updated_at, refresh_lock_until, ni los
-- CHECK social_connections_access_token_check, social_connections_provider_user_id_check y
-- social_connections_refresh_token_check (con refresh_token NULL este último no rechaza la
-- fila: un CHECK que evalúa a NULL se acepta). No modifica ninguna fila.
--
-- Nombres verificados contra el Supabase real (PostgreSQL 17.6). Idempotente.

-- 1) provider: admite 'instagram' además de 'tiktok'.
alter table public.social_connections
  drop constraint if exists social_connections_provider_check;
alter table public.social_connections
  add constraint social_connections_provider_check
  check (provider in ('tiktok', 'instagram'));

-- 2) Las columnas de refresh admiten NULL (Instagram no tiene refresh token separado).
alter table public.social_connections
  alter column refresh_token drop not null;
alter table public.social_connections
  alter column refresh_token_expires_at drop not null;

-- 3) Forma por proveedor: TikTok conserva ambas columnas obligatorias; Instagram, ambas NULL.
alter table public.social_connections
  drop constraint if exists social_connections_provider_shape_check;
alter table public.social_connections
  add constraint social_connections_provider_shape_check
  check (
    (provider = 'tiktok'
       and refresh_token is not null
       and refresh_token_expires_at is not null)
    or
    (provider = 'instagram'
       and refresh_token is null
       and refresh_token_expires_at is null)
  );

comment on table public.social_connections is
  'Conexiones OAuth del sitio con redes sociales (TikTok, Instagram). Contiene tokens: solo acceso server-side (service_role).';
comment on column public.social_connections.refresh_token is
  'Refresh token separado. NULL para Instagram, cuyo access token largo se renueva a sí mismo.';
comment on column public.social_connections.refresh_token_expires_at is
  'Caducidad del refresh token. NULL para Instagram (su caducidad es access_token_expires_at).';
