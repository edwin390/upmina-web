-- PHASE-2: estado `held_for_review` y versiones pendientes de edición. Forward-only; LOCAL, NO aplicada en ningún entorno.
--
-- Decisiones (deterministas):
--  * held_for_review es un estado NUEVO; hidden_pending_review sigue siendo solo de la cuarentena por denuncias.
--    Una retenida no sale en feed, detalle, perfil ni likes (todos filtran status='published'), no es denunciable
--    (post_not_reportable) y no figura en la lista propia existente; la autora la ve con community_author_pending_read.
--    No se puede editar (post_not_editable) pero sí eliminar con community_post_delete (existente).
--  * Entrega de medios: community_media_delivery_state devuelve 'private' (capability) para retenidas y para los archivos
--    nuevos de una edición pendiente (listos pero sin adjuntar); 'public' solo para publicadas. NO se garantiza más allá
--    de eso: el bucket público sigue accesible por clave directa si no se usa el Worker de entrega seguro.
--  * Una sola edición pendiente por publicación; una nueva SUSTITUYE a la anterior. Estado obsoleto (versión de la
--    publicación != base_version) -> solo puede rechazarse. Aprobar exige publicación `published` y sin copyright activo.
--  * Aprobación/rechazo: funciones solo para service_role que verifican admin_roles (admin/moderator/developer) en la BD.
--    No hay endpoint HTTP todavía. Rechazo/cancelación/sustitución marcan `deleting` los archivos nuevos no usados (GC).
--  * Eliminar la publicación borra en cascada sus ediciones; sus archivos nuevos quedan sin referencia y los recoge el
--    barrido de abandonados (que ahora respeta las ediciones pendientes). La eliminación de cuenta ya cubre los assets
--    sin adjuntar de la autora (account_deletion_stage_media).
--  * Se redefinen (cuerpo vigente + cambio mínimo, verificado por hash contra DEV): community_post_save, _save_atomic,
--    _detach_media, _reorder_media (+ held_for_review en la guardia de edición), community_media_delivery_state,
--    media_abandoned_sweep y community_media_asset_discard (+ respetan ediciones pendientes).

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Estado nuevo `held_for_review` (retención previa a la publicación). Distinto de `hidden_pending_review`,
--    que sigue siendo exclusivo de la cuarentena por denuncias (quarantine_cycle_id) y no cambia de significado.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.community_posts drop constraint if exists community_posts_status_check;
alter table public.community_posts add constraint community_posts_status_check
  check (status in ('published', 'hidden_pending_review', 'hidden', 'removed_pending_purge', 'held_for_review'));

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Versiones pendientes de edición. La fila de community_posts / community_post_media NO se toca hasta aprobar.
--    Una sola edición pendiente por publicación (índice parcial); cada archivo NUEVO pertenece a una sola pendiente.
--    Las filas de medios solo se conservan mientras la edición está pendiente (se borran al decidirla).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create table public.community_post_pending_edits (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  base_version integer not null,
  text text,
  -- Número de archivos que vio quien revisa: si luego desaparece alguno (p. ej. lo borra el GC), la aprobación falla.
  media_count integer not null,
  status text not null default 'pending',
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  decided_by uuid,
  constraint community_post_pending_edits_status_check
    check (status in ('pending', 'approved', 'rejected', 'superseded', 'cancelled')),
  constraint community_post_pending_edits_version_check check (base_version >= 1),
  constraint community_post_pending_edits_media_count_check check (media_count between 0 and 10),
  constraint community_post_pending_edits_text_length
    check (text is null or (char_length(text) >= 1 and char_length(text) <= 2000)),
  constraint community_post_pending_edits_text_not_blank check (text is null or btrim(text) <> ''),
  constraint community_post_pending_edits_decision_check check (
    (status = 'pending' and decided_at is null and decided_by is null)
    or (status <> 'pending' and decided_at is not null))
);
create unique index community_post_pending_edits_one_pending_idx
  on public.community_post_pending_edits (post_id) where status = 'pending';
create index community_post_pending_edits_author_idx
  on public.community_post_pending_edits (author_user_id, created_at desc);

create table public.community_post_pending_edit_media (
  id uuid primary key default gen_random_uuid(),
  edit_id uuid not null references public.community_post_pending_edits(id) on delete cascade,
  -- CASCADE a propósito: el GC debe poder borrar el asset aunque una edición pendiente (p. ej. obsoleta) lo cite;
  -- la aprobación detecta la pérdida comparando con media_count y falla en vez de publicar una versión distinta.
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  position integer not null,
  is_new boolean not null,
  constraint community_post_pending_edit_media_position_check check (position >= 0),
  constraint community_post_pending_edit_media_asset_unique unique (edit_id, asset_id),
  constraint community_post_pending_edit_media_position_unique unique (edit_id, position)
);
create unique index community_post_pending_edit_media_new_asset_idx
  on public.community_post_pending_edit_media (asset_id) where is_new;
create index community_post_pending_edit_media_asset_idx
  on public.community_post_pending_edit_media (asset_id);

-- Sin políticas y sin privilegios para ningún rol de la API: solo se escribe y se lee mediante las funciones de abajo.
alter table public.community_post_pending_edits enable row level security;
alter table public.community_post_pending_edits force row level security;
alter table public.community_post_pending_edit_media enable row level security;
alter table public.community_post_pending_edit_media force row level security;
revoke all on table public.community_post_pending_edits from public, anon, authenticated, service_role;
revoke all on table public.community_post_pending_edit_media from public, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Cierre interno de una edición pendiente (cancelada, rechazada, sustituida o aprobada).
--    Marca como `deleting` los archivos nuevos que no vayan a publicarse (los recoge el GC existente) y borra las filas
--    de medios. NUNCA toca archivos adjuntos a la publicación. Sin EXECUTE para ningún rol de la API.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.community_pending_edit_close(
  p_edit_id uuid, p_status text, p_decided_by uuid, p_keep_assets uuid[]
) returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_cleanup uuid[] := array[]::uuid[];
begin
  if p_edit_id is null or p_status not in ('approved', 'rejected', 'superseded', 'cancelled') then
    raise exception 'invalid_argument';
  end if;
  update public.community_post_pending_edits
    set status = p_status, decided_at = v_now, decided_by = p_decided_by
    where id = p_edit_id and status = 'pending';
  if not found then raise exception 'edit_not_pending'; end if;

  with released as (
    update public.media_assets a set status = 'deleting', updated_at = v_now
      where a.status = 'ready'
        and a.id in (select pm.asset_id from public.community_post_pending_edit_media pm
                     where pm.edit_id = p_edit_id and pm.is_new)
        and not (a.id = any(coalesce(p_keep_assets, array[]::uuid[])))
        and not exists (select 1 from public.community_post_media m where m.asset_id = a.id)
        and not exists (select 1 from public.cosplay_post_images i where i.asset_id = a.id)
      returning a.id
  ) select coalesce(array_agg(id), array[]::uuid[]) into v_cleanup from released;

  delete from public.community_post_pending_edit_media where edit_id = p_edit_id;
  return v_cleanup;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Crear una edición pendiente. Las reglas son EXACTAMENTE las de un guardado normal: se ejecuta
