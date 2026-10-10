-- 9K-R5-S1 · SIMULACIÓN (solo SELECT) del barrido media_abandoned_sweep.
-- Reproduce los criterios EXACTOS de supabase/migrations/20261026120000_media_abandoned_cleanup.sql
-- con sus valores por defecto. No marca, no borra, no llama a ninguna función con efectos.
-- Se puede ejecutar ANTES de aplicar la migración (usa solo tablas existentes).
--
-- Nota previa a la migración: sin el trigger de actividad, updated_at == created_at en todas las
-- filas históricas, así que la antigüedad por actividad es la antigüedad desde la reserva. Con la
-- migración aplicada, los assets nuevos cuentan desde su última transición de estado.
--
-- Parámetros (mismos defectos que la función): editar solo en `params`.
with params as (
  select interval '72 hours' as ready_age,
         interval '24 hours' as pending_age,
         interval '72 hours' as failed_age,
         false as include_cosplay_ready,
         now() as t0
), base as (
  select a.id, a.domain, a.kind, a.status, a.created_at, a.updated_at, a.storage_key,
         a.private_original_key, a.created_by,
         (select count(*) from public.community_post_media m where m.asset_id = a.id) as community_refs,
         (select count(*) from public.cosplay_post_images i where i.asset_id = a.id) as cosplay_refs,
         p.*
    from public.media_assets a cross join params p
   where a.domain in ('community', 'cosplay')
     and (
       (a.status = 'ready' and a.updated_at <= p.t0 - p.ready_age)
       or (a.status in ('reserved', 'uploaded', 'verifying', 'processing')
           and a.updated_at <= p.t0 - p.pending_age)
       or (a.status = 'failed' and a.updated_at <= p.t0 - p.failed_age))
)
select b.id as asset_id,
       b.domain,
       b.kind,
       b.status,
       round(extract(epoch from (b.t0 - b.updated_at)) / 3600, 1) as inactive_hours,
       round(extract(epoch from (b.t0 - b.created_at)) / 3600, 1) as created_hours_ago,
       b.community_refs,
       b.cosplay_refs,
       case
         when b.status = 'ready' and (b.community_refs > 0 or b.cosplay_refs > 0) then 'SKIPPED_REFERENCED'
         when b.status = 'ready' and b.domain = 'cosplay' and not b.include_cosplay_ready
           then 'EXCLUDED_COSPLAY_READY'
         else 'ELIGIBLE'
       end as verdict,
       case b.status
         when 'ready' then 'ready sin referencias e inactivo ≥ ' || b.ready_age
         when 'failed' then 'failed inactivo ≥ ' || b.failed_age
         else b.status || ' sin transición reciente ≥ ' || b.pending_age
       end as reason,
       -- Objetos públicos que el GC intentaría borrar: variantes registradas ∪ storage_key ∪ claves
       -- canónicas posibles del propio asset (borrar una clave inexistente es un éxito idempotente).
       (select count(distinct k) from (
          select v.storage_key k from public.media_asset_variants v where v.asset_id = b.id
          union select b.storage_key
          union select b.domain || '/' || b.id::text || '/w' || w || '.webp'
            from unnest(array['480','960','1600','2560']) w
          union select 'community/' || b.id::text || '/original.' || e
            from unnest(array['mp4','mov','webm']) e where b.domain = 'community'
        ) s where k is not null) as est_public_object_keys,
       (select count(*) from public.media_asset_variants v where v.asset_id = b.id) as registered_variants,
       (b.private_original_key is not null)::int as est_private_objects,
       -- Revisión manual obligatoria antes de la primera activación.
       (b.status = 'ready' or b.domain = 'cosplay' or b.status = 'processing'
         or b.private_original_key is not null) as needs_manual_review,
       concat_ws('; ',
         case when b.status = 'ready' then 'contenido ya subido: confirmar con el propietario que no lo necesita' end,
         case when b.domain = 'cosplay' then 'Cosplay: galería curada por ADMIN' end,
         case when b.status = 'processing' then 'procesado atascado: comprobar que no hay una petición viva' end,
         case when b.private_original_key is not null then 'conserva original privado (staging/objects)' end
       ) as review_note,
       b.created_by as owner_id
  from base b
 order by b.domain, b.status, b.updated_at, b.id;
