-- Fundación de Cosplay (Fase 9I-1): esquema de datos para el nuevo dominio público /cosplay y
-- la capa de metadatos de medios que 9I-2 (canal R2) y 9I-3 (editor ADMIN) usarán para
-- implementar la subida/normalización real. Esta migración NO crea funciones, triggers ni RPC:
-- 9I-1 no expone ninguna mutación (sin editor todavía), así que no hay nada que autorizar por
-- ahora. Las RPC de creación/edición/publicación/borrado llegan con 9I-3, siguiendo el mismo
-- patrón SECURITY DEFINER + lock de fila que ya usa el equipo (admin_team_roles_invariants).
--
-- Tres tablas, todas con el mismo patrón de seguridad que el resto de tablas privilegiadas del
-- proyecto (social_connections, admin_roles, public_content_snapshots): RLS activado y FORZADO,
-- CERO policies, solo service_role. La lectura pública NO llega por aquí: pasa por
-- /api/content/[resource] (Vercel Function con service_role), que filtra status='published' en
-- servidor. El navegador nunca tiene una policy para leer directamente estas tablas.
--
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- media_assets: metadatos de UN archivo de imagen normalizado (bytes en Cloudflare R2, fuera de
-- Supabase — nunca en Supabase Storage). Genérica a propósito: `domain` distingue qué módulo es
-- dueño de la fila (hoy solo 'cosplay'; Fase 9J añadirá 'community' con una migración propia que
-- amplíe el CHECK, igual que 20260926120000_admin_team_roles_invariants.sql amplió
-- admin_roles_role_check para añadir 'developer'). Así Cosplay y Community comparten el mismo
-- ciclo de vida de medios (reservado → listo → borrando) sin duplicar la tabla.
--
-- Ciclo de vida (Fase 9I-2 lo implementará; aquí solo se define la forma):
--   reserved  — autorización de subida emitida, bytes aún sin confirmar.
--   ready     — verificado por el procesador servidor (sharp/libheif): existe, es el mime/tamaño
--               esperado, sin EXIF/GPS, sRGB. Es el único estado que una galería puede referenciar
--               de forma útil.
--   deleting  — borrado solicitado; el reconciliador de 9I-2 confirma el borrado en R2 antes de
--               eliminar la fila.
-- `is_public` es la proyección real: si el objeto está hoy en el bucket público de R2 o solo en
-- el privado. Publicar una publicación de Cosplay mueve sus imágenes a público; despublicar las
-- retira. La existencia de la fila y `is_public` son cosas distintas a propósito (ver 9I-2).
--
-- create table SIN "if not exists" (igual que profiles, social_oauth_flows y admin_roles):
-- debe fallar de forma visible si ya existe, no ignorarlo en silencio.
create table public.media_assets (
  id                uuid primary key default gen_random_uuid(),
  domain            text not null,
  kind              text not null,
  status            text not null default 'reserved',
  is_public         boolean not null default false,
  mime              text not null,
  width             integer not null,
  height            integer not null,
  bytes             bigint not null,
  storage_key       text not null,
  pipeline_version  text not null,
  checksum_sha256   text,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint media_assets_domain_check check (domain in ('cosplay')),
  constraint media_assets_kind_check check (kind in ('image')),
  constraint media_assets_status_check check (status in ('reserved', 'ready', 'deleting')),
  -- Único formato de salida canónico decidido (spike de transporte multi-dispositivo, 9I):
  -- WebP sRGB sin metadatos. Ampliar esta lista es una migración nueva, no una edición de esta.
  constraint media_assets_mime_check check (mime in ('image/webp')),
  constraint media_assets_width_check check (width > 0 and width <= 10000),
  constraint media_assets_height_check check (height > 0 and height <= 10000),
  -- 8 MiB: techo de una variante ya normalizada (muy por encima de lo medido: w2560 real ronda
  -- 0.1-1.6 MB). El original sin normalizar NUNCA entra en esta tabla.
  constraint media_assets_bytes_check check (bytes > 0 and bytes <= 8388608),
  constraint media_assets_storage_key_length check (char_length(storage_key) between 1 and 512),
  constraint media_assets_pipeline_version_format
    check (pipeline_version ~ '^[a-z0-9][a-z0-9_.-]{0,31}$'),
  constraint media_assets_checksum_format
    check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  constraint media_assets_storage_key_unique unique (storage_key)
);

comment on table public.media_assets is
  'Metadatos de imágenes normalizadas (bytes en Cloudflare R2, nunca en Supabase). Genérica entre dominios (domain); hoy solo cosplay. Acceso exclusivo server-side (service_role).';
comment on column public.media_assets.domain is
  'Módulo dueño de la fila. Lista cerrada por CHECK; community (9J) la ampliará con su propia migración.';
comment on column public.media_assets.status is
  'reserved: autorizado, sin confirmar. ready: verificado por el procesador servidor. deleting: borrado pedido, pendiente de confirmar en R2.';
