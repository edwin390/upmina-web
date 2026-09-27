-- Pipeline de medios de Cosplay (Fase 9I-2B): amplía media_assets (creada en
-- 20260930120000_cosplay_foundation.sql, INMUTABLE — esta migración nunca la edita) con el ciclo
-- de vida real de reserva/subida/verificación/procesado, y añade media_asset_variants para las 4
-- variantes WebP por imagen. Sigue el mismo patrón que 20260926120000_admin_team_roles_invariants.sql
-- amplió admin_roles_role_check: una migración nueva que ensancha un CHECK existente, nunca reescribe
-- la migración original.
--
-- Por qué media_assets necesita cambiar: en 9I-1, `mime`/`width`/`height`/`bytes`/`storage_key` eran
-- NOT NULL porque solo se pensó la forma final ('ready'). Con la reserva real, una fila nace en
-- 'reserved' sin que exista todavía ningún archivo canónico (WebP) — esos 5 campos ahora describen
-- EXCLUSIVAMENTE el WebP canónico más grande generado (el que expone /api/content), y solo existen
-- juntos, nunca parcialmente (constraint de grupo más abajo). El original sin normalizar (que nunca
-- entra en estos campos, ver comentario original) se rastrea por separado en private_original_key
-- mientras viaja staging/ → objects/ y se borra tras un procesado exitoso.
--
-- Por qué media_asset_variants y no 4 filas en media_assets: cosplay_post_images.asset_id es UNIQUE
-- (un media_asset por hueco de galería), así que una fila de media_assets debe representar TODA la
-- imagen procesada, no un solo archivo. Los 4 tamaños viven en esta tabla nueva; media_assets solo
-- espeja el más grande realmente generado (nunca se escala hacia arriba, así que puede ser menor de
-- 2560 si el original era más pequeño) para que el contrato público de 9I-1 (media_assets.storage_key
-- como la única URL de CosplayImage) siga funcionando sin cambios.

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- media_assets: nuevas columnas del ciclo de vida real.

alter table public.media_assets
  add column private_original_key text,
  add column source_mime          text,
  add column source_bytes         bigint,
  add column source_width         integer,
  add column source_height        integer,
  add column failure_code         text,
  add column processing_attempts  integer not null default 0,
  add column multipart_upload_id  text;

comment on column public.media_assets.private_original_key is
  'Clave R2 del original sin normalizar mientras existe (staging/cosplay/{id}/original.* o, tras verificarse, objects/cosplay/{id}/original.*). NULL una vez que el procesado canónico termina con éxito y se borra (o si la fila nunca llegó a subirse).';
comment on column public.media_assets.source_mime is
  'MIME declarado/verificado del archivo ORIGINAL subido por el cliente (antes de normalizar). Distinto de `mime`, que es siempre image/webp (la salida canónica).';
comment on column public.media_assets.source_bytes is
  'Tamaño en bytes del original declarado en la reserva; se contrasta con el HEAD real tras la subida.';
comment on column public.media_assets.source_width is
  'Ancho del original en píxeles, una vez decodificado y verificado server-side (no el declarado por el cliente).';
comment on column public.media_assets.source_height is
  'Alto del original en píxeles, una vez decodificado y verificado server-side.';
comment on column public.media_assets.failure_code is
  'Código de fallo accionable cuando status=failed (ver media_assets_failure_code_check). NULL en cualquier otro estado.';
comment on column public.media_assets.processing_attempts is
  'Número de intentos de procesado canónico realizados. Tope defensivo: ver media_assets_processing_attempts_check.';
comment on column public.media_assets.multipart_upload_id is
  'Identificador de la subida multipart de R2 en curso (staging/), mientras exista. NULL fuera de una subida multipart activa.';

-- Los 5 campos "canónicos" (heredados de 9I-1) ya no pueden ser NOT NULL: una fila reservada
-- todavía no tiene WebP. En su lugar, deben existir TODOS juntos o NINGUNO — nunca a medias.
alter table public.media_assets
  alter column mime drop not null,
  alter column width drop not null,
  alter column height drop not null,
  alter column bytes drop not null,
  alter column storage_key drop not null;

alter table public.media_assets
  add constraint media_assets_canonical_fields_together check (
    (mime is null and storage_key is null and width is null and height is null and bytes is null)
    or
    (mime is not null and storage_key is not null and width is not null and height is not null and bytes is not null)
  );

-- Ciclo de vida real (Fase 9I-2B): reserved → uploaded → verifying → processing → ready, con
-- failed como sumidero de error desde uploaded/verifying/processing, y deleting como limpieza
-- explícita (tanto de una reserva abandonada como de un asset ya listo). "uploading" (el navegador
-- subiendo bytes) es deliberadamente un estado SOLO de cliente: el servidor no lo observa (la
-- subida va directa navegador→R2), así que no tiene sentido persistirlo aquí.
alter table public.media_assets drop constraint media_assets_status_check;
alter table public.media_assets add constraint media_assets_status_check
  check (status in ('reserved', 'uploaded', 'verifying', 'processing', 'ready', 'failed', 'deleting'));

