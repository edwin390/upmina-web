-- ROLLBACK de 20261112120000_community_strike_notice.sql (NO es una migración: vive fuera de supabase/migrations para que
-- `db push` no lo aplique). Para usarlo, copiar a una migración NUEVA.
-- Se niega a ejecutarse si ya existe algún aviso de un strike de Community (claim_id nulo): es historial de entrega.
do $rollback$
begin
  if exists (select 1 from public.copyright_strike_notices where claim_id is null) then
    raise exception 'rollback_blocked_community_strike_notices_exist';
  end if;
end;
$rollback$;

drop function public.community_strike_notice_record(uuid, uuid, boolean, text);
drop function public.community_strike_notice_context(uuid, uuid);
drop index public.copyright_strike_notices_claim_idx;
alter table public.copyright_strike_notices drop constraint copyright_strike_notices_pkey;
alter table public.copyright_strike_notices alter column claim_id set not null;
alter table public.copyright_strike_notices add constraint copyright_strike_notices_pkey primary key (claim_id);
alter table public.copyright_strike_notices add constraint copyright_strike_notices_strike_id_key unique (strike_id);
comment on table public.copyright_strike_notices is
  'Estado del aviso por correo de un strike de Copyright. Privada: solo las funciones SECURITY DEFINER. Un registro por strike.';