comment on column public.media_assets.is_public is
  'Si el objeto está hoy servido desde el bucket público de R2. Publicar/despublicar la publicación mueve esto (Fase 9I-2/9I-3), no un UPDATE directo desde el navegador.';
comment on column public.media_assets.storage_key is
  'Clave del objeto en R2, generada por el servidor. Nunca el nombre de archivo del cliente.';
comment on column public.media_assets.pipeline_version is
  'Versión del pipeline de normalización que generó este archivo (p. ej. "img-v1"), para poder comparar salidas entre versiones sin asumir bytes idénticos.';

alter table public.media_assets enable row level security;
alter table public.media_assets force row level security;

revoke all on table public.media_assets from public;
revoke all on table public.media_assets from anon;
revoke all on table public.media_assets from authenticated;
revoke all on table public.media_assets from service_role;
grant select, insert, update, delete on table public.media_assets to service_role;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- cosplay_posts: una publicación de Cosplay. Modelo de traducción congelado en columnas
-- `_es/_en/_de` (no JSON, no tabla normalizada): con exactamente 3 idiomas de producto
-- congelados, mantiene las consultas y la edición del ADMIN simples, y `title_es not null` da el
-- invariante "toda publicación tiene título en español" como constraint nativa, sin lógica
-- aplicativa. Ver la discusión completa en el descubrimiento de arquitectura de 9I.
--
-- `character` se llama `character_name` (evita el nombre de tipo SQL `character`/`char`, aunque
-- Postgres lo permitiría sin comillas como columna; más claro para quien lea el esquema después).
create table public.cosplay_posts (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null,
  status                text not null default 'draft',
  title_es              text not null,
  title_en              text,
  title_de              text,
  description_es        text,
  description_en        text,
  description_de        text,
  character_name        text,
  series                text,
  event                 text,
  shot_on               date,
  photographer_credit   text,
  version               integer not null default 1,
  created_by            uuid references auth.users(id) on delete set null,
  updated_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  published_at          timestamptz,

  constraint cosplay_posts_slug_unique unique (slug),
  constraint cosplay_posts_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 80),
  constraint cosplay_posts_status_check check (status in ('draft', 'published')),
  constraint cosplay_posts_title_es_length check (char_length(title_es) between 1 and 120),
  constraint cosplay_posts_title_en_length
    check (title_en is null or char_length(title_en) between 1 and 120),
  constraint cosplay_posts_title_de_length
    check (title_de is null or char_length(title_de) between 1 and 120),
  constraint cosplay_posts_description_es_length
    check (description_es is null or char_length(description_es) <= 2000),
  constraint cosplay_posts_description_en_length
    check (description_en is null or char_length(description_en) <= 2000),
  constraint cosplay_posts_description_de_length
    check (description_de is null or char_length(description_de) <= 2000),
  constraint cosplay_posts_character_name_length
    check (character_name is null or char_length(character_name) <= 120),
  constraint cosplay_posts_series_length check (series is null or char_length(series) <= 120),
  constraint cosplay_posts_event_length check (event is null or char_length(event) <= 120),
  constraint cosplay_posts_photographer_credit_length
    check (photographer_credit is null or char_length(photographer_credit) <= 120),
  constraint cosplay_posts_version_check check (version >= 1),
  -- published_at es la marca de la PRIMERA publicación (nunca se reescribe al editar); por eso
  -- solo se exige "si está publicado, tiene fecha" — nunca al revés (un borrador puede conservar
  -- published_at de una publicación anterior si en el futuro existiera "despublicar").
  constraint cosplay_posts_published_at_when_published
    check (status <> 'published' or published_at is not null)
);

comment on table public.cosplay_posts is
  'Publicaciones de Cosplay. Traducciones en columnas _es/_en/_de (3 idiomas congelados); ES es la fuente editorial y el único idioma obligatorio. Acceso exclusivo server-side (service_role); la lectura pública pasa por /api/content, no por policies.';
comment on column public.cosplay_posts.slug is
  'Derivado del título en español al crear. Editable en borrador; INMUTABLE tras la primera publicación (el código de aplicación no lo reescribe, aunque cambie el título).';
comment on column public.cosplay_posts.published_at is
  'Momento de la PRIMERA publicación exitosa. Editar una publicación ya publicada no lo cambia.';
comment on column public.cosplay_posts.version is
  'Concurrencia optimista: cada escritura la incrementa. Una edición con una version desfasada se rechaza (Fase 9I-3).';
comment on column public.cosplay_posts.character_name is
  'Personaje representado. Nombre propio: no se traduce automáticamente.';

alter table public.cosplay_posts enable row level security;
alter table public.cosplay_posts force row level security;

revoke all on table public.cosplay_posts from public;
revoke all on table public.cosplay_posts from anon;
revoke all on table public.cosplay_posts from authenticated;
revoke all on table public.cosplay_posts from service_role;
grant select, insert, update, delete on table public.cosplay_posts to service_role;

