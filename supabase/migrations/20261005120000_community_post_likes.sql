-- Likes de Comunidad + ranking "Populares" de 7 días (Fase 9J-2C). Un like es una relación
-- user_id/post_id: como máximo UNO activo por usuario y publicación (clave primaria compuesta —
-- ni un UNIQUE separado ni una columna `active` con soft-delete: "dar like otra vez" siempre borra
-- la fila existente, nunca la marca inactiva, así que la tabla nunca acumula historial de likes
-- retirados). Mismo patrón de seguridad que community_posts/community_post_media: RLS activado y
-- FORZADO, CERO policies para anon/authenticated, acceso exclusivo service_role. Mutación
-- exclusivamente vía la RPC SECURITY DEFINER community_post_set_like (abajo), que re-verifica que
-- la publicación existe y sigue 'published' bajo lock — igual que community_post_save/_delete
-- re-verifican author_user_id, aquí no hay "dueño" que verificar: cualquier usuario autenticado
-- (incluido el propio autor) puede dar like a cualquier publicación published.
--
-- `community_posts.like_count` es un contador DESNORMALIZADO, mantenido por trigger sobre
-- community_post_likes (insert/delete). Se elige denormalizar (en vez de un COUNT(*) en cada
-- lectura) porque la pestaña "Populares" necesita ORDER BY like_count DESC de forma barata e
-- indexable — un JOIN+COUNT por página en cada request del feed público sería mucho más caro sin
-- aportar nada que el trigger no garantice ya de forma transaccionalmente consistente (el UPDATE
-- del contador ocurre bajo el mismo lock de fila que la propia inserción/borrado del like, dentro
-- de la RPC).

create table public.community_post_likes (
  post_id     uuid not null references public.community_posts(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),

  constraint community_post_likes_pkey primary key (post_id, user_id)
);

comment on table public.community_post_likes is
  'Likes de publicaciones de Comunidad. Como máximo un like activo por (post_id, user_id) — la PK compuesta lo garantiza a nivel de base de datos, no solo en la capa de aplicación. Mutación exclusiva vía community_post_set_like (SECURITY DEFINER). Acceso exclusivo server-side (service_role): sin policy pública, igual que community_posts/community_post_media.';
comment on column public.community_post_likes.post_id is
  'ON DELETE CASCADE: si la publicación se borra (borrado duro del autor), sus likes desaparecen con ella sin dejar filas huérfanas.';
comment on column public.community_post_likes.user_id is
  'Autor del like, verificado por JWT (requireAuthenticated) en la capa de aplicación — la RPC nunca confía en un user_id del body. ON DELETE CASCADE: si la cuenta desaparece, sus likes desaparecen con ella.';

alter table public.community_post_likes enable row level security;
alter table public.community_post_likes force row level security;

revoke all on table public.community_post_likes from public;
revoke all on table public.community_post_likes from anon;
revoke all on table public.community_post_likes from authenticated;
revoke all on table public.community_post_likes from service_role;
grant select, insert, delete on table public.community_post_likes to service_role;

-- "¿Cuáles de estos postId dio like este usuario?" (community-post-liked-by-me) y el propio
-- recuento por publicación antes de que exista el trigger/columna denormalizada (usado también
-- por el propio trigger de sincronización).
create index community_post_likes_by_post on public.community_post_likes (post_id);
-- "¿A qué dio like este usuario?", por si un futuro checkpoint lista los likes propios.
create index community_post_likes_by_user on public.community_post_likes (user_id);

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- community_posts.like_count: contador desnormalizado (ver comentario de cabecera). Todas las
-- publicaciones existentes empiezan en 0 (no hay likes todavía en este checkpoint).
alter table public.community_posts add column like_count integer not null default 0
  check (like_count >= 0);

comment on column public.community_posts.like_count is
  'Contador desnormalizado de community_post_likes, mantenido por el trigger community_post_likes_sync_count_trigger. Fuente de verdad para likeCount en las representaciones públicas (feed/detalle/perfil) y para el ranking "Populares" (ORDER BY like_count DESC) — nunca se recalcula con un COUNT(*) en cada lectura.';

