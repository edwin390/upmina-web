-- «OLVIDÉ MI CONTRASEÑA» — COMPROBACIÓN DEL CORREO (confirmed | unconfirmed | none) + LÍMITES POR CAPAS.
-- PROPUESTA LOCAL: NO aplicada en ningún entorno. Forward-only, posterior a 20261104120000 (que no se modifica).
-- Revisada en el lote 3P-S (IP confiable, disponibilidad y límites de Supabase Auth).
--
-- Decisión de producto (aceptada expresamente por el propietario): el formulario REVELA si una cuenta está registrada, para
-- poder ofrecer «Crear cuenta con [correo]», pedir confirmar una cuenta pendiente o enviar la recuperación. Esto abre un
-- vector de enumeración de cuentas; por eso la consulta tiene límites del lado del servidor y NO es una función pública.
--
--   * public.auth_email_lookup(p_email, p_ip, p_net) → jsonb. SECURITY DEFINER, search_path fijo, SOLO service_role (el
--     backend la llama tras validar la forma del correo; nunca el navegador). Normaliza el correo (btrim + lower, igual que
--     GoTrue al escribirlo), lo busca de forma EXACTA en auth.users (excluyendo cuentas borradas) y devuelve únicamente
--     {status:'confirmed'|'unconfirmed'|'none'}: ni ids, ni fechas, ni metadatos. Forma inválida → {status:'invalid'} sin
--     consumir cuota. Superado un límite → {status:'rate_limited', retryAfterSeconds}, SIN consultar auth.users.
--   * p_ip y p_net NO son IPs: son digests HMAC de 64 hex (o 'unknown') calculados por el backend a partir de la IP y de su
--     red (/24 IPv4, /48 IPv6) con un secreto del servidor. La base nunca ve ni guarda una IP en claro.
--
-- LÍMITES POR CAPAS (sin un contador global que cualquiera pueda agotar para bloquear a todos; ventanas fijas):
--   1. Por IP        : 20 consultas / 10 min  y 100 / hora.            (NAT: una oficina completa cabe holgadamente)
--   2. Por red       : 100 consultas / 10 min por /24 (IPv4) o /48 (IPv6).  (frena la rotación dentro de un mismo rango)
--   3. Fallos por IP : 8 resultados «none»/«unconfirmed» / 10 min.     (la señal de ENUMERACIÓN: un escaneo desde una IP se
--      frena tras 8 fallos; una persona legítima rara vez tiene más de unos pocos). Al superarlo se rechaza TODO desde esa IP
--      (acierte o no), así que el rechazo no revela nada. Se serializa por fila (SELECT … FOR UPDATE): peticiones simultáneas
--      de la misma IP no pueden colarse entre la comprobación y el incremento.
--   4. Por correo    : 5 envíos potenciales / hora — SOLO se cuentan las consultas cuyo resultado es «confirmed» (las que
--      terminan en un correo de recuperación). Consultar correos inexistentes o sin confirmar NUNCA gasta la cuota de nadie:
--      un atacante no puede agotar la cuota de una víctima probando direcciones, y el límite protege su bandeja.
--   NO hay límite global de consultas: era una palanca barata para que un atacante bloqueara a todos. Un ataque distribuido
--   (muchas IPs) queda acotado por IP y por red; la defensa de último recurso es del perímetro (reglas del Firewall de Vercel),
--   no de la base de datos. IP desconocida ('unknown', no debería ocurrir en Vercel): usa su propio bucket con los mismos
--   límites y sin límite de red.
--   Orden fijo de los contadores (ip10 → ip60 → net10 → miss10 → email60): sin interbloqueos. Cada UPSERT es atómico.
--   Cambiar un límite exige una migración nueva.
--
--   * Los contadores NO guardan correos ni IPs: solo un digest SHA-256 con una sal secreta que vive en la propia base
--     (auth_lookup_salt, generada aquí con gen_random_uuid(); sin acceso para anon/authenticated/service_role).
--   * Retención: cada llamada borra hasta 100 ventanas con más de 2 días (índice por window_start).
--   * Las dos tablas y el ayudante interno son privados: RLS + FORCE RLS sin policies ni grants; el ayudante sin EXECUTE
--     para ningún rol de API.
-- Rollback (solo local/operador): supabase/rollbacks/20261105120000_password_recovery_lookup.rollback.sql