alter table public.media_assets add constraint media_assets_failure_code_check
  check (failure_code in (
    'mime_mismatch',
    'too_large',
    'too_many_pixels',
    'heic_unsupported_profile',
    'upload_incomplete',
    'verification_failed',
    'processing_failed'
  ));

-- failure_code existe EXACTAMENTE cuando status=failed: nunca "huérfano" en otro estado, nunca
-- ausente en un fallo real.
alter table public.media_assets add constraint media_assets_failure_code_presence
  check ((status = 'failed') = (failure_code is not null));

alter table public.media_assets add constraint media_assets_processing_attempts_check
  check (processing_attempts >= 0 and processing_attempts <= 10);

alter table public.media_assets add constraint media_assets_private_original_key_length
  check (private_original_key is null or char_length(private_original_key) between 1 and 512);
alter table public.media_assets add constraint media_assets_private_original_key_unique
  unique (private_original_key);

alter table public.media_assets add constraint media_assets_source_mime_check
  check (source_mime is null or source_mime in (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'
  ));
-- 60 MB (sección 11 del checkpoint 9I-2): techo del ORIGINAL sin normalizar, muy por encima del
-- techo de 8 MiB de `bytes` (que es el WebP ya comprimido).
alter table public.media_assets add constraint media_assets_source_bytes_check
  check (source_bytes is null or (source_bytes > 0 and source_bytes <= 62914560));
alter table public.media_assets add constraint media_assets_source_width_check
  check (source_width is null or (source_width > 0 and source_width <= 20000));
alter table public.media_assets add constraint media_assets_source_height_check
  check (source_height is null or (source_height > 0 and source_height <= 20000));
-- 100 megapíxeles (sección 11 del checkpoint 9I-2), como producto de ambas dimensiones, no como
-- techo independiente por eje (una imagen 20000×20000 pasaría los CHECK individuales pero nunca
-- este).
alter table public.media_assets add constraint media_assets_source_megapixels_check
  check (
    source_width is null or source_height is null
    or (source_width::bigint * source_height::bigint) <= 100000000
  );

alter table public.media_assets add constraint media_assets_multipart_upload_id_length
  check (multipart_upload_id is null or char_length(multipart_upload_id) between 1 and 512);

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- media_asset_variants: las hasta 4 variantes WebP (480/960/1600/2560) de UN media_asset. Nunca
-- se genera una variante mayor que el original (sin upscaling) — el dominio de aplicación decide
-- cuáles de las 4 existen; esta tabla solo registra las que realmente se subieron.
create table public.media_asset_variants (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.media_assets(id) on delete cascade,
  variant       integer not null,
  width         integer not null,
  height        integer not null,
  bytes         bigint not null,
  storage_key   text not null,
  created_at    timestamptz not null default now(),

  constraint media_asset_variants_variant_check check (variant in (480, 960, 1600, 2560)),
  constraint media_asset_variants_asset_variant_unique unique (asset_id, variant),
  constraint media_asset_variants_storage_key_unique unique (storage_key),
  constraint media_asset_variants_storage_key_length
    check (char_length(storage_key) between 1 and 512),
  constraint media_asset_variants_width_check check (width > 0 and width <= 10000),
  constraint media_asset_variants_height_check check (height > 0 and height <= 10000),
  constraint media_asset_variants_bytes_check check (bytes > 0 and bytes <= 8388608)
);

comment on table public.media_asset_variants is
  'Las variantes WebP (hasta 4: 480/960/1600/2560) generadas para un media_asset. media_assets.storage_key espeja la variante más grande aquí presente, para que el contrato público de 9I-1 (una sola URL por imagen) no cambie; esta tabla es la fuente completa para un futuro srcset. Acceso exclusivo server-side (service_role).';
comment on column public.media_asset_variants.variant is
  'Ancho objetivo nominal (480/960/1600/2560). El ancho REAL (columna width) puede ser menor si el original era más pequeño en ese eje tras el resize (nunca mayor: sin upscaling).';

alter table public.media_asset_variants enable row level security;
alter table public.media_asset_variants force row level security;

revoke all on table public.media_asset_variants from public;
revoke all on table public.media_asset_variants from anon;
revoke all on table public.media_asset_variants from authenticated;
revoke all on table public.media_asset_variants from service_role;
grant select, insert, update, delete on table public.media_asset_variants to service_role;

create index media_asset_variants_by_asset on public.media_asset_variants (asset_id);
