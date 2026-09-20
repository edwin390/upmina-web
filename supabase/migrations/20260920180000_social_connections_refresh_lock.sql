-- Lease de refresh para social_connections.
--
-- Vercel puede ejecutar varias instancias a la vez, y TikTok puede ROTAR el refresh token
-- en cada refresh. Si dos peticiones refrescan a la vez con el mismo refresh token, la
-- segunda puede invalidar los tokens de la primera y dejar la conexión inservible.
--
-- `refresh_lock_until` es un lease atómico: el servidor lo adquiere con un único
--   UPDATE ... WHERE provider = 'tiktok' AND refresh_token = <esperado>
--                AND (refresh_lock_until IS NULL OR refresh_lock_until < now)
-- Solo una petición obtiene la fila actualizada; el resto espera y relee. El lease caduca
-- solo (unos 30 s) por si una función muere a mitad, y se limpia al guardar los tokens
-- nuevos. No es un secreto y no cambia la protección de la tabla (RLS forzado, sin
-- policies, privilegios solo para service_role: los grants de tabla cubren la columna).

alter table public.social_connections
  add column if not exists refresh_lock_until timestamptz;

comment on column public.social_connections.refresh_lock_until is
  'Lease del refresh de tokens: mientras sea futuro, una petición ya está refrescando. Caduca sola.';