create table public.auth_lookup_limits (
  scope        text        not null check (scope in ('ip10', 'ip60', 'net10', 'miss10', 'email60')),
  key_digest   text        not null check (key_digest ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits         integer     not null default 0 check (hits >= 0),
  primary key (scope, key_digest, window_start)
);
create index auth_lookup_limits_window_idx on public.auth_lookup_limits (window_start);
alter table public.auth_lookup_limits enable row level security;
alter table public.auth_lookup_limits force row level security;
revoke all on table public.auth_lookup_limits from public, anon, authenticated, service_role;
comment on table public.auth_lookup_limits is
  'Contadores de auth_email_lookup por ventana fija. Solo digests SHA-256 salados (nunca correos ni IPs en claro). Privada: sin acceso para ningún rol de API; la escribe únicamente la función SECURITY DEFINER. Se purga sola (>2 días).';

create table public.auth_lookup_salt (
  id   boolean primary key default true check (id),
  salt text    not null check (char_length(salt) >= 64)
);
alter table public.auth_lookup_salt enable row level security;
alter table public.auth_lookup_salt force row level security;
revoke all on table public.auth_lookup_salt from public, anon, authenticated, service_role;
insert into public.auth_lookup_salt (id, salt) values (true, gen_random_uuid()::text || gen_random_uuid()::text);
comment on table public.auth_lookup_salt is
  'Sal secreta (una fila) de los digests de auth_lookup_limits. Privada: sin acceso para ningún rol de API.';

-- Ayudante INTERNO: suma 1 al contador de (scope, digest) en su ventana y devuelve 0 si sigue dentro del límite o los
-- segundos que faltan para que acabe la ventana si lo superó. UPSERT atómico. Sin EXECUTE para nadie salvo el propietario.
create function public.auth_lookup_hit_(
  p_scope text, p_digest text, p_len interval, p_limit integer, p_now timestamptz
) returns integer
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_start timestamptz := date_bin(p_len, p_now, timestamptz '2000-01-01 00:00:00+00');
  v_hits integer;
begin
  insert into public.auth_lookup_limits as l (scope, key_digest, window_start, hits)
    values (p_scope, p_digest, v_start, 1)
    on conflict (scope, key_digest, window_start)
    do update set hits = least(l.hits + 1, 1000000)
    returning l.hits into v_hits;
  if v_hits > p_limit then
    return greatest(1, ceil(extract(epoch from (v_start + p_len - p_now)))::integer);
  end if;
  return 0;
end;
$$;
alter function public.auth_lookup_hit_(text, text, interval, integer, timestamptz) owner to postgres;
revoke execute on function public.auth_lookup_hit_(text, text, interval, integer, timestamptz)
  from public, anon, authenticated, service_role;

create function public.auth_email_lookup(p_email text, p_ip text, p_net text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_email text;
  v_salt text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_origin constant timestamptz := timestamptz '2000-01-01 00:00:00+00';
  v_ip_digest text;
  v_net_digest text;
  v_email_digest text;
  v_miss_start timestamptz;
  v_miss_hits integer;
  v_retry integer;
  v_found boolean := false;
  v_confirmed boolean;
  v_status text;
begin
  if p_email is null or p_ip is null or p_net is null then raise exception 'invalid_argument'; end if;
  if (p_ip <> 'unknown' and p_ip !~ '^[0-9a-f]{64}$') or (p_net <> 'unknown' and p_net !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid_argument';
  end if;
  v_email := lower(btrim(p_email));
  if char_length(v_email) not between 3 and 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select s.salt into v_salt from public.auth_lookup_salt s where s.id;
  if v_salt is null then raise exception 'salt_missing'; end if;

  v_ip_digest := encode(sha256(convert_to(v_salt || ':ip:' || p_ip, 'utf8')), 'hex');
  v_net_digest := encode(sha256(convert_to(v_salt || ':net:' || p_net, 'utf8')), 'hex');
  v_email_digest := encode(sha256(convert_to(v_salt || ':email:' || v_email, 'utf8')), 'hex');

  -- Retención: ventanas caducadas (>2 días), en lotes pequeños.
  delete from public.auth_lookup_limits l
   where l.ctid in (select x.ctid from public.auth_lookup_limits x
                     where x.window_start < v_now - interval '2 days' limit 100);

  -- Capas 1 y 2: volumen por IP y por red. Orden fijo.
  v_retry := public.auth_lookup_hit_('ip10', v_ip_digest, interval '10 minutes', 20, v_now);
  if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;
  v_retry := public.auth_lookup_hit_('ip60', v_ip_digest, interval '1 hour', 100, v_now);
  if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;
  if p_net <> 'unknown' then
    v_retry := public.auth_lookup_hit_('net10', v_net_digest, interval '10 minutes', 100, v_now);
    if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;
  end if;

  -- Capa 3: fallos (señal de enumeración) por IP. La fila se asegura y se BLOQUEA: las peticiones simultáneas de esta IP se
  -- serializan aquí, de modo que ninguna pasa la comprobación antes de que la anterior haya sumado su fallo.
  v_miss_start := date_bin(interval '10 minutes', v_now, v_origin);
  insert into public.auth_lookup_limits (scope, key_digest, window_start, hits)
    values ('miss10', v_ip_digest, v_miss_start, 0)
    on conflict (scope, key_digest, window_start) do nothing;
  select l.hits into v_miss_hits from public.auth_lookup_limits l
   where l.scope = 'miss10' and l.key_digest = v_ip_digest and l.window_start = v_miss_start
   for update;
  if v_miss_hits >= 8 then
    return jsonb_build_object('status', 'rate_limited',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_miss_start + interval '10 minutes' - v_now)))::integer));
  end if;

  select true, (u.email_confirmed_at is not null)
    into v_found, v_confirmed
    from auth.users u
   where u.email = v_email and u.deleted_at is null
   limit 1;
  v_status := case when not coalesce(v_found, false) then 'none'
                   when v_confirmed then 'confirmed' else 'unconfirmed' end;

  if v_status <> 'confirmed' then
    update public.auth_lookup_limits l set hits = least(l.hits + 1, 1000000)
     where l.scope = 'miss10' and l.key_digest = v_ip_digest and l.window_start = v_miss_start;
    return jsonb_build_object('status', v_status);
  end if;

  -- Capa 4: solo las consultas que terminan en un correo de recuperación gastan la cuota del correo.
  v_retry := public.auth_lookup_hit_('email60', v_email_digest, interval '1 hour', 5, v_now);
  if v_retry > 0 then return jsonb_build_object('status', 'rate_limited', 'retryAfterSeconds', v_retry); end if;
  return jsonb_build_object('status', 'confirmed');
end;
$$;
alter function public.auth_email_lookup(text, text, text) owner to postgres;

revoke execute on function public.auth_email_lookup(text, text, text) from public, anon, authenticated;
grant execute on function public.auth_email_lookup(text, text, text) to service_role;
