---
description: Run the release-readiness gate
---

Run the verification this repo actually has, in order, and report each result:

1. `npm run lint` (warnings fail the run)
2. `npm test`
3. `npm run build` (includes the `tsc -b` type-check of `src/` and `api/`)
4. `npm run test:e2e` only if the diff changes a user-visible flow

Then inspect the diff and security-sensitive changes (secrets, `VITE_*` exposure, RLS/Supabase, `api/` handlers). Return READY or NOT READY with evidence; separate blockers from non-blocking notes. Do not deploy or change Vercel settings.
