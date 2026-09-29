-- 9J-1B: extiende profiles (identidad pública ya existente) con el formato de username
-- congelado para Comunidad y el soporte de cambio de username con cooldown. NO crea una
-- tabla de identidad paralela: profiles sigue siendo la única fuente de identidad pública.
--
-- Cambios:
--   1. Sustituye profiles_username_format (^[a-z0-9_]{3,20}$, sin puntos) por el formato
--      congelado: 3-24 caracteres, a-z/0-9/_/., sin punto inicial/final, sin puntos
--      consecutivos. La unicidad (profiles_username_key) y la normalización a minúsculas
--      no cambian: siguen viviendo sobre el valor ya canonicalizado por la capa server-side
--      (checkUsername), igual que antes.
--   2. Añade username_changed_at timestamptz NULL. NULL = el username nunca se cambió
--      después de la creación inicial del perfil (la creación NO arranca el cooldown). Un
--      cambio de username exitoso fija esta columna a la hora del SERVIDOR (now()); el
--      cooldown de 30 días se calcula y aplica en la capa server-side (profile-handlers.ts),
--      no aquí — igual que el resto de reglas de negocio de username (reservados, historial)
--      ya vivían fuera de SQL antes de esta migración.
--
-- Todo lo demás se preserva sin tocar: PK/FK a auth.users, RLS + FORCE, la única policy
-- profiles_select_public (lectura pública sin cambios), el modelo de escritura exclusivo de
-- service_role (sin nuevos grants a anon/authenticated), la inmutabilidad de user_id y el
-- trigger profiles_before_update (updated_at sigue fijándose ahí, sin relación con
-- username_changed_at, que la capa de aplicación fija explícitamente en el UPDATE de cambio
-- de username).

alter table public.profiles
  drop constraint profiles_username_format;

-- POSIX ERE (el operador ~ de Postgres no soporta lookaround): el formato se expresa como
-- la conjunción de cuatro condiciones en vez de una sola expresión con negative lookahead.
alter table public.profiles
  add constraint profiles_username_format check (
    username ~ '^[a-z0-9_.]{3,24}$'
    and left(username, 1) <> '.'
    and right(username, 1) <> '.'
    and username !~ '\.\.'
  );

comment on column public.profiles.username is
  'Identidad pública técnica (@username), guardada normalizada en minúsculas. Único. Formato: 3-24 caracteres a-z/0-9/_/., sin punto inicial/final ni puntos consecutivos (ver profiles_username_format). Nombres reservados y cooldown de cambio se resuelven en la capa server-side, no aquí.';

alter table public.profiles
  add column username_changed_at timestamptz;

comment on column public.profiles.username_changed_at is
  'NULL = el username nunca se cambió tras la creación inicial del perfil (crear perfil NO arranca el cooldown). Un cambio de username exitoso la fija a la hora del servidor. La capa server-side (profile-handlers.ts) exige que hayan pasado >= 30 días desde este valor antes de permitir otro cambio; no hay enforcement de cooldown en SQL.';
