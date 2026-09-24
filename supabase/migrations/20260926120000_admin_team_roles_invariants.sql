-- Bloque 9B: roles del equipo (developer), invitaciones revocables, created_by que no bloquea
-- el borrado de cuentas, protección del último ADMIN y bootstrap cerrado de forma definitiva
-- cuando ya existe un ADMIN. Migración NUEVA: no modifica ninguna migración anterior
-- (20260922120000_admin_roles.sql y 20260923120000_admin_invitations.sql siguen intactas).
--
-- Metadata real verificada antes de escribirla: admin_roles y admin_invitations pertenecen a
-- postgres (RLS + FORCE RLS); consume_admin_invitation es de postgres, SECURITY DEFINER, con
-- search_path pg_catalog, public y EXECUTE solo para service_role; postgres y service_role
-- tienen BYPASSRLS; service_role conservaba TRUNCATE/REFERENCES/TRIGGER (default privileges
-- de Supabase) y CRUD sobre admin_roles. Los nombres de constraint reemplazados abajo son los
-- reales (admin_roles_role_check, admin_invitations_bootstrap_shape).
--
-- LOCK ÚNICO: public.upmina_lock_admin_roles() (pg_advisory_xact_lock sobre una única clave).
-- REGLA: toda RPC futura que modifique admin_roles, o que cree/consuma/revoque invitaciones,
-- debe llamarla PRIMERO, antes de cualquier SELECT ... FOR UPDATE. Así el orden de bloqueo es
-- siempre "advisory lock, luego filas" y no hay deadlocks por órdenes distintos. Las RPC
-- tampoco deben capturar (EXCEPTION) las excepciones last_admin_protected / 23001.
--
-- Política de producto (DEVELOPER solo por cambio de rol, quién invita a quién, etc.) vive en
-- las RPC futuras; aquí solo se expresan datos válidos e invariantes.

-- 1. Lock compartido ------------------------------------------------------------------
-- SECURITY INVOKER a propósito: solo llama a pg_advisory_xact_lock (ejecutable por PUBLIC en
-- pg_catalog). El EXECUTE se restringe abajo (sección 9) para que anon/authenticated no
-- puedan mantener el lock a través de PostgREST.
create or replace function public.upmina_lock_admin_roles()
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('upmina:admin_roles:v1', 0)
  );
end;
$$;

comment on function public.upmina_lock_admin_roles() is
  'Lock advisory único (transaccional) que serializa cambios de admin_roles e invitaciones privilegiadas. Toda RPC que las modifique debe llamarlo antes de cualquier FOR UPDATE.';

-- 2. admin_roles: añadir developer (CHECK, no enum) ----------------------------------------
alter table public.admin_roles drop constraint admin_roles_role_check;
alter table public.admin_roles
  add constraint admin_roles_role_check
  check (role in ('admin', 'moderator', 'developer')) not valid;
alter table public.admin_roles validate constraint admin_roles_role_check;

comment on table public.admin_roles is
  'Roles privilegiados (admin/moderator/developer) de Upmina Web. Ausencia de fila = USER. Solo lectura para service_role; las escrituras van por RPC SECURITY DEFINER. Nunca puede quedar sin ningún admin (ver trigger admin_roles_last_admin_guard).';
comment on column public.admin_roles.role is
  'admin, moderator o developer. No existe el valor "user": la ausencia de fila ya significa USER. developer solo se concede mediante un cambio de rol administrativo, nunca por invitación ni por bootstrap.';

-- 3. admin_invitations: id opaco y revocación ------------------------------------------------
-- admin_invitations.role NO se amplía: sigue siendo admin | moderator (developer nunca se
-- concede por invitación). token_hash sigue siendo la PK y la clave de consumo.
alter table public.admin_invitations
  add column id uuid not null default gen_random_uuid(),
  add column revoked_at timestamptz,
  add column revoked_by uuid references auth.users(id) on delete set null;

alter table public.admin_invitations
  add constraint admin_invitations_id_key unique (id);