--    community_post_save_atomic dentro de un subbloque y se deshace (sus cambios nunca persisten); solo se conserva
--    el estado final que habría resultado. La publicación y sus adjuntos quedan intactos.
--    Una edición nueva SUSTITUYE a la pendiente anterior de esa publicación.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.community_post_pending_edit_submit(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_text text,
  p_media jsonb,
  p_removed_media_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_validated jsonb;
  v_final_text text;
  v_final_media jsonb;
  v_version integer;
  v_status text;
  v_new_assets uuid[];
  v_old_edit uuid;
  v_edit_id uuid;
  v_cleanup uuid[] := array[]::uuid[];
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;

  begin
    v_validated := public.community_post_save_atomic(
      p_actor_user_id, p_post_id, p_expected_version, p_text, p_media, p_removed_media_ids);
    v_final_text := v_validated -> 'post' ->> 'text';
    v_final_media := v_validated -> 'media';
    raise exception 'pending_edit_validated';
  exception when others then
    if sqlerrm is distinct from 'pending_edit_validated' then raise; end if;
  end;

  -- Los bloqueos del subbloque se liberaron al deshacerlo: se vuelve a comprobar el estado bajo bloqueo.
  select version, status into v_version, v_status from public.community_posts where id = p_post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if v_status <> 'published' then raise exception 'post_not_editable'; end if;
  if v_version <> p_expected_version then raise exception 'version_conflict'; end if;

  select coalesce(array_agg((e ->> 'asset_id')::uuid), array[]::uuid[]) into v_new_assets
    from jsonb_array_elements(v_final_media) e
    where not exists (
      select 1 from public.community_post_media m
      where m.post_id = p_post_id and m.asset_id = (e ->> 'asset_id')::uuid);

  perform 1 from public.media_assets where id = any(v_new_assets) order by id for update;
  if (select count(*) from public.media_assets a
      where a.id = any(v_new_assets) and a.status = 'ready' and a.domain = 'community'
        and a.created_by is not distinct from p_actor_user_id
        and not exists (select 1 from public.community_post_media m where m.asset_id = a.id))
     <> coalesce(array_length(v_new_assets, 1), 0) then
    raise exception 'asset_not_ready';
  end if;
  if exists (
    select 1 from public.community_post_pending_edit_media pm
    join public.community_post_pending_edits pe on pe.id = pm.edit_id
    where pm.asset_id = any(v_new_assets) and pe.status = 'pending' and pe.post_id <> p_post_id
  ) then
    raise exception 'asset_already_attached';
  end if;

  select id into v_old_edit from public.community_post_pending_edits
    where post_id = p_post_id and status = 'pending' for update;
  if found then
    v_cleanup := public.community_pending_edit_close(v_old_edit, 'superseded', null, v_new_assets);
  end if;

  insert into public.community_post_pending_edits (post_id, author_user_id, base_version, text, media_count)
    values (p_post_id, p_actor_user_id, p_expected_version, v_final_text, jsonb_array_length(v_final_media))
    returning id into v_edit_id;
  insert into public.community_post_pending_edit_media (edit_id, asset_id, position, is_new)
    select v_edit_id, (e ->> 'asset_id')::uuid, (e ->> 'position')::integer,
           ((e ->> 'asset_id')::uuid = any(v_new_assets))
    from jsonb_array_elements(v_final_media) e;

  return jsonb_build_object(
    'edit', jsonb_build_object('id', v_edit_id, 'post_id', p_post_id,
                               'base_version', p_expected_version, 'status', 'pending'),
    'cleanup_asset_ids', to_jsonb(v_cleanup));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Cancelar la edición pendiente (la propia autora).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.community_post_pending_edit_cancel(p_actor_user_id uuid, p_post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_author uuid;
  v_edit uuid;
  v_cleanup uuid[];
begin
  if p_actor_user_id is null or p_post_id is null then raise exception 'invalid_argument'; end if;
  select author_user_id into v_author from public.community_posts where id = p_post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if v_author <> p_actor_user_id then raise exception 'not_owner'; end if;
  select id into v_edit from public.community_post_pending_edits
    where post_id = p_post_id and status = 'pending' for update;
  if not found then raise exception 'pending_edit_not_found'; end if;
  v_cleanup := public.community_pending_edit_close(v_edit, 'cancelled', p_actor_user_id, array[]::uuid[]);
  return jsonb_build_object('edit_id', v_edit, 'cleanup_asset_ids', to_jsonb(v_cleanup));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Rechazar una edición pendiente (moderación). La versión pública queda intacta; los archivos nuevos se limpian.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.community_post_pending_edit_reject(p_moderator_user_id uuid, p_edit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_post uuid;
  v_edit uuid;
  v_cleanup uuid[];
begin
  if p_moderator_user_id is null or p_edit_id is null then raise exception 'invalid_argument'; end if;
  select role into v_role from public.admin_roles where user_id = p_moderator_user_id for share;
  if v_role is null or v_role not in ('admin', 'moderator', 'developer') then
    raise exception 'actor_not_moderator';
  end if;
  select post_id into v_post from public.community_post_pending_edits where id = p_edit_id;
  if not found then raise exception 'pending_edit_not_found'; end if;
  perform 1 from public.community_posts where id = v_post for update;
  select id into v_edit from public.community_post_pending_edits
    where id = p_edit_id and status = 'pending' for update;
  if not found then raise exception 'edit_not_pending'; end if;
  v_cleanup := public.community_pending_edit_close(v_edit, 'rejected', p_moderator_user_id, array[]::uuid[]);
  return jsonb_build_object('edit_id', v_edit, 'cleanup_asset_ids', to_jsonb(v_cleanup));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 7. Aprobar una edición pendiente (moderación). Una sola transacción: o se aplica todo o no cambia nada.
--    Exige: edición pendiente, publicación `published`, versión base == versión actual (si no, queda obsoleta y solo
--    puede rechazarse), sin retirada o apelación de copyright activa, y archivos nuevos todavía válidos.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.community_post_pending_edit_approve(
  p_moderator_user_id uuid, p_edit_id uuid, p_expected_post_version integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_now timestamptz := clock_timestamp();
  v_post public.community_posts%rowtype;
  v_edit public.community_post_pending_edits%rowtype;
  v_new_assets uuid[];
  v_removed_assets uuid[];
  v_final_count integer;
  v_video_count integer;
  v_had_media boolean;
  v_cleanup uuid[] := array[]::uuid[];
  v_released uuid[] := array[]::uuid[];
  v_post_json jsonb;
  v_media_json jsonb;
begin
  if p_moderator_user_id is null or p_edit_id is null or p_expected_post_version is null then
    raise exception 'invalid_argument';
  end if;
  select role into v_role from public.admin_roles where user_id = p_moderator_user_id for share;
  if v_role is null or v_role not in ('admin', 'moderator', 'developer') then
    raise exception 'actor_not_moderator';
  end if;

  select * into v_edit from public.community_post_pending_edits where id = p_edit_id;
  if not found then raise exception 'pending_edit_not_found'; end if;
  select * into v_post from public.community_posts where id = v_edit.post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  select * into v_edit from public.community_post_pending_edits where id = p_edit_id for update;
  if v_edit.status <> 'pending' then raise exception 'edit_not_pending'; end if;
  if v_post.status <> 'published' then raise exception 'post_not_editable'; end if;
  if public.copyright_post_protected(v_post.id) then raise exception 'post_copyright_protected'; end if;
  if v_post.version <> v_edit.base_version or v_post.version <> p_expected_post_version then
    raise exception 'version_conflict';
  end if;

  select coalesce(array_agg(pm.asset_id), array[]::uuid[]) into v_new_assets
    from public.community_post_pending_edit_media pm
    where pm.edit_id = v_edit.id and pm.is_new;
  select coalesce(array_agg(m.asset_id), array[]::uuid[]) into v_removed_assets
    from public.community_post_media m
    where m.post_id = v_post.id
      and not exists (select 1 from public.community_post_pending_edit_media pm
                      where pm.edit_id = v_edit.id and pm.asset_id = m.asset_id);

  perform 1 from public.media_assets a
    where a.id = any(v_new_assets) or a.id = any(v_removed_assets) order by a.id for update;
  if (select count(*) from public.media_assets a
      where a.id = any(v_new_assets) and a.status = 'ready' and a.domain = 'community'
        and a.created_by is not distinct from v_post.author_user_id
        and not exists (select 1 from public.community_post_media m where m.asset_id = a.id))
     <> coalesce(array_length(v_new_assets, 1), 0) then
    raise exception 'asset_not_ready';
  end if;

  select count(*) into v_final_count
    from public.community_post_pending_edit_media where edit_id = v_edit.id;
  if v_final_count <> v_edit.media_count then raise exception 'asset_not_ready'; end if;
  v_had_media := exists (select 1 from public.community_post_media where post_id = v_post.id);
  if v_final_count > 10 then raise exception 'too_many_media'; end if;
  if v_had_media and v_final_count = 0 then raise exception 'media_required'; end if;
  if (v_edit.text is null or length(trim(v_edit.text)) = 0) and v_final_count = 0 then
    raise exception 'empty_post';
  end if;
  select count(*) into v_video_count
    from public.media_assets a
    where a.id in (select asset_id from public.community_post_pending_edit_media where edit_id = v_edit.id)
      and a.kind = 'video';
  if v_video_count > 1 then raise exception 'too_many_videos'; end if;

  set constraints public.community_post_media_position_unique deferred;
  delete from public.community_post_media where post_id = v_post.id and asset_id = any(v_removed_assets);
  update public.community_post_media m set position = pm.position
    from public.community_post_pending_edit_media pm
    where pm.edit_id = v_edit.id and m.post_id = v_post.id and m.asset_id = pm.asset_id;
  insert into public.community_post_media (post_id, asset_id, position, created_at)
    select v_post.id, pm.asset_id, pm.position, v_now
    from public.community_post_pending_edit_media pm
    where pm.edit_id = v_edit.id and pm.is_new;

  update public.community_posts
    set text = v_edit.text, version = v_post.version + 1, updated_at = v_now
    where id = v_post.id;

  with transitioned as (
    update public.media_assets a set status = 'deleting', updated_at = v_now
      where a.id = any(v_removed_assets) and a.status = 'ready'
        and not exists (select 1 from public.community_post_media m where m.asset_id = a.id)
        and not exists (select 1 from public.cosplay_post_images i where i.asset_id = a.id)
      returning a.id
  ) select coalesce(array_agg(id), array[]::uuid[]) into v_cleanup from transitioned;

  v_released := public.community_pending_edit_close(v_edit.id, 'approved', p_moderator_user_id, v_new_assets);

  select to_jsonb(cp) into v_post_json from public.community_posts cp where cp.id = v_post.id;
  select coalesce(jsonb_agg(to_jsonb(cpm) order by cpm.position), '[]'::jsonb) into v_media_json
    from public.community_post_media cpm where cpm.post_id = v_post.id;
  return jsonb_build_object('post', v_post_json, 'media', v_media_json,
                            'cleanup_asset_ids', to_jsonb(v_cleanup || v_released));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 8. Publicaciones retenidas. No se crea ninguna automáticamente: estas funciones solo ofrecen las transiciones.
--    create_held reutiliza las reglas de un alta normal (incluido «archivo obligatorio») dentro de UNA transacción: la
--    fila nace `published` y pasa a `held_for_review` antes del commit, así que nunca es visible como publicada.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.community_post_create_held(p_actor_user_id uuid, p_text text, p_media jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_post_id uuid;
begin
  if p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  v_result := public.community_post_save(p_actor_user_id, null, null, p_text, p_media);
  v_post_id := (v_result -> 'post' ->> 'id')::uuid;
  update public.community_posts set status = 'held_for_review' where id = v_post_id;
  return jsonb_build_object(
    'post', (select to_jsonb(cp) from public.community_posts cp where cp.id = v_post_id),
    'media', v_result -> 'media');
end;
$$;

create function public.community_post_hold_release(
  p_moderator_user_id uuid, p_post_id uuid, p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_post public.community_posts%rowtype;
begin
  if p_moderator_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;
  select role into v_role from public.admin_roles where user_id = p_moderator_user_id for share;
  if v_role is null or v_role not in ('admin', 'moderator', 'developer') then
    raise exception 'actor_not_moderator';
  end if;
  select * into v_post from public.community_posts where id = p_post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if v_post.status <> 'held_for_review' then raise exception 'post_not_held'; end if;
  if v_post.version <> p_expected_version then raise exception 'version_conflict'; end if;
  update public.community_posts
    set status = 'published', version = v_post.version + 1, updated_at = clock_timestamp()
    where id = p_post_id;
  return jsonb_build_object('post', (select to_jsonb(cp) from public.community_posts cp where cp.id = p_post_id));
end;
$$;

-- Rechazar una publicación retenida: se elimina (con sus archivos, vía el GC existente). No genera strike ni sanción.
create function public.community_post_hold_reject(
  p_moderator_user_id uuid, p_post_id uuid, p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_post public.community_posts%rowtype;
  v_asset_ids uuid[];
begin
  if p_moderator_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;
  select role into v_role from public.admin_roles where user_id = p_moderator_user_id for share;
  if v_role is null or v_role not in ('admin', 'moderator', 'developer') then
    raise exception 'actor_not_moderator';
  end if;
  select * into v_post from public.community_posts where id = p_post_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if v_post.status <> 'held_for_review' then raise exception 'post_not_held'; end if;
  if v_post.version <> p_expected_version then raise exception 'version_conflict'; end if;
  select coalesce(array_agg(asset_id), array[]::uuid[]) into v_asset_ids
    from public.community_post_media where post_id = p_post_id;
  update public.media_assets set status = 'deleting', updated_at = clock_timestamp()
    where id = any(v_asset_ids) and status = 'ready';
  delete from public.community_posts where id = p_post_id;
  return jsonb_build_object('deleted_asset_ids', to_jsonb(v_asset_ids));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 9. Lectura propia: la autora ve SUS publicaciones retenidas y SUS ediciones pendientes (nunca las de otra persona).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create function public.community_author_pending_read(p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_actor_user_id is null then raise exception 'invalid_argument'; end if;
  return jsonb_build_object(
    'held', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'text', p.text, 'version', p.version, 'createdAt', p.created_at,
        'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'assetId', m.asset_id, 'position', m.position)
                                            order by m.position, m.id)
                           from public.community_post_media m where m.post_id = p.id), '[]'::jsonb))
        order by p.created_at desc, p.id desc)
      from public.community_posts p
      where p.author_user_id = p_actor_user_id and p.status = 'held_for_review'), '[]'::jsonb),
    'edits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'postId', e.post_id, 'baseVersion', e.base_version, 'text', e.text,
        'createdAt', e.created_at, 'stale', (p.version <> e.base_version),
        'media', coalesce((select jsonb_agg(jsonb_build_object('assetId', pm.asset_id, 'position', pm.position, 'isNew', pm.is_new)
                                            order by pm.position)
                           from public.community_post_pending_edit_media pm where pm.edit_id = e.id), '[]'::jsonb))
        order by e.created_at desc, e.id desc)
      from public.community_post_pending_edits e
      join public.community_posts p on p.id = e.post_id
      where e.author_user_id = p_actor_user_id and e.status = 'pending'), '[]'::jsonb));
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 10. Funciones existentes redefinidas (ver cabecera).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.community_post_save(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_text text,
  p_media jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_is_create boolean := p_post_id is null;
  v_post_id uuid;
  v_current_version integer;
  v_author uuid;
  v_media_count integer;
  v_distinct_asset_count integer;
  v_distinct_position_count integer;
  v_existing_media_asset_ids uuid[];
  v_incoming_asset_ids uuid[];
  v_new_asset_ids uuid[];
  v_missing_existing integer;
  v_final_media_count integer;
  v_final_video_count integer;
  v_post_json jsonb;
  v_media_json jsonb;
begin
  if p_actor_user_id is null then
    raise exception 'invalid_argument';
  end if;
  -- R5-C: authoritative sanction guard. Locks the author profile (FOR SHARE) and aborts BEFORE any
  -- content mutation or post lock (canonical order: profiles -> community_posts).
  perform public.community_assert_author_may_write(p_actor_user_id);
  if not exists (select 1 from public.profiles where user_id = p_actor_user_id) then
    raise exception 'no_profile';
  end if;
  if p_media is null or jsonb_typeof(p_media) <> 'array' then
    raise exception 'invalid_argument';
  end if;

  v_media_count := jsonb_array_length(p_media);
  if v_media_count > 10 then
    raise exception 'too_many_media';
  end if;
  -- MEDIA-1: una publicación NUEVA exige al menos un archivo (el resto de comprobaciones del asset siguen más abajo).
  if v_is_create and v_media_count = 0 then
    raise exception 'media_required';
  end if;

  select count(*), count(distinct (elem->>'asset_id')::uuid)
    into v_media_count, v_distinct_asset_count
    from jsonb_array_elements(p_media) as elem;
  if v_media_count <> v_distinct_asset_count then
    raise exception 'duplicate_asset_id';
  end if;

  if v_media_count > 0 then
    select count(distinct (elem->>'position')::int) into v_distinct_position_count
      from jsonb_array_elements(p_media) as elem;
    if v_distinct_position_count <> v_media_count then
      raise exception 'invalid_positions';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_media) as elem
      where (elem->>'position')::int < 0 or (elem->>'position')::int >= v_media_count
    ) then
      raise exception 'invalid_positions';
    end if;
  end if;

  if v_is_create then
    v_post_id := gen_random_uuid();
    v_current_version := 0;
    v_existing_media_asset_ids := array[]::uuid[];
  else
    select id, version, author_user_id into v_post_id, v_current_version, v_author
      from public.community_posts
      where id = p_post_id
      for update;
    if not found then
      raise exception 'post_not_found';
    end if;
    if v_author <> p_actor_user_id then
      raise exception 'not_owner';
    end if;
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge','held_for_review')) then
      raise exception 'post_not_editable';
    end if;
    if p_expected_version is null or v_current_version <> p_expected_version then
      raise exception 'version_conflict';
    end if;

    select coalesce(array_agg(asset_id), array[]::uuid[]) into v_existing_media_asset_ids
      from public.community_post_media where post_id = v_post_id;
  end if;

  -- Ninguna media YA adjunta puede faltar en p_media: desadjuntar exige el flujo explícito.
  select count(*) into v_missing_existing
    from public.community_post_media cpm
    where cpm.post_id = v_post_id
      and not exists (
        select 1 from jsonb_array_elements(p_media) as elem
        where (elem->>'asset_id')::uuid = cpm.asset_id
      );
  if v_missing_existing > 0 then
    raise exception 'media_missing_existing';
  end if;

  select coalesce(array_agg((elem->>'asset_id')::uuid), array[]::uuid[]) into v_incoming_asset_ids
    from jsonb_array_elements(p_media) as elem;

  select coalesce(array_agg(a.id), array[]::uuid[]) into v_new_asset_ids
    from unnest(v_incoming_asset_ids) as a(id)
    where not (a.id = any(v_existing_media_asset_ids));

  if array_length(v_new_asset_ids, 1) > 0 then
    -- Bloquea los assets nuevos ANTES de comprobar su elegibilidad: dos guardados concurrentes
    -- intentando adjuntar el mismo asset recién-listo nunca pueden ganar ambos.
    perform 1 from public.media_assets where id = any(v_new_asset_ids) for update;

    if (select count(*) from public.media_assets where id = any(v_new_asset_ids))
        <> array_length(v_new_asset_ids, 1) then
      raise exception 'invalid_asset';
    end if;
    if exists (
      select 1 from public.media_assets where id = any(v_new_asset_ids) and domain <> 'community'
    ) then
      raise exception 'foreign_asset';
    end if;
    if exists (
      select 1 from public.media_assets where id = any(v_new_asset_ids) and status <> 'ready'
    ) then
      raise exception 'asset_not_ready';
    end if;
    if exists (
      select 1 from public.media_assets
      where id = any(v_new_asset_ids) and created_by is distinct from p_actor_user_id
    ) then
      raise exception 'foreign_asset';
    end if;
    if exists (
      select 1 from public.community_post_media where asset_id = any(v_new_asset_ids)
    ) then
      raise exception 'asset_already_attached';
    end if;
  end if;

  -- Invariante "texto o media" (sección producto congelada): evaluado con el estado FINAL de la
  -- galería (existente conservada + nueva) dentro de la MISMA transacción.
  v_final_media_count := coalesce(array_length(v_incoming_asset_ids, 1), 0);
  if (p_text is null or length(trim(p_text)) = 0) and v_final_media_count = 0 then
    raise exception 'empty_post';
  end if;

  -- Invariante nuevo (9J-3): como máximo 1 vídeo en el conjunto FINAL de media (existente
  -- conservada + nueva) — evaluado sobre TODOS los assets del post, no solo los nuevos, para que
  -- adjuntar un segundo vídeo en una edición posterior (con uno ya existente) también se rechace.
  if v_final_media_count > 0 then
    select count(*) into v_final_video_count
      from public.media_assets
      where id = any(v_incoming_asset_ids) and kind = 'video';
    if v_final_video_count > 1 then
      raise exception 'too_many_videos';
    end if;
  end if;

  if v_is_create then
    insert into public.community_posts (
      id, author_user_id, text, status, version, created_at, updated_at
    ) values (
      v_post_id, p_actor_user_id, p_text, 'published', 1, v_now, v_now
    );
  else
    update public.community_posts set
      text = p_text,
      version = v_current_version + 1,
      updated_at = v_now
    where id = v_post_id;
  end if;

  -- Actualiza posición de la media YA adjunta (el join con jsonb_array_elements no afecta filas
  -- para los asset_id todavía no adjuntos).
  update public.community_post_media cpm set
    position = (elem->>'position')::int
  from jsonb_array_elements(p_media) as elem
  where cpm.post_id = v_post_id
    and cpm.asset_id = (elem->>'asset_id')::uuid;

  set constraints public.community_post_media_position_unique deferred;

  insert into public.community_post_media (post_id, asset_id, position, created_at)
  select v_post_id, (elem->>'asset_id')::uuid, (elem->>'position')::int, v_now
  from jsonb_array_elements(p_media) as elem
  where (elem->>'asset_id')::uuid = any(v_new_asset_ids);

  select to_jsonb(cp) into v_post_json from public.community_posts cp where cp.id = v_post_id;
  select coalesce(jsonb_agg(to_jsonb(cpm) order by cpm.position), '[]'::jsonb) into v_media_json
    from public.community_post_media cpm where cpm.post_id = v_post_id;

  return jsonb_build_object('post', v_post_json, 'media', v_media_json);
