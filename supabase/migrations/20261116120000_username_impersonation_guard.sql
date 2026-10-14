-- Guard de suplantación de Mina/Upmina/Upminaa Web en profiles.username Y profiles.display_name.
-- LOCAL: NO aplicada en ningún entorno.
--
-- AUTORIDAD en PostgreSQL: cualquier INSERT/UPDATE de profiles.username o profiles.display_name (API,
-- RPC, SQL directo, service_role, upsert) pasa por un trigger que rechaza los valores que pueden
-- confundirse con la cuenta oficial (username: SQLSTATE UR001 / 'username_reserved'; display_name:
-- UR002 / 'display_name_reserved'). El algoritmo es EXACTAMENTE el de src/lib/username-impersonation.ts
-- (los mismos vectores se prueban en ambos lados):
--   1. normalización (NFKD, sin marcas, homoglifos, versalitas, invisibles, minúsculas);
--   2. dos esqueletos solo-letras: A (leet) y B (dígitos descartados);
--   3. bloqueo si algún esqueleto es [up]mina (con letras repetibles), lleva afijos de identidad o de
--      "página de fans", contiene "upmina" (SOLO username) o está a UNA edición de "upmina" (5–7 letras).
--      "mina" dentro de otra palabra NO se bloquea.
--   4. display_name (espacios, Unicode, emojis): mismo esqueleto pero SIN la regla 'embedded', para no
--      rechazar frases claramente personales ('Fan de Mina desde 2020').
-- Límites y política conservadora: docs/USERNAME-IMPERSONATION-GUARD.md.
--
-- No modifica ninguna fila existente (los triggers solo actúan en INSERT y en UPDATE OF username /
-- display_name con cambio real). Excepción FUTURA y no pública: grants administrativos auditables,
-- específicos de usuario + CAMPO + valor (sin endpoint, sin cuenta de Mina, sin permisos ni insignias):
-- solo `service_role` puede ejecutar grant/revoke, el actor debe ser ADMIN en admin_roles (la verificación
-- JWT + AAL2 la hará la futura capa de API), no puede concederse a sí mismo, exige motivo y deja un
-- registro append-only.

-- ---------------------------------------------------------------------------------------------
-- 1. Normalización y detección (puras, IMMUTABLE)
-- ---------------------------------------------------------------------------------------------
create function public.community_username_skeleton(p_username text, p_digits_as_letters boolean)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  s text;
begin
  if p_username is null then
    return '';
  end if;
  s := regexp_replace(p_username, '[™℠®©]', '', 'g'); -- ™ ℠ ® ©: NFKD los volvería TM/SM
  s := normalize(s, NFKD);
  s := regexp_replace(s, '[̀-ͯ]', '', 'g');
  s := regexp_replace(s, '[​-‏⁠﻿­]', '', 'g');
  -- Letras sin descomposición Unicode, versalitas y homoglifos cirílicos/griegos habituales → latín.
  s := lower(translate(
    s,
    U&'\00DF\1E9E\0142\0141\00F8\00D8\0111\0110\0131\0127\0126\0430\0435\043E\0440\0441\0456\043C\0443\0445\043A\0442\0410\0415\041E\0420\0421\0406\041C\0423\0425\041A\0422\03B1\03BF\03B9\03C1\0391\039F\0399\03A1\1D0D\026A\0274\1D00\1D1C\1D18',
    'ssllooddihhaeopcimyxktaeopcimyxktaoipaoipminaup'
  ));
  if p_digits_as_letters then
    s := translate(s, '013457@$!|l', 'oieastasiii');
  else
    s := regexp_replace(s, '[0-9]', '', 'g');
    s := translate(s, '@$!|l', 'asiii');
  end if;
  return regexp_replace(s, '[^a-z]', '', 'g');
end;
$$;