comment on column public.admin_invitations.id is
  'Identificador administrativo opaco (listar, revocar, auditar). token_hash es la clave secreta de consumo y nunca debe salir por una API.';
comment on column public.admin_invitations.revoked_at is
  'Momento de revocación. Una invitación revocada nunca vuelve a ser consumible y se conserva como historial (transición de una sola vía).';
comment on column public.admin_invitations.revoked_by is
  'ADMIN que revocó. ON DELETE SET NULL: si esa cuenta se elimina, la invitación permanece; la auditoría conserva el snapshot.';

-- 4. Forma y estado --------------------------------------------------------------------------
-- created_by ya no es obligatorio en el CHECK: que una invitación standard NAZCA con un creador
-- ADMIN lo impone el trigger BEFORE INSERT (sección 6). Así, cuando el creador se elimina y la
-- FK aplica SET NULL, la fila sigue siendo válida (y sigue siendo standard) y DELETE en
-- auth.users no queda bloqueado. Una standard sin creador no es bootstrap ni gana poder: el
-- consumo exige un creador que siga siendo ADMIN, así que queda inconsumible.
alter table public.admin_invitations
  add constraint admin_invitations_shape_check
  check (
    (invitation_type = 'bootstrap_admin' and role = 'admin' and created_by is null)
    or invitation_type = 'standard'
  ) not valid;
alter table public.admin_invitations drop constraint admin_invitations_bootstrap_shape;
alter table public.admin_invitations validate constraint admin_invitations_shape_check;

alter table public.admin_invitations
  add constraint admin_invitations_state_check
  check (
    (consumed_by is null or consumed_at is not null)
    and (revoked_by is null or revoked_at is not null)
    and not (consumed_at is not null and revoked_at is not null)
  ) not valid;
alter table public.admin_invitations validate constraint admin_invitations_state_check;

-- 5. Backfill: bootstrap pendientes quedan revocados si ya existe un ADMIN ----------------
-- Va ANTES de crear los triggers y bajo el lock compartido. Con el estado actual (un ADMIN
-- temporal existente) revoca cualquier bootstrap sin consumir; si no existiera ningún ADMIN
-- no toca nada.
select public.upmina_lock_admin_roles();

update public.admin_invitations
   set revoked_at = now()
 where invitation_type = 'bootstrap_admin'
   and consumed_at is null
   and revoked_at is null
   and exists (select 1 from public.admin_roles where role = 'admin');

-- 6. Triggers de admin_roles ---------------------------------------------------------------
-- 6a. Lock por sentencia: se toma ANTES de escanear/bloquear filas (orden "lock, luego filas").
-- No es lo que garantiza el invariante (eso lo hace 6d, que vuelve a tomar el lock y comprueba
-- el post-estado); reduce deadlocks. También corre en los cascades de auth.users.
create or replace function public.admin_roles_lock_statement()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  perform public.upmina_lock_admin_roles();
  return null;
end;
$$;

create trigger admin_roles_lock_statement
  before insert or update or delete on public.admin_roles
  for each statement execute function public.admin_roles_lock_statement();

-- 6b. TRUNCATE siempre falla (además del REVOKE de la sección 8).
create or replace function public.admin_roles_no_truncate()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'admin_roles_truncate_not_allowed' using errcode = '23001';
end;
$$;

create trigger admin_roles_no_truncate
  before truncate on public.admin_roles
  for each statement execute function public.admin_roles_no_truncate();

-- 6c. Identidad inmutable: no se puede reasignar una fila a otro usuario. granted_by solo puede
-- pasar a NULL (acción ON DELETE SET NULL).
create or replace function public.admin_roles_immutable_identity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.granted_at is distinct from old.granted_at
     or (new.granted_by is distinct from old.granted_by and new.granted_by is not null) then
    raise exception 'admin_roles_identity_immutable' using errcode = '23000';
  end if;
  return new;
end;
$$;

create trigger admin_roles_immutable_identity
  before update on public.admin_roles
  for each row execute function public.admin_roles_immutable_identity();

