-- Consumo de un solo uso del state/nonce del OAuth de Instagram (Lote 3B.1).
--
-- El HMAC del `state` (instagram-oauth-shared.ts) ya garantiza que solo nuestro servidor
-- pudo emitirlo, que no fue alterado y que no ha expirado, pero eso NO impide que la misma
-- petición de callback (mismo state + cookie) se reenvíe manualmente y complete el
-- intercambio dos veces: sin esta tabla, la única barrera real ante esa repetición sería
-- que Instagram rechace un authorization code ya usado, y no queremos depender solo de
-- eso.
--
-- claimInstagramOAuthNonce (instagram-connection.ts) reclama el nonce con un INSERT
-- atómico: la primera llamada para un nonce dado inserta la fila; cualquier repetición
-- -secuencial o dos peticiones concurrentes con el mismo state- choca con la primary key
-- y pierde, ANTES de contactar a Instagram y antes de escribir social_connections. No hace
-- falta Redis ni ningún servicio externo: la garantía la da la propia restricción única de
-- Postgres.
--
-- Solo se guarda el hash SHA-256 del nonce (nunca el nonce, el `state` completo, el code
-- ni ningún token). La limpieza de nonces expirados es oportunista (ver
-- claimInstagramOAuthNonce): no requiere cron ni infraestructura adicional.
--
-- SEGURIDAD: mismo patrón que social_connections -- RLS activado y FORZADO, sin ninguna
-- policy, y sin privilegios para anon/authenticated/PUBLIC. Solo service_role, y sin
-- UPDATE (las filas son inmutables: solo se insertan y, al expirar, se borran).

create table if not exists public.instagram_oauth_nonces (
  nonce_hash text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.instagram_oauth_nonces is
  'Consumo de un solo uso del state/nonce del OAuth de Instagram. Solo hash del nonce; nunca tokens, codes ni el state completo.';
comment on column public.instagram_oauth_nonces.nonce_hash is
  'SHA-256 hex del nonce del state (no el nonce en claro).';
comment on column public.instagram_oauth_nonces.expires_at is
  'Igual a la expiración del state firmado; se usa solo para la limpieza oportunista de filas viejas.';

alter table public.instagram_oauth_nonces enable row level security;
alter table public.instagram_oauth_nonces force row level security;

revoke all on table public.instagram_oauth_nonces from public;
revoke all on table public.instagram_oauth_nonces from anon;
revoke all on table public.instagram_oauth_nonces from authenticated;
grant select, insert, delete on table public.instagram_oauth_nonces to service_role;
