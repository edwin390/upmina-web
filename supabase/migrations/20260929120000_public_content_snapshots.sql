-- public_content_snapshots: último contenido público NORMALIZADO y válido de cada recurso
-- (Fase 9H-4, "last-known-good"). Con él, un endpoint público podrá seguir respondiendo cuando un
-- proveedor (Twitch, YouTube, Instagram, TikTok) falle de forma transitoria (timeout, 429, 5xx).
--
-- Es una caché de resiliencia, NO una fuente de verdad ni un archivo histórico:
--   * Una fila por recurso canónico (resource es la PK) y la lista de recursos está CERRADA por
--     un CHECK: como máximo 8 filas. Escribir es un upsert (la última escritura válida gana), así
--     que no hay limpieza, cron ni índices adicionales. Las filas caducadas las ignora la lectura
--     (edad máxima por recurso, en src/lib/public-snapshot-resources.ts) y se sobrescriben en el
--     siguiente éxito del proveedor.
--   * NO existe snapshot de twitch-status (un LIVE/OFFLINE rancio miente) ni de
--     instagram-media/instagram-comments (por publicación y con URLs firmadas).
--
-- source_id ata el snapshot a su FUENTE (canal de Twitch/YouTube configurado, o la conexión social
-- `<provider>:<id de la conexión>:<provider_user_id>`): un snapshot de otra fuente no se sirve.
-- Nunca sale por la API pública. Longitud acotada.
--
-- payload es SOLO la respuesta pública normalizada (jsonb objeto o array; ver los validadores):
-- nunca tokens, cabeceras, cookies, OAuth state, credenciales ni respuestas crudas del proveedor.
-- Tope de tamaño: 262 144 bytes del texto de jsonb (256 KiB). Los payloads reales miden 1–7 KB; el
-- tope es holgado porque el peor caso teórico de YouTube (24 Shorts con descripción de hasta
-- 5 000 caracteres) supera los 64 KiB, y un tope menor desactivaría en silencio el snapshot de un
-- canal con descripciones largas. El código escribe con un margen menor (200 000 bytes de JSON
-- compacto), de modo que este CHECK es la última red, no el límite habitual.
--
-- SEGURIDAD: mismo patrón que el resto de tablas privilegiadas -- RLS activado y FORZADO, sin
-- ninguna policy, sin acceso para PUBLIC/anon/authenticated. Solo service_role, con los
-- privilegios que usa el módulo: SELECT (leer), INSERT y UPDATE (el upsert exige ambos) y DELETE
-- (borrar los snapshots de una red social al desconectarla). Sin funciones, triggers ni
-- SECURITY DEFINER.

create table public.public_content_snapshots (
  resource     text primary key,
  source_id    text        not null,
  payload      jsonb       not null,
  captured_at  timestamptz not null default now(),

  constraint public_content_snapshots_resource_check
    check (resource in (
      'twitch-clips',
      'twitch-latest-video',
      'youtube-latest',
      'youtube-videos',
      'youtube-shorts',
      'instagram-feed',
      'instagram-profile',
      'tiktok-videos'
    )),
  constraint public_content_snapshots_source_id_length
    check (char_length(source_id) between 1 and 200),
  -- Solo un objeto o un array: nunca un escalar (p. ej. el texto "hello").
  constraint public_content_snapshots_payload_type
    check (jsonb_typeof(payload) in ('object', 'array')),
  constraint public_content_snapshots_payload_size
    check (octet_length(payload::text) <= 262144)
);

comment on table public.public_content_snapshots is
  'Último contenido público normalizado y válido por recurso (last-known-good, máx. 8 filas). Caché de resiliencia: nunca tokens ni respuestas crudas. Acceso exclusivo server-side (service_role).';
comment on column public.public_content_snapshots.resource is
  'Recurso canónico (lista cerrada por CHECK). twitch-status, instagram-media e instagram-comments no existen.';
comment on column public.public_content_snapshots.source_id is
  'Fuente del snapshot: canal configurado o conexión social. Un snapshot de otra fuente no se sirve. No se expone públicamente.';
comment on column public.public_content_snapshots.payload is
  'Respuesta pública normalizada (objeto o array). Se revalida al leer: la fila no es de fiar.';

alter table public.public_content_snapshots enable row level security;
alter table public.public_content_snapshots force row level security;

revoke all on table public.public_content_snapshots from public;
revoke all on table public.public_content_snapshots from anon;
revoke all on table public.public_content_snapshots from authenticated;
-- Supabase concede por defecto TODOS los privilegios a service_role sobre las tablas nuevas
-- de `public` (incluidos TRUNCATE, REFERENCES y TRIGGER). Se revoca todo y se concede solo lo
-- necesario.
revoke all on table public.public_content_snapshots from service_role;
grant select, insert, update, delete on table public.public_content_snapshots to service_role;