-- 6d. Nunca cero ADMIN. AFTER ROW normal (NO constraint trigger): PostgreSQL ejecuta los
-- eventos AFTER ROW al terminar la sentencia, con todas las filas ya modificadas y visibles;
-- por eso cubre DELETE/UPDATE multi-fila y el DELETE interno del cascade de auth.users. Toma
-- el lock y consulta con un snapshot nuevo (READ COMMITTED), de modo que dos transacciones
-- concurrentes quedan serializadas y la segunda ve el commit de la primera. Post-estado: si la
-- sentencia deja cero ADMIN, aborta con last_admin_protected (SQLSTATE 23001). Un ADMIN puede
-- degradarse a sí mismo solo si queda otro. Para "crear B y degradar A" en una transacción, la
-- promoción debe ir ANTES de la degradación.
create or replace function public.admin_roles_last_admin_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and new.role = 'admin' then
    return null;
  end if;

  perform public.upmina_lock_admin_roles();

  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'admin_guard_requires_read_committed' using errcode = '23001';
  end if;

  if not exists (select 1 from public.admin_roles where role = 'admin') then
    raise exception 'last_admin_protected' using errcode = '23001';
  end if;
  return null;
end;
$$;

create trigger admin_roles_last_admin_guard
  after update or delete on public.admin_roles
  for each row when (old.role = 'admin')
  execute function public.admin_roles_last_admin_guard();

-- 6e. Cuando aparece un ADMIN, todo bootstrap pendiente queda revocado de forma DEFINITIVA (la
-- revocación es de una sola vía, ver 7b): no revive aunque algún día desaparecieran los ADMIN.
-- SECURITY DEFINER porque escribe admin_invitations en nombre de quien inserte el ADMIN, que
-- puede no tener UPDATE sobre esa tabla.
create or replace function public.admin_roles_revoke_pending_bootstrap()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.admin_invitations
     set revoked_at = pg_catalog.now()
   where invitation_type = 'bootstrap_admin'
     and consumed_at is null
     and revoked_at is null;
  return null;
end;
$$;

create trigger admin_roles_revoke_pending_bootstrap
  after insert or update of role on public.admin_roles
  for each row when (new.role = 'admin')
  execute function public.admin_roles_revoke_pending_bootstrap();

-- 7. Triggers de admin_invitations ------------------------------------------------------------
-- 7a. Inserción: estado inicial limpio; bootstrap solo sin ADMIN; standard solo con un creador
-- que sea ADMIN en ese momento.
create or replace function public.admin_invitations_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.consumed_at is not null or new.consumed_by is not null
     or new.revoked_at is not null or new.revoked_by is not null then
    raise exception 'invitation_insert_state_invalid' using errcode = '23000';
  end if;

  perform public.upmina_lock_admin_roles();

  if new.invitation_type = 'bootstrap_admin' then
    if exists (select 1 from public.admin_roles where role = 'admin') then
      raise exception 'bootstrap_not_allowed' using errcode = '23000';
    end if;
  else
    if new.created_by is null then
      raise exception 'standard_invitation_requires_creator' using errcode = '23000';
    end if;
    if not exists (
      select 1 from public.admin_roles
       where user_id = new.created_by and role = 'admin'
    ) then
      raise exception 'invitation_creator_not_admin' using errcode = '23000';
    end if;
  end if;
  return new;
end;
$$;

create trigger admin_invitations_before_insert
  before insert on public.admin_invitations
  for each row execute function public.admin_invitations_before_insert();