-- Índice para "Populares": status='published' + like_count DESC + created_at DESC + id DESC (el
-- filtro adicional por ventana de 7 días se aplica sobre created_at en la propia consulta; no se
-- puede codificar "últimos 7 días" en un índice parcial porque now() no es IMMUTABLE).
create index community_posts_popular on public.community_posts
  (status, like_count desc, created_at desc, id desc);

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- Trigger: mantiene community_posts.like_count sincronizado con community_post_likes. SECURITY
-- DEFINER porque community_posts solo es escribible por service_role (ver community_posts_media)
-- y este trigger se dispara para cualquier fila insertada/borrada en community_post_likes,
-- incluidas las borradas en cascada por community_post_delete. Cuando el borrado es en cascada
-- (la publicación ya desapareció en la MISMA sentencia), el UPDATE de abajo no afecta ninguna
-- fila — no es un error, simplemente no hay nada que sincronizar para una publicación que ya no
-- existe.
create or replace function public.community_post_likes_sync_count()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    update public.community_posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.community_posts
      set like_count = greatest(like_count - 1, 0)
      where id = old.post_id;
  end if;
  return null;
end;
$$;

comment on function public.community_post_likes_sync_count() is
  'Trigger AFTER INSERT/DELETE sobre community_post_likes: mantiene community_posts.like_count desnormalizado. No hace nada si la publicación ya no existe (borrado en cascada).';

-- Mismo patrón que profiles_before_update/admin_roles_last_admin_guard: una función de trigger
-- SECURITY DEFINER sigue siendo invocable como RPC pública (PostgREST) salvo que se revoque EXECUTE
-- explícitamente — el linter de seguridad de Supabase (anon_security_definer_function_executable)
-- la marcaría si no se hiciera. El propio mecanismo de disparo de un trigger nunca necesita este
-- grant: solo lo necesitaría una llamada RPC directa, que aquí nunca debe ser posible.
revoke all on function public.community_post_likes_sync_count() from public;
revoke execute on function public.community_post_likes_sync_count() from anon;
revoke execute on function public.community_post_likes_sync_count() from authenticated;

create trigger community_post_likes_sync_count_trigger
after insert or delete on public.community_post_likes
for each row execute function public.community_post_likes_sync_count();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- community_post_set_like: operación idempotente de estado (nunca lectura-luego-escritura desde
-- TypeScript). p_liked=true garantiza EXACTAMENTE un like; p_liked=false garantiza CERO. El
-- `select ... for update` sobre community_posts serializa likes/unlikes concurrentes del MISMO
-- post (de distintos usuarios inclusive) además de la garantía ya dada por la PK compuesta —
-- ninguna doble inserción concurrente puede duplicar una fila ni desincronizar el contador.
--
-- Fail-closed: una publicación inexistente, borrada o 'hidden' (no publicada) nunca puede recibir
-- ni perder un like — mismo criterio "post_not_found" que usan community_post_save/_delete al no
-- encontrar la fila bajo lock (aquí también cubre 'hidden', que SÍ existe pero no es pública).
--
-- Cualquier usuario autenticado puede dar like a su PROPIA publicación (el checkpoint lo exige
-- explícitamente): a diferencia de community_post_save/_delete, esta función nunca compara
-- author_user_id contra p_actor_user_id.
create or replace function public.community_post_set_like(
  p_actor_user_id uuid,
  p_post_id uuid,
  p_liked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
  v_like_count integer;
  v_liked_by_me boolean;
begin
  if p_actor_user_id is null or p_post_id is null or p_liked is null then
    raise exception 'invalid_argument';
  end if;

  select status into v_status from public.community_posts where id = p_post_id for update;
  if not found or v_status <> 'published' then
    raise exception 'post_not_found';
  end if;

  if p_liked then
    insert into public.community_post_likes (post_id, user_id)
      values (p_post_id, p_actor_user_id)
      on conflict (post_id, user_id) do nothing;
  else
    delete from public.community_post_likes
      where post_id = p_post_id and user_id = p_actor_user_id;
  end if;

  select like_count into v_like_count from public.community_posts where id = p_post_id;
  v_liked_by_me := exists (
    select 1 from public.community_post_likes
    where post_id = p_post_id and user_id = p_actor_user_id
  );

  return jsonb_build_object(
    'postId', p_post_id,
    'likeCount', v_like_count,
    'likedByMe', v_liked_by_me
  );
end;
$$;

comment on function public.community_post_set_like(uuid, uuid, boolean) is
  'Operación idempotente de estado: p_liked=true garantiza exactamente un like de p_actor_user_id en p_post_id; p_liked=false garantiza cero. Re-verifica bajo lock que la publicación existe y sigue published (post_not_found en cualquier otro caso — nunca distingue borrada/oculta/inexistente). Cualquier usuario autenticado, incluido el propio autor. SOLO service_role (EXECUTE).';

revoke all on function public.community_post_set_like(uuid, uuid, boolean) from public;
revoke execute on function public.community_post_set_like(uuid, uuid, boolean) from anon;
revoke execute on function public.community_post_set_like(uuid, uuid, boolean) from authenticated;
grant execute on function public.community_post_set_like(uuid, uuid, boolean) to service_role;