create function public.community_username_within_one_edit(a text, b text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  la integer := char_length(a);
  lb integer := char_length(b);
  i integer := 1;
begin
  if abs(la - lb) > 1 then
    return false;
  end if;
  if a = b then
    return true;
  end if;
  while i <= la and i <= lb and substr(a, i, 1) = substr(b, i, 1) loop
    i := i + 1;
  end loop;
  if la = lb then
    if substr(a, i + 1) = substr(b, i + 1) then
      return true;
    end if;
    return substr(a, i, 1) = substr(b, i + 1, 1)
       and substr(a, i + 1, 1) = substr(b, i, 1)
       and substr(a, i + 2) = substr(b, i + 2);
  elsif la > lb then
    return substr(a, i + 1) = substr(b, i);
  end if;
  return substr(a, i) = substr(b, i + 1);
end;
$$;

-- Devuelve el motivo más fuerte ('exact' < 'affixed' < 'declared' < 'embedded' < 'near') o NULL.
-- p_field: 'username' (aplica 'embedded') o 'display_name' (no lo aplica).
create function public.community_identity_impersonation(p_text text, p_field text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_base constant text := '(?:u+p+)?m+i+n+a+';
  v_aff text;
  v_auth text;
  v_decl text;
  v_s text;
  v_c text;
  v_leet boolean;
  v_rank integer;
  v_best integer := 99;
begin
  if p_field is null or p_field not in ('username', 'display_name') then
    raise exception 'invalid_argument';
  end if;
  select string_agg(regexp_replace(public.community_username_skeleton(a, true), '(.)', '\1+', 'g'), '|')
    into v_aff
    from unnest(array[
      'real', 'the', 'official', 'oficial', 'original', 'verified', 'verificado', 'team', 'staff',
      'admin', 'mod', 'moderator', 'support', 'soporte', 'account', 'cuenta', 'acc', 'true',
      'authentic', 'legit', 'its', 'iam', 'im', 'fan', 'fans', 'fanpage', 'fanclub', 'club', 'page',
      'web', 'website', 'site', 'soy', 'ich', 'bin'
    ]) as a;
  -- Solo display_name: palabras de autoridad y conectores (mismas listas que el módulo TS).
  select string_agg(regexp_replace(public.community_username_skeleton(a, true), '(.)', '\1+', 'g'), '|')
    into v_auth
    from unnest(array[
      'official', 'oficial', 'offiziell', 'offizielle', 'offizieller', 'offizielles', 'original',
      'verified', 'verificado', 'verifiziert', 'team', 'equipo', 'staff', 'admin', 'administracion',
      'administration', 'administrador', 'administrator', 'mod', 'moderator', 'moderador', 'support',
      'soporte', 'account', 'cuenta', 'konto', 'chat', 'community', 'comunidad', 'gemeinschaft'
    ]) as a;
  select string_agg(regexp_replace(public.community_username_skeleton(a, true), '(.)', '\1+', 'g'), '|')
    into v_decl
    from unnest(array[
      'real', 'the', 'official', 'oficial', 'original', 'verified', 'verificado', 'team', 'staff',
      'admin', 'mod', 'moderator', 'support', 'soporte', 'account', 'cuenta', 'acc', 'true',
      'authentic', 'legit', 'its', 'iam', 'im', 'fan', 'fans', 'fanpage', 'fanclub', 'club', 'page',
      'web', 'website', 'site', 'soy', 'ich', 'bin',
      'offiziell', 'offizielle', 'offizieller', 'offizielles', 'verifiziert', 'equipo',
      'administracion', 'administration', 'administrador', 'administrator', 'moderador', 'konto',
      'chat', 'community', 'comunidad', 'gemeinschaft',
      'de', 'del', 'la', 'el', 'of', 'by', 'from', 'von', 'der', 'die', 'das', 'y', 'and', 'und'
    ]) as a;

  foreach v_leet in array array[true, false] loop
    v_s := public.community_username_skeleton(p_text, v_leet);
    -- Cota contra backtracking (mismo valor que MAX_SKELETON_LENGTH en TS): nombres ≤ 40 caracteres.
    if v_s = '' or char_length(v_s) > 120 then
      continue;
    end if;
    v_rank := null;
    if v_s ~ ('^' || v_base || '$') then
      v_rank := 1;
    elsif v_s ~ ('^(?:' || v_aff || ')*' || v_base || '(?:' || v_aff || ')*$') then
      v_rank := 2;
    elsif p_field = 'display_name' and (
      v_s ~ ('^(?:(?:' || v_decl || ')*(?:' || v_auth || ')(?:' || v_decl || ')*' || v_base || 's*(?:' || v_decl || ')*'
             || '|(?:' || v_decl || ')*' || v_base || 's*(?:' || v_decl || ')*(?:' || v_auth || ')(?:' || v_decl || ')*)$')
    ) then
      v_rank := 3;
    elsif p_field = 'username' and v_s ~ 'u+p+m+i+n+a+' then
      v_rank := 4;
    else
      v_c := regexp_replace(v_s, '(.)\1+', '\1', 'g');
      if char_length(v_c) between 5 and 7
         and public.community_username_within_one_edit(v_c, 'upmina') then
        v_rank := 5;
      end if;
    end if;
    if v_rank is not null and v_rank < v_best then
      v_best := v_rank;
    end if;
  end loop;

  return case v_best when 1 then 'exact' when 2 then 'affixed' when 3 then 'declared'
                     when 4 then 'embedded' when 5 then 'near' else null end;
end;
$$;

create function public.community_username_impersonation(p_username text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$ select public.community_identity_impersonation(p_username, 'username') $$;

create function public.community_display_name_impersonation(p_display_name text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$ select public.community_identity_impersonation(p_display_name, 'display_name') $$;

-- Valor canónico con el que se guardan y comparan las excepciones: username = lower(btrim);
-- display_name = lower + espacios colapsados.
create function public.community_identity_grant_value(p_field text, p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$ select case p_field
  when 'display_name' then lower(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g'))
  else lower(btrim(coalesce(p_value, ''))) end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Excepciones administrativas futuras (no públicas, auditables): usuario + campo + valor
-- ---------------------------------------------------------------------------------------------
create table public.username_reservation_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  field         text not null check (field in ('username', 'display_name')),
  value         text not null check (char_length(value) between 1 and 40),
  reason        text not null check (char_length(reason) between 10 and 500),
  granted_by    uuid not null,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text check (revoke_reason is null or char_length(revoke_reason) between 10 and 500),
  check ((revoked_at is null) = (revoked_by is null)),
  check (field <> 'username' or (value = lower(value) and value ~ '^[a-z0-9_.]{3,24}$'))
);
-- Un solo titular vigente por campo y valor protegido.
create unique index username_reservation_grants_active_value
  on public.username_reservation_grants (field, value) where revoked_at is null;
alter table public.username_reservation_grants enable row level security;
alter table public.username_reservation_grants force row level security;
revoke all on public.username_reservation_grants from public, anon, authenticated, service_role;

create table public.username_reservation_audit (
  id             bigint generated always as identity primary key,
  action         text not null check (action in ('grant', 'revoke')),
  grant_id       uuid not null,
  actor_user_id  uuid not null,
  target_user_id uuid not null,
  field          text not null check (field in ('username', 'display_name')),
  value          text not null,
  reason         text not null,
  created_at     timestamptz not null default now()
);
alter table public.username_reservation_audit enable row level security;
alter table public.username_reservation_audit force row level security;
revoke all on public.username_reservation_audit from public, anon, authenticated, service_role;

create function public.username_reservation_audit_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'audit_append_only';
end;
$$;
create trigger username_reservation_audit_no_update_delete
  before update or delete on public.username_reservation_audit
  for each row execute function public.username_reservation_audit_append_only();
create trigger username_reservation_audit_no_truncate
  before truncate on public.username_reservation_audit
  for each statement execute function public.username_reservation_audit_append_only();

-- Autoridad única de la regla: ¿puede este usuario ostentar este valor en este campo?
create function public.community_assert_identity_allowed(p_user_id uuid, p_field text, p_value text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.community_identity_impersonation(p_value, p_field) is null then
    return;
  end if;
  if exists (
    select 1 from public.username_reservation_grants g
     where g.user_id = p_user_id
       and g.field = p_field
       and g.value = public.community_identity_grant_value(p_field, p_value)
       and g.revoked_at is null
  ) then
    return;
  end if;
  if p_field = 'username' then
    raise exception 'username_reserved' using errcode = 'UR001';
  end if;
  raise exception 'display_name_reserved' using errcode = 'UR002';
end;
$$;

create function public.profiles_guard_reserved_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' or new.username is distinct from old.username then
    perform public.community_assert_identity_allowed(new.user_id, 'username', new.username);
  end if;
  if new.display_name is not null and btrim(new.display_name) <> ''
     and (tg_op = 'INSERT' or new.display_name is distinct from old.display_name) then
    perform public.community_assert_identity_allowed(new.user_id, 'display_name', new.display_name);
  end if;
  return new;
end;
$$;

create trigger profiles_guard_reserved_identity_insert
  before insert on public.profiles
  for each row execute function public.profiles_guard_reserved_identity();
create trigger profiles_guard_reserved_identity_update
  before update of username, display_name on public.profiles
  for each row execute function public.profiles_guard_reserved_identity();

create function public.community_identity_reservation_grant(
  p_actor uuid, p_user uuid, p_field text, p_value text, p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_value text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid;
begin
  if p_actor is null or p_user is null or p_field is null or p_field not in ('username', 'display_name') then
    raise exception 'invalid_argument';
  end if;
  if p_actor = p_user then
    raise exception 'self_grant_forbidden';
  end if;
  perform 1 from public.admin_roles where user_id = p_actor and role = 'admin' for share;
  if not found then
    raise exception 'actor_not_admin';
  end if;
  v_value := public.community_identity_grant_value(p_field, p_value);
  if p_field = 'username' then
    if v_value !~ '^[a-z0-9_.]{3,24}$' or left(v_value, 1) = '.' or right(v_value, 1) = '.'
       or v_value ~ '\.\.' then
      raise exception 'invalid_value';
    end if;
  elsif char_length(v_value) not between 1 and 40 then
    raise exception 'invalid_value';
  end if;
  if char_length(v_reason) not between 10 and 500 then
    raise exception 'reason_required';
  end if;
  if public.community_identity_impersonation(v_value, p_field) is null then
    raise exception 'not_reserved';
  end if;
  perform 1 from auth.users where id = p_user for share;
  if not found then
    raise exception 'user_not_found';
  end if;
  begin
    insert into public.username_reservation_grants (user_id, field, value, reason, granted_by)
    values (p_user, p_field, v_value, v_reason, p_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'already_granted';
  end;
  insert into public.username_reservation_audit
    (action, grant_id, actor_user_id, target_user_id, field, value, reason)
  values ('grant', v_id, p_actor, p_user, p_field, v_value, v_reason);
  return v_id;
end;
$$;

create function public.community_identity_reservation_revoke(
  p_actor uuid, p_grant_id uuid, p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_grant public.username_reservation_grants%rowtype;
begin
  if p_actor is null or p_grant_id is null then
    raise exception 'invalid_argument';
  end if;
  perform 1 from public.admin_roles where user_id = p_actor and role = 'admin' for share;
  if not found then
    raise exception 'actor_not_admin';
  end if;
  if char_length(v_reason) not between 10 and 500 then
    raise exception 'reason_required';
  end if;
  select * into v_grant from public.username_reservation_grants where id = p_grant_id for update;
  if not found then
    raise exception 'grant_not_found';
  end if;
  if v_grant.revoked_at is not null then
    raise exception 'already_revoked';
  end if;
  update public.username_reservation_grants
     set revoked_at = now(), revoked_by = p_actor, revoke_reason = v_reason
   where id = p_grant_id;
  insert into public.username_reservation_audit
    (action, grant_id, actor_user_id, target_user_id, field, value, reason)
  values ('revoke', p_grant_id, p_actor, v_grant.user_id, v_grant.field, v_grant.value, v_reason);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Permisos: nada para anon/authenticated; solo el mecanismo administrativo para service_role.
-- ---------------------------------------------------------------------------------------------
alter function public.community_username_skeleton(text, boolean) owner to postgres;
alter function public.community_username_within_one_edit(text, text) owner to postgres;
alter function public.community_identity_impersonation(text, text) owner to postgres;
alter function public.community_username_impersonation(text) owner to postgres;
alter function public.community_display_name_impersonation(text) owner to postgres;
alter function public.community_identity_grant_value(text, text) owner to postgres;
alter function public.username_reservation_audit_append_only() owner to postgres;
alter function public.community_assert_identity_allowed(uuid, text, text) owner to postgres;
alter function public.profiles_guard_reserved_identity() owner to postgres;
alter function public.community_identity_reservation_grant(uuid, uuid, text, text, text) owner to postgres;
alter function public.community_identity_reservation_revoke(uuid, uuid, text) owner to postgres;

revoke all on function public.community_username_skeleton(text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.community_username_within_one_edit(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.community_identity_impersonation(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.community_username_impersonation(text)
  from public, anon, authenticated, service_role;
revoke all on function public.community_display_name_impersonation(text)
  from public, anon, authenticated, service_role;
revoke all on function public.community_identity_grant_value(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.username_reservation_audit_append_only()
  from public, anon, authenticated, service_role;
revoke all on function public.community_assert_identity_allowed(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.profiles_guard_reserved_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.community_identity_reservation_grant(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.community_identity_reservation_revoke(uuid, uuid, text)
  from public, anon, authenticated, service_role;
-- Solo el mecanismo administrativo futuro; la capa de API deberá verificar JWT + rol ADMIN + `aal2`
-- antes de invocarlo. Hoy no existe ningún endpoint que lo haga.
grant execute on function public.community_identity_reservation_grant(uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.community_identity_reservation_revoke(uuid, uuid, text)
  to service_role;

comment on function public.community_identity_impersonation(text, text) is
  'Suplantación de Mina/Upmina en username o display_name: exact|affixed|declared|embedded|near o NULL. Debe coincidir con src/lib/username-impersonation.ts.';
comment on table public.username_reservation_grants is
  'Excepciones administrativas FUTURAS al guard de suplantación (por usuario, campo y valor exacto). Sin acceso para ningún rol de API.';
