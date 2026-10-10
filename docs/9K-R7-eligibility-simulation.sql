-- 9K-R7 · SOLO LECTURA. ¿Qué marcaría media_abandoned_reservations_mark() ahora mismo con min_age = 2 h?
-- Replica el predicado del marcador (estados pendientes, dominio, corte histórico y antigüedad por
-- created_at Y updated_at). No escribe nada ni llama a ninguna función de marcado.
-- Cambia '2 hours' por otro intervalo (≥ 2 h) para simular otro umbral.
with cfg as (
  select interval '2 hours' as min_age,
         (select protected_before from public.media_abandon_policy) as cutoff,
         (select enabled from public.media_abandon_policy) as policy_enabled,
         (select batch_limit from public.media_abandon_policy) as batch_limit
)
select left(a.id::text, 8)                                   as asset,
       a.id,
       a.domain, a.kind, a.status::text                       as status,
       a.created_at, a.updated_at,
       now() - greatest(a.created_at, a.updated_at)           as inactivo_desde,
       (a.multipart_upload_id is not null)                    as tiene_multipart,
       a.source_bytes,
       greatest(a.created_at, a.updated_at) + c.min_age       as elegible_desde,
       case
         when a.created_at < c.cutoff                         then 'PROTEGIDO_HISTORICO (nunca)'
         when greatest(a.created_at, a.updated_at) > now() - c.min_age
                                                              then 'RECIENTE (no elegible todavía)'
         else 'ELEGIBLE'
       end                                                    as veredicto,
       c.policy_enabled                                       as politica_activa
  from public.media_assets a cross join cfg c
 where a.status in ('reserved', 'uploaded', 'verifying', 'processing')
   and a.domain in ('community', 'cosplay')
 order by a.created_at;
