-- profiles: identidad PÚBLICA de una cuenta de Upmina Web (base para Comunidad:
-- publicaciones, comentarios, videos, página pública de usuario). Es una tabla
-- deliberadamente SEPARADA de:
--   * auth.users  — identidad/credenciales (Supabase Auth). El email, la contraseña, los
--                   factores MFA y los tokens siguen viviendo SOLO allí; nada de eso se
--                   copia aquí.
--   * admin_roles — privilegios (ADMIN/MODERATOR), autoridad server-side. NO existe
--                   ninguna FK, columna ni join entre profiles y admin_roles: ambas solo
--                   comparten, de forma independiente, la referencia a auth.users. Tener
--                   perfil no implica privilegios, ni tener un rol implica tener perfil.
--
-- Esta tabla NO contiene role/admin/moderator/is_admin/email/claims/metadata de Auth.
--
-- ESCRITURA (decisión de esta primera versión): NO hay escritura directa desde el
-- navegador. anon y authenticated solo pueden LEER (perfiles públicos); la creación y
-- cualquier modificación futura pasan por endpoints server-side (service_role), donde
-- vivirán las reglas que no pertenecen a la base de datos: nombres reservados, cooldown
-- y historial de cambios de username, tombstones, rate limiting y moderación.

-- `create table` SIN `if not exists` a propósito: esta migración debe aplicarse exactamente
-- una vez y, si ya existiera una tabla `profiles` distinta (p. ej. creada a mano siguiendo
-- el esquema antiguo de docs/ARCHITECTURE.md, que incluía una columna `role`), tiene que
-- FALLAR de forma visible en vez de continuar en silencio sobre una tabla ajena.
create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  username     text not null,
  display_name text,
  bio          text,
  avatar_path  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Unicidad sobre el valor YA normalizado (minúsculas, ver check de formato): no hace
  -- falta citext ni un índice funcional, y "Mina"/"mina" no pueden coexistir porque
  -- "Mina" ni siquiera es un valor válido.
  constraint profiles_username_key unique (username),

  -- Solo ASCII en minúsculas, dígitos y guion bajo, 3 a 20 caracteres. ASCII puro evita
  -- homoglifos (cirílico, etc.) como vector de impersonación. `$` en Postgres solo
  -- coincide con el final real del texto (no antes de un salto de línea final).
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),

  -- Nombre visible (presentación, NO identidad técnica): 1 a 40 caracteres, no solo
  -- espacios, sin caracteres de control. Admite Unicode.
  constraint profiles_display_name_length check (
    display_name is null
    or (char_length(display_name) between 1 and 40 and btrim(display_name) <> '')
  ),
  constraint profiles_display_name_no_control_chars check (
    display_name is null or display_name !~ '[[:cntrl:]]'
  ),

  -- Texto plano; el límite acota abuso y tamaño. La sanitización/render pertenece a la
  -- capa de producto, no a la base de datos.
  constraint profiles_bio_length check (bio is null or char_length(bio) <= 280),

  -- Solo una RUTA de objeto futura (p. ej. dentro de un bucket de avatares): nunca una
  -- URL completa (con esquema) ni binarios. La pertenencia de la ruta al dueño se validará
  -- cuando exista el sistema real de avatares.
  constraint profiles_avatar_path_shape check (
    avatar_path is null
    or (
      char_length(avatar_path) between 1 and 255
      and avatar_path !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and avatar_path !~ '^//'
      and avatar_path !~ '[[:cntrl:]]'
    )
  )
);

comment on table public.profiles is
  'Perfil público de una cuenta (identidad pública de Comunidad). Separado de auth.users y de admin_roles: no contiene email, roles ni datos de Auth. Lectura pública; escritura solo server-side (service_role).';
comment on column public.profiles.user_id is
  'PK y FK a auth.users(id) ON DELETE CASCADE: el perfil desaparece con la cuenta. Inmutable tras la creación (ver trigger profiles_before_update).';
comment on column public.profiles.username is
  'Identidad pública técnica (@username), guardada normalizada en minúsculas. Único. Formato ^[a-z0-9_]{3,20}$. Nombres reservados, cooldown e historial de cambios se resuelven en la capa server-side, no aquí.';
comment on column public.profiles.display_name is
  'Nombre visible opcional (presentación, no identidad). 1 a 40 caracteres, no solo espacios, sin caracteres de control.';
comment on column public.profiles.bio is
  'Bio opcional en texto plano, máximo 280 caracteres.';
comment on column public.profiles.avatar_path is
  'Ruta de objeto del avatar (futuro), NUNCA una URL completa ni binarios. Máximo 255 caracteres.';
comment on column public.profiles.updated_at is
  'Se mantiene automáticamente en cada UPDATE (trigger profiles_before_update); no se confía en el valor que envíe quien escribe.';

-- Trigger BEFORE UPDATE con dos responsabilidades:
--   1. Inmutabilidad de user_id: rechaza cualquier UPDATE que lo cambie. Hoy no hay
--      UPDATE desde el navegador, pero la invariante debe sobrevivir a futuros cambios de
--      grants/policies y a errores server-side (el trigger aplica también a service_role).
--   2. updated_at: lo fija SIEMPRE a now(), ignorando el valor que venga en el UPDATE.
--
-- NO es SECURITY DEFINER: solo lee/modifica la fila NEW y no toca ninguna otra tabla, así
-- que no necesita privilegios elevados (y no debe tenerlos). search_path fijado a
-- pg_catalog por higiene (solo usa now(), de pg_catalog).
-- (`create function` sin `or replace`, por la misma razón que la tabla.)
create function public.profiles_before_update()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'profiles_user_id_immutable';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function public.profiles_before_update() is
  'Trigger BEFORE UPDATE de profiles: impide cambiar user_id y fija updated_at = now().';

-- Solo el motor invoca la función como trigger (el privilegio EXECUTE se comprueba al
-- crear el trigger, no al dispararlo); nadie necesita EXECUTE directo. Se revoca también
-- de anon/authenticated de forma explícita porque Supabase concede EXECUTE por defecto a
-- esos roles en `public` (mismo patrón que consume_admin_invitation).
revoke all on function public.profiles_before_update() from public;
revoke execute on function public.profiles_before_update() from anon;
revoke execute on function public.profiles_before_update() from authenticated;

create trigger profiles_before_update
  before update on public.profiles
  for each row
  execute function public.profiles_before_update();

-- Seguridad: RLS activado y FORZADO (misma convención que admin_roles/admin_invitations/
-- social_connections) y revocación de los grants por defecto de Supabase en `public`
-- (defensa en profundidad), para partir de "nadie puede nada" y conceder solo lo
-- necesario a continuación.
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

revoke all on table public.profiles from public;
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;

-- LECTURA: los perfiles son públicos (anon y authenticated), todos sus campos.
grant select on table public.profiles to anon, authenticated;

create policy profiles_select_public
  on public.profiles
  for select
  to anon, authenticated
  using (true);

-- ESCRITURA: deliberadamente SIN INSERT/UPDATE/DELETE para anon ni authenticated (ni
-- grant ni policy). service_role (exclusivamente server-side) puede leer, crear,
-- modificar y eliminar. El flujo normal de eliminación de un perfil es la cascada desde
-- auth.users (ON DELETE CASCADE); el DELETE explícito de service_role existe solo para
-- operaciones server-side privilegiadas, mantenimiento y futuros flujos administrativos,
-- nunca para el navegador. service_role omite RLS (BYPASSRLS) como en las demás tablas
-- privilegiadas, por lo que no necesita policy.
grant select, insert, update, delete on table public.profiles to service_role;