-- 7b. Inmutabilidad y máquina de estados de una sola vía. token_hash, id, invitation_type, role,
-- created_at y expires_at no cambian. Estados: PENDING (consumed_* y revoked_* NULL), CONSUMED
-- (consumed_at fijado) y REVOKED (revoked_at fijado); solo PENDING -> CONSUMED y PENDING ->
-- REVOKED, nunca vuelta atrás (consumed_at/revoked_at, una vez fijados, no cambian ni vuelven a
-- NULL; que una consumida no se revoque y viceversa lo impone admin_invitations_state_check).
-- Referencias a usuarios:
--   created_by : solo puede pasar a NULL (ON DELETE SET NULL); NULL -> valor y valor -> otro, no.
--   consumed_by / revoked_by : NULL -> valor SOLO si su *_at pasa de NULL a NOT NULL en ESA
--     MISMA actualización (es la asignación inicial que hacen consume_admin_invitation y la
--     revocación); valor -> mismo valor y valor -> NULL (ON DELETE SET NULL) están permitidos;
--     NULL -> valor con el *_at ya fijado (reescribir el historial tras un SET NULL) y valor ->
--     otro valor, no. Un trigger no distingue un SET NULL referencial de un UPDATE directo a NULL;
--     ese UPDATE no otorga ningún poder.
create or replace function public.admin_invitations_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.token_hash is distinct from old.token_hash
     or new.id is distinct from old.id
     or new.invitation_type is distinct from old.invitation_type
     or new.role is distinct from old.role
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'invitation_immutable_field' using errcode = '23000';
  end if;

  if new.created_by is distinct from old.created_by and new.created_by is not null then
    raise exception 'invitation_reference_immutable' using errcode = '23000';
  end if;

  if new.consumed_by is distinct from old.consumed_by
     and new.consumed_by is not null
     and not (old.consumed_by is null and old.consumed_at is null and new.consumed_at is not null) then
    raise exception 'invitation_reference_immutable' using errcode = '23000';
  end if;

  if new.revoked_by is distinct from old.revoked_by
     and new.revoked_by is not null
     and not (old.revoked_by is null and old.revoked_at is null and new.revoked_at is not null) then
    raise exception 'invitation_reference_immutable' using errcode = '23000';
  end if;

  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'invitation_state_immutable' using errcode = '23000';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'invitation_state_immutable' using errcode = '23000';
  end if;
  return new;
end;
$$;

create trigger admin_invitations_immutable
  before update on public.admin_invitations
  for each row execute function public.admin_invitations_immutable();