-- Listado público: publicadas, más recientes primero. Parcial (solo status='published') porque
-- los borradores nunca aparecen en esa consulta y no deben inflar el índice.
create index cosplay_posts_published_listing
  on public.cosplay_posts (published_at desc, id desc)
  where status = 'published';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- cosplay_post_images: asociación de galería entre una publicación y un media_asset, con orden,
-- portada y texto editorial POR IMAGEN (alt/caption en _es/_en/_de, mismo modelo de columnas que
-- cosplay_posts). alt_es NOT NULL salvo que la imagen sea `decorative`: es la regla de
-- accesibilidad ("toda imagen publicada no decorativa exige alt en español"), pero como una
-- publicación puede estar en borrador con imágenes todavía sin alt, NO se exige aquí con un
-- CHECK de fila — se exige en el dominio de aplicación (validatePublishReadiness, Fase 9I-3) en
-- el momento de publicar, cuando ya se sabe que la publicación va a ser pública.
--
-- `asset_id` es UNIQUE: un media_asset pertenece a lo sumo a una publicación (nunca se reutiliza
-- entre galerías), y su FK es ON DELETE RESTRICT — borrar la fila de media_assets mientras una
-- publicación la referencia falla de forma visible; el flujo correcto es primero desvincular
-- (borrar esta fila) y dejar que el reconciliador de 9I-2 marque el asset `deleting`.
-- `post_id` es ON DELETE CASCADE: Cosplay borra en DURO (Fase 9I, sección de borrado); al borrar
-- la publicación, sus asociaciones de galería desaparecen con ella (los media_assets referenciados
-- quedan huérfanos de galería pero siguen existiendo hasta que 9I-2 los reconcilie y borre en R2 —
-- así nunca se pierde la referencia necesaria para limpiar los bytes reales).
create table public.cosplay_post_images (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.cosplay_posts(id) on delete cascade,
  asset_id      uuid not null references public.media_assets(id) on delete restrict,
  position      integer not null,
  is_cover      boolean not null default false,
  decorative    boolean not null default false,
  alt_es        text,
  alt_en        text,
  alt_de        text,
  caption_es    text,
  caption_en    text,
  caption_de    text,
  created_at    timestamptz not null default now(),

  constraint cosplay_post_images_asset_unique unique (asset_id),
  constraint cosplay_post_images_position_check check (position >= 0),
  constraint cosplay_post_images_alt_es_length
    check (alt_es is null or char_length(alt_es) <= 250),
  constraint cosplay_post_images_alt_en_length
    check (alt_en is null or char_length(alt_en) <= 250),
  constraint cosplay_post_images_alt_de_length
    check (alt_de is null or char_length(alt_de) <= 250),
  constraint cosplay_post_images_caption_es_length
    check (caption_es is null or char_length(caption_es) <= 300),
  constraint cosplay_post_images_caption_en_length
    check (caption_en is null or char_length(caption_en) <= 300),
  constraint cosplay_post_images_caption_de_length
    check (caption_de is null or char_length(caption_de) <= 300),
  -- Reordenar exige poder pisar temporalmente posiciones ya usadas dentro de la misma
  -- transacción (p. ej. intercambiar 2 posiciones): DEFERRABLE permite `set constraints ...
  -- deferred` en la futura RPC de reordenar (Fase 9I-3). Por defecto sigue comprobándose al
  -- final de cada sentencia, como cualquier UNIQUE normal.
  constraint cosplay_post_images_position_unique
    unique (post_id, position) deferrable initially immediate
);

comment on table public.cosplay_post_images is
  'Asociación de galería: qué media_asset pertenece a qué publicación de Cosplay, en qué orden, con qué portada y con qué texto editorial por imagen (alt/caption en _es/_en/_de). Acceso exclusivo server-side (service_role).';
comment on column public.cosplay_post_images.decorative is
  'true = la imagen no aporta información (alt vacío intencional). false = requiere alt_es antes de poder publicarse (exigido en el dominio de aplicación, no aquí).';
comment on column public.cosplay_post_images.alt_es is
  'Texto alternativo en español. Dato editorial: nunca se deriva del nombre de archivo. Obligatorio para publicar salvo decorative=true (regla de dominio, Fase 9I-3).';

alter table public.cosplay_post_images enable row level security;
alter table public.cosplay_post_images force row level security;

revoke all on table public.cosplay_post_images from public;
revoke all on table public.cosplay_post_images from anon;
revoke all on table public.cosplay_post_images from authenticated;
revoke all on table public.cosplay_post_images from service_role;
grant select, insert, update, delete on table public.cosplay_post_images to service_role;

-- Como mucho una portada por publicación (a lo sumo, no "exactamente una": una publicación en
-- borrador con cero portadas todavía es válida; "exactamente una" se exige solo para publicar,
-- en el dominio de aplicación).
create unique index cosplay_post_images_one_cover
  on public.cosplay_post_images (post_id)
  where is_cover;

-- Lectura de galería ordenada (cubierta también por el UNIQUE de arriba, pero un índice
-- explícito documenta la intención de consulta: "dame la galería de esta publicación en orden").
create index cosplay_post_images_gallery_order
  on public.cosplay_post_images (post_id, position);