end;
$$;

create or replace function public.community_post_save_atomic(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_text text,
  p_media jsonb,
  p_removed_media_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_author uuid;
  v_version integer;
  v_removed_assets uuid[] := array[]::uuid[];
  v_cleanup_assets uuid[] := array[]::uuid[];
  v_had_media boolean := false;
  v_result jsonb;
begin
  if p_actor_user_id is null or p_removed_media_ids is null
     or cardinality(p_removed_media_ids) > 10
     or exists (select 1 from unnest(p_removed_media_ids) as r(id) where r.id is null)
     or cardinality(p_removed_media_ids) <> (select count(distinct id) from unnest(p_removed_media_ids) as r(id))
     or p_media is null or jsonb_typeof(p_media) <> 'array' then
    raise exception 'invalid_argument';
  end if;
  -- R5-C: guard BEFORE the post lock below (profiles -> community_posts); nothing is removed when restricted.
  perform public.community_assert_author_may_write(p_actor_user_id);

  if p_post_id is null then
    if cardinality(p_removed_media_ids) > 0 then
      raise exception 'invalid_argument';
    end if;
  else
    select author_user_id, version into v_author, v_version
      from public.community_posts where id = p_post_id for update;
    if not found then raise exception 'post_not_found'; end if;
    if v_author <> p_actor_user_id then raise exception 'not_owner'; end if;
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge','held_for_review')) then
      raise exception 'post_not_editable';
    end if;
    if p_expected_version is null or v_version <> p_expected_version then
      raise exception 'version_conflict';
    end if;

    perform 1 from public.community_post_media
      where post_id = p_post_id order by id for update;
    -- MEDIA-1: un post que ya tiene archivos no puede quedarse sin ninguno; uno histórico de solo texto sigue siendo editable.
    v_had_media := exists (select 1 from public.community_post_media where post_id = p_post_id);
    if v_had_media and jsonb_array_length(p_media) = 0 then
      raise exception 'media_required';
    end if;
    if (select count(*) from public.community_post_media
        where post_id = p_post_id and id = any(p_removed_media_ids))
        <> cardinality(p_removed_media_ids) then
      raise exception 'media_not_found';
    end if;
    if exists (
      select 1 from public.community_post_media m
      join jsonb_array_elements(p_media) as elem on m.asset_id = (elem->>'asset_id')::uuid
      where m.post_id = p_post_id and m.id = any(p_removed_media_ids)
    ) then
      raise exception 'invalid_argument';
    end if;
    select coalesce(array_agg(asset_id), array[]::uuid[]) into v_removed_assets
      from public.community_post_media where post_id = p_post_id and id = any(p_removed_media_ids);
  end if;

  -- Bloqueo de assets antes de cambiar asociaciones; orden estable para operaciones combinadas.
  perform 1 from public.media_assets a
    where a.id = any(v_removed_assets) or a.id in (
      select (elem->>'asset_id')::uuid from jsonb_array_elements(p_media) as elem
    ) order by a.id for update;

  -- Debe diferirse ANTES del UPDATE de posiciones del guardado delegado (intercambios).
  set constraints public.community_post_media_position_unique deferred;
  delete from public.community_post_media
    where post_id = p_post_id and id = any(p_removed_media_ids);

  -- La protección media_missing_existing sigue comprobando TODOS los adjuntos no retirados.
  -- Si falla este guardado o cualquier paso posterior, PostgreSQL revierte también el DELETE.
  v_result := public.community_post_save(
    p_actor_user_id, p_post_id, p_expected_version, p_text, p_media
  );

  -- UNIQUE(asset_id) impide referencias en varias publicaciones de Community. Se comprueban
  -- además ambas asociaciones conocidas antes de transicionar un asset subyacente compartido.
  with transitioned as (
    update public.media_assets a set status = 'deleting', updated_at = clock_timestamp()
      where a.id = any(v_removed_assets) and a.status = 'ready'
        and not exists (select 1 from public.community_post_media m where m.asset_id = a.id)
        and not exists (select 1 from public.cosplay_post_images i where i.asset_id = a.id)
      returning a.id
  ) select coalesce(array_agg(id), array[]::uuid[]) into v_cleanup_assets from transitioned;

  return v_result || jsonb_build_object('cleanup_asset_ids', to_jsonb(v_cleanup_assets));
end;
$$;

create or replace function public.community_post_detach_media(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_media_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_current_version integer;
  v_author uuid;
  v_text text;
  v_asset_id uuid;
  v_asset_status text;
  v_remaining_media integer;
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null
     or p_media_id is null then
    raise exception 'invalid_argument';
  end if;

  -- R5-C: guard BEFORE the post lock (profiles -> community_posts); nothing is detached when restricted.
  perform public.community_assert_author_may_write(p_actor_user_id);

  select version, author_user_id, text into v_current_version, v_author, v_text
    from public.community_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_author <> p_actor_user_id then
    raise exception 'not_owner';
  end if;
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge','held_for_review')) then
      raise exception 'post_not_editable';
    end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select asset_id into v_asset_id
    from public.community_post_media
    where id = p_media_id and post_id = p_post_id;
  if not found then
    raise exception 'media_not_found';
  end if;

  select count(*) into v_remaining_media
    from public.community_post_media where post_id = p_post_id and id <> p_media_id;
  -- MEDIA-1: el último archivo de una publicación no se puede retirar (antes solo se impedía si no quedaba texto).
  if v_remaining_media = 0 then
    raise exception 'media_required';
  end if;

  delete from public.community_post_media where id = p_media_id;

  select status into v_asset_status from public.media_assets where id = v_asset_id for update;
  if found and v_asset_status = 'ready' then
    update public.media_assets set status = 'deleting', updated_at = v_now where id = v_asset_id;
  end if;

  update public.community_posts
    set version = v_current_version + 1, updated_at = v_now
    where id = p_post_id;

  return jsonb_build_object('asset_id', v_asset_id, 'version', v_current_version + 1);
end;
$$;

create or replace function public.community_post_reorder_media(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_expected_version integer,
  p_positions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_current_version integer;
  v_author uuid;
  v_existing_ids uuid[];
  v_incoming_ids uuid[];
  v_count integer;
  v_distinct_ids integer;
  v_distinct_positions integer;
begin
  if p_actor_user_id is null or p_post_id is null or p_expected_version is null then
    raise exception 'invalid_argument';
  end if;
  if p_positions is null or jsonb_typeof(p_positions) <> 'array' then
    raise exception 'invalid_argument';
  end if;

  -- R5-C: guard BEFORE the post lock (profiles -> community_posts); no order/version mutation when restricted.
  perform public.community_assert_author_may_write(p_actor_user_id);

  select version, author_user_id into v_current_version, v_author
    from public.community_posts where id = p_post_id for update;
  if not found then
    raise exception 'post_not_found';
  end if;
  if v_author <> p_actor_user_id then
    raise exception 'not_owner';
  end if;
    if exists (select 1 from public.community_posts where id = p_post_id and status in ('hidden_pending_review','hidden','removed_pending_purge','held_for_review')) then
      raise exception 'post_not_editable';
    end if;
  if v_current_version <> p_expected_version then
    raise exception 'version_conflict';
  end if;

  select coalesce(array_agg(id), array[]::uuid[]) into v_existing_ids
    from public.community_post_media where post_id = p_post_id;

  select count(*), count(distinct (elem->>'media_id')::uuid),
         count(distinct (elem->>'position')::int)
    into v_count, v_distinct_ids, v_distinct_positions
    from jsonb_array_elements(p_positions) as elem;

  if v_count > 10 then
    raise exception 'too_many_media';
  end if;
  if v_count <> v_distinct_ids or v_count <> v_distinct_positions then
    raise exception 'invalid_positions';
  end if;
  if v_count <> coalesce(array_length(v_existing_ids, 1), 0) then
    raise exception 'media_missing_existing';
  end if;

  select coalesce(array_agg((elem->>'media_id')::uuid), array[]::uuid[]) into v_incoming_ids
    from jsonb_array_elements(p_positions) as elem;
  if exists (
    select 1 from unnest(v_existing_ids) as e(id) where not (e.id = any(v_incoming_ids))
  ) then
    raise exception 'media_missing_existing';
  end if;
  if v_count > 0 and exists (
    select 1 from jsonb_array_elements(p_positions) as elem
    where (elem->>'position')::int < 0 or (elem->>'position')::int >= v_count
  ) then
    raise exception 'invalid_positions';
  end if;

  set constraints public.community_post_media_position_unique deferred;

  update public.community_post_media cpm
    set position = (elem->>'position')::int
    from jsonb_array_elements(p_positions) as elem
    where cpm.post_id = p_post_id
      and cpm.id = (elem->>'media_id')::uuid;

  update public.community_posts
    set version = v_current_version + 1, updated_at = v_now
    where id = p_post_id;

  return jsonb_build_object('version', v_current_version + 1);
end;
$$;

create or replace function public.community_media_delivery_state(p_asset_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_domain text; v_status text; v_post_status text; v_purge_after timestamptz; v_attached boolean;
  v_denied constant jsonb := jsonb_build_object('exists',false,'domain',null,'delivery','denied','privateUntil',null);
begin
  if p_asset_id is null then raise exception 'invalid_argument'; end if;
  select a.domain, a.status into v_domain, v_status from public.media_assets a where a.id = p_asset_id;
  -- Missing assets and any non-Community domain are indistinguishable from each other.
  if not found or v_domain is distinct from 'community' then return v_denied; end if;
  -- Only fully processed assets can be delivered; reserved/processing/failed/deleting never are.
  if v_status is distinct from 'ready' then
    return jsonb_build_object('exists',true,'domain','community','delivery','denied','privateUntil',null);
  end if;
  select true, p.status, p.purge_after into v_attached, v_post_status, v_purge_after
    from public.community_post_media m join public.community_posts p on p.id = m.post_id
    where m.asset_id = p_asset_id;
  if not coalesce(v_attached, false) then
    -- Ready but not attached yet (editor preview): never public; only a creator-preview capability.
    return jsonb_build_object('exists',true,'domain','community','delivery','private','privateUntil',null);
  end if;
  if v_post_status = 'published' then
    return jsonb_build_object('exists',true,'domain','community','delivery','public','privateUntil',null);
  elsif v_post_status in ('hidden_pending_review', 'held_for_review') then
    return jsonb_build_object('exists',true,'domain','community','delivery','private','privateUntil',null);
  elsif v_post_status = 'removed_pending_purge' and v_purge_after is not null and v_now < v_purge_after then
    return jsonb_build_object('exists',true,'domain','community','delivery','private','privateUntil',v_purge_after);
  end if;
  return jsonb_build_object('exists',true,'domain','community','delivery','denied','privateUntil',null);
end;
$$;

create or replace function public.media_abandoned_sweep(
  p_ready_min_age interval default interval '72 hours',
  p_pending_min_age interval default interval '24 hours',
  p_failed_min_age interval default interval '72 hours',
  p_limit integer default 50,
  p_include_cosplay_ready boolean default false
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_cand record;
  v_a public.media_assets%rowtype;
  v_ready integer := 0;
  v_pending integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
begin
  if p_ready_min_age is null or p_pending_min_age is null or p_failed_min_age is null
    or p_limit is null or p_include_cosplay_ready is null
    or p_ready_min_age < interval '6 hours'
    or p_pending_min_age < interval '2 hours'
    or p_failed_min_age < interval '6 hours'
    or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_argument';
  end if;

  for v_cand in
    select a.id from public.media_assets a
     where a.domain in ('community', 'cosplay')
       and (
         (a.status = 'ready' and a.updated_at <= v_now - p_ready_min_age
           and (a.domain = 'community' or p_include_cosplay_ready)
           -- Excluir los referenciados EN LA SELECCIÓN: si no, los ready ya publicados (los más
           -- numerosos y antiguos) agotarían el límite y los abandonados nunca llegarían a ser
           -- candidatos. La revalidación bajo lock de abajo sigue siendo la barrera autoritativa.
           and not exists (select 1 from public.community_post_media m where m.asset_id = a.id)
           and not exists (select 1 from public.cosplay_post_images i where i.asset_id = a.id)
           and not exists (select 1 from public.community_post_pending_edit_media pe where pe.asset_id = a.id))
         or (a.status in ('reserved', 'uploaded', 'verifying', 'processing')
           and a.updated_at <= v_now - p_pending_min_age)
         or (a.status = 'failed' and a.updated_at <= v_now - p_failed_min_age))
     order by a.updated_at, a.id
     limit p_limit
     for update skip locked
  loop
    -- Revalidación bajo lock: el estado y las referencias pudieron cambiar desde la selección.
    select * into v_a from public.media_assets where id = v_cand.id for update;
    if not found or v_a.status = 'deleting' then v_skipped := v_skipped + 1; continue; end if;
    if v_a.status = 'ready' and (
      exists (select 1 from public.community_post_media m where m.asset_id = v_a.id)
      or exists (select 1 from public.cosplay_post_images i where i.asset_id = v_a.id)
      or exists (select 1 from public.community_post_pending_edit_media pe where pe.asset_id = v_a.id)) then
      v_skipped := v_skipped + 1; continue;
    end if;

    update public.media_assets
       set status = 'deleting', failure_code = null, updated_at = v_now
     where id = v_a.id;
    if v_a.status = 'ready' then v_ready := v_ready + 1;
    elsif v_a.status = 'failed' then v_failed := v_failed + 1;
    else v_pending := v_pending + 1; end if;
  end loop;

  return jsonb_build_object('readyMarked', v_ready, 'pendingMarked', v_pending,
    'failedMarked', v_failed, 'skipped', v_skipped, 'serverNow', v_now);
end;
$$;

create or replace function public.community_media_asset_discard(p_asset_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_a public.media_assets%rowtype;
begin
  if p_asset_id is null or p_actor_user_id is null then raise exception 'invalid_argument'; end if;

  select * into v_a from public.media_assets where id = p_asset_id for update;
  -- Ajeno e inexistente son indistinguibles para el llamador.
  if not found or v_a.domain <> 'community' or v_a.created_by is distinct from p_actor_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_a.status = 'deleting' then return jsonb_build_object('result', 'already_deleting'); end if;
  if v_a.status <> 'ready' then return jsonb_build_object('result', 'not_ready'); end if;
  if exists (select 1 from public.community_post_media m where m.asset_id = v_a.id)
    or exists (select 1 from public.cosplay_post_images i where i.asset_id = v_a.id)
     or exists (select 1 from public.community_post_pending_edit_media pe where pe.asset_id = v_a.id) then
    return jsonb_build_object('result', 'referenced');
  end if;

  update public.media_assets
     set status = 'deleting', failure_code = null, updated_at = clock_timestamp()
   where id = v_a.id;
  return jsonb_build_object('result', 'marked');
end;
$$;

alter function public.community_post_save(uuid,uuid,integer,text,jsonb) owner to postgres;
revoke all on function public.community_post_save(uuid,uuid,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.community_post_save(uuid,uuid,integer,text,jsonb) to service_role;
alter function public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[]) owner to postgres;
revoke all on function public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[]) from public, anon, authenticated;
grant execute on function public.community_post_save_atomic(uuid,uuid,integer,text,jsonb,uuid[]) to service_role;
alter function public.community_post_detach_media(uuid,uuid,integer,uuid) owner to postgres;
revoke all on function public.community_post_detach_media(uuid,uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.community_post_detach_media(uuid,uuid,integer,uuid) to service_role;
alter function public.community_post_reorder_media(uuid,uuid,integer,jsonb) owner to postgres;
revoke all on function public.community_post_reorder_media(uuid,uuid,integer,jsonb) from public, anon, authenticated;
grant execute on function public.community_post_reorder_media(uuid,uuid,integer,jsonb) to service_role;
alter function public.community_media_delivery_state(uuid) owner to postgres;
revoke all on function public.community_media_delivery_state(uuid) from public, anon, authenticated;
grant execute on function public.community_media_delivery_state(uuid) to service_role;
alter function public.media_abandoned_sweep(interval,interval,interval,integer,boolean) owner to postgres;
revoke all on function public.media_abandoned_sweep(interval,interval,interval,integer,boolean) from public, anon, authenticated;
grant execute on function public.media_abandoned_sweep(interval,interval,interval,integer,boolean) to service_role;
alter function public.community_media_asset_discard(uuid,uuid) owner to postgres;
revoke all on function public.community_media_asset_discard(uuid,uuid) from public, anon, authenticated;
grant execute on function public.community_media_asset_discard(uuid,uuid) to service_role;
alter function public.community_post_pending_edit_submit(uuid,uuid,integer,text,jsonb,uuid[]) owner to postgres;
revoke all on function public.community_post_pending_edit_submit(uuid,uuid,integer,text,jsonb,uuid[]) from public, anon, authenticated;
grant execute on function public.community_post_pending_edit_submit(uuid,uuid,integer,text,jsonb,uuid[]) to service_role;
alter function public.community_post_pending_edit_cancel(uuid,uuid) owner to postgres;
revoke all on function public.community_post_pending_edit_cancel(uuid,uuid) from public, anon, authenticated;
grant execute on function public.community_post_pending_edit_cancel(uuid,uuid) to service_role;
alter function public.community_post_pending_edit_reject(uuid,uuid) owner to postgres;
revoke all on function public.community_post_pending_edit_reject(uuid,uuid) from public, anon, authenticated;
grant execute on function public.community_post_pending_edit_reject(uuid,uuid) to service_role;
alter function public.community_post_pending_edit_approve(uuid,uuid,integer) owner to postgres;
revoke all on function public.community_post_pending_edit_approve(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.community_post_pending_edit_approve(uuid,uuid,integer) to service_role;
alter function public.community_post_create_held(uuid,text,jsonb) owner to postgres;
revoke all on function public.community_post_create_held(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.community_post_create_held(uuid,text,jsonb) to service_role;
alter function public.community_post_hold_release(uuid,uuid,integer) owner to postgres;
revoke all on function public.community_post_hold_release(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.community_post_hold_release(uuid,uuid,integer) to service_role;
alter function public.community_post_hold_reject(uuid,uuid,integer) owner to postgres;
revoke all on function public.community_post_hold_reject(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.community_post_hold_reject(uuid,uuid,integer) to service_role;
alter function public.community_author_pending_read(uuid) owner to postgres;
revoke all on function public.community_author_pending_read(uuid) from public, anon, authenticated;
grant execute on function public.community_author_pending_read(uuid) to service_role;
alter function public.community_pending_edit_close(uuid,text,uuid,uuid[]) owner to postgres;
revoke all on function public.community_pending_edit_close(uuid,text,uuid,uuid[]) from public, anon, authenticated, service_role;