-- 8. consume_admin_invitation (versión mínima para el nuevo schema) --------------------------
-- Sigue siendo la ÚNICA vía de concesión de rol por invitación. Orden exacto (no reordenar sin
-- volver a razonar la concurrencia): (1) lock compartido, (2) SELECT ... FOR UPDATE, (3) existe,
-- (4) no consumida, (5) no revocada, (6) no expirada, (7) usuario destino aún sin rol,
-- (8) bootstrap: todavía no existe ADMIN / standard: el creador existe Y sigue siendo ADMIN,
-- (9) marcar consumida, (10) insertar admin_roles, (11) devolver el rol. Todo en la misma
-- transacción: si el INSERT falla, el UPDATE de consumo también se revierte.
-- Los mensajes son EXACTAMENTE los literales que admin-handlers.ts reconoce como rechazos de
-- negocio (lista cerrada): si cambian aquí, deben cambiar allí. Binding de email: fase posterior.
create or replace function public.consume_admin_invitation(
  p_token_hash text,
  p_user_id uuid
)
returns table(granted_role text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.admin_invitations%rowtype;
begin
  perform public.upmina_lock_admin_roles();

  select * into v_row
    from public.admin_invitations
    where token_hash = p_token_hash
    for update;

  if not found then
    raise exception 'invitation_not_found';
  end if;
  if v_row.consumed_at is not null then
    raise exception 'invitation_already_consumed';
  end if;
  if v_row.revoked_at is not null then
    raise exception 'invitation_revoked';
  end if;
  if v_row.expires_at < now() then
    raise exception 'invitation_expired';
  end if;

  if exists (select 1 from public.admin_roles ar where ar.user_id = p_user_id) then
    raise exception 'user_already_privileged';
  end if;

  if v_row.invitation_type = 'bootstrap_admin' then
    if exists (select 1 from public.admin_roles ar where ar.role = 'admin') then
      raise exception 'admin_already_exists';
    end if;
  else
    if v_row.created_by is null
       or not exists (
         select 1 from public.admin_roles ar
          where ar.user_id = v_row.created_by and ar.role = 'admin'
       ) then
      raise exception 'invitation_creator_not_admin';
    end if;
  end if;

  update public.admin_invitations
    set consumed_at = now(), consumed_by = p_user_id
    where token_hash = p_token_hash;

  insert into public.admin_roles (user_id, role, granted_by)
    values (p_user_id, v_row.role, v_row.created_by);

  return query select v_row.role;
end;
$$;

comment on function public.consume_admin_invitation(text, uuid) is
  'Consume una admin_invitations de forma atómica y concede el rol en admin_roles. SOLO service_role (EXECUTE). p_user_id debe venir de un JWT ya verificado con aal2 (responsabilidad del backend). Rechaza: no encontrada, consumida, revocada, expirada, usuario ya privilegiado, bootstrap con ADMIN existente, standard cuyo creador ya no es ADMIN.';

-- 9. Privilegios -----------------------------------------------------------------------------
-- Supabase concede por defecto TODOS los privilegios a service_role sobre las tablas nuevas de
-- public (incluidos TRUNCATE, REFERENCES y TRIGGER). consume_admin_invitation es SECURITY
-- DEFINER de postgres (owner de ambas tablas, BYPASSRLS): sus escrituras usan los privilegios
-- del owner, no los de service_role, que solo necesita EXECUTE sobre la función.
-- ALLOWLIST de privilegios de tabla para service_role: se revoca TODO y se concede solo lo mínimo.
-- (Una denylist de privilegios no basta: PostgreSQL 17 añadió MAINTAIN y los default privileges de
-- Supabase conceden ALL; REVOKE ALL PRIVILEGES elimina cualquier privilegio de tabla que soporte la
-- versión, incluidos los futuros, y la migración histórica nunca revocó DELETE.) Las dos sentencias
-- de cada tabla van en la misma transacción de la migración: no hay ventana sin SELECT.
revoke all privileges on table public.admin_roles from service_role;
grant select on table public.admin_roles to service_role;
-- admin_roles: service_role solo lee (requireAuthenticated/requireAdmin). Las escrituras las hace
-- consume_admin_invitation (SECURITY DEFINER, owner postgres) y las futuras RPC de equipo.

revoke all privileges on table public.admin_invitations from service_role;
grant select, insert on table public.admin_invitations to service_role;
-- admin_invitations: INSERT se conserva TEMPORALMENTE porque el script bootstrap
-- (scripts/bootstrap-admin-invitation.mjs) inserta con service_role; se retirará cuando el bootstrap
-- pase a una RPC. Sin UPDATE/DELETE/TRUNCATE: las transiciones las hacen las RPC definer y el
-- historial de invitaciones no se borra.

-- EXECUTE de las funciones trigger: nadie las invoca directamente. El permiso EXECUTE de una
-- función trigger se comprueba al crear el trigger, no al dispararlo, así que los triggers
-- siguen funcionando aunque el rol que provoca el evento no tenga EXECUTE.
revoke all on function public.admin_roles_lock_statement()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_roles_no_truncate()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_roles_immutable_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_roles_last_admin_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_roles_revoke_pending_bootstrap()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_invitations_before_insert()
  from public, anon, authenticated, service_role;
revoke all on function public.admin_invitations_immutable()
  from public, anon, authenticated, service_role;

-- El lock sí se llama explícitamente desde funciones INVOKER (admin_invitations_before_insert
-- bajo service_role mientras el bootstrap inserte directamente). Provisional: retirar el
-- EXECUTE de service_role cuando el bootstrap pase a RPC.
revoke all on function public.upmina_lock_admin_roles()
  from public, anon, authenticated, service_role;
grant execute on function public.upmina_lock_admin_roles() to service_role;

revoke all on function public.consume_admin_invitation(text, uuid) from public;
revoke execute on function public.consume_admin_invitation(text, uuid) from anon;
revoke execute on function public.consume_admin_invitation(text, uuid) from authenticated;
grant execute on function public.consume_admin_invitation(text, uuid) to service_role;
