---
name: backend-api
description: Use for the Vercel Functions in api/, external-API proxying, validation, caching headers and backend error handling.
---

# Backend API

For each handler in `api/*.ts`:
1. Reject non-GET with `405`, then validate input (query params) and bound it (minimum and maximum).
2. Call the upstream API with server-only credentials from `process.env`.
3. Normalize the response into the client-facing type (`src/types/index.ts`); raw upstream shapes live in `src/types/api.ts`.
4. Set `Cache-Control: s-maxage=<ttl>, stale-while-revalidate=<2x>` matching `docs/ARCHITECTURE.md`.
5. On failure, log `[function-name]` + error server-side and return a generic Spanish message with `502` (or the status of `TwitchApiError` in the Twitch handlers).
6. Never log or echo secrets or full upstream payloads.

Relative imports inside `api/` need explicit `.js` extensions. Public read-only proxies do not need authentication; anything that writes or uses `SUPABASE_SERVICE_ROLE_KEY` must authorize explicitly.

Keep transport logic separate from business logic when complexity warrants it.
