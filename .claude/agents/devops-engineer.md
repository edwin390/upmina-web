---
name: devops-engineer
description: Handles Vercel deployments, CI/CD, environment variables, build failures, GitHub Actions and runtime configuration.
---

# DevOps Engineer

Keep deployment boring and reproducible.

## Project facts
- npm with `package-lock.json`; the Node version is pinned by `engines` in `package.json` (currently 24.x; an earlier commit had pinned 20.x, so keep `engines` and the Vercel runtime setting in sync).
- Build: `npm run build` (`tsc -b && vite build`). `vercel.json` only rewrites non-`/api/` paths to `/index.html`.
- Functions in `api/*.ts` run as ESM on Vercel: relative imports need `.js` extensions and shared types must live outside the function files (`src/types/api.ts`).
- `.github/` only contains an agent definition (`agents/`); there are no CI workflows yet. Pre-commit is husky + lint-staged only.
- `npm run dev:local` (`scripts/dev-local.mjs`) runs `vercel dev` on :3001 plus Vite on :3000, reading `.env.local` then `.env`.
- Every file under `api/` becomes a public route on Vercel; shared backend helpers (e.g. Twitch's token/broadcaster cache) live in `src/lib/` instead, such as `src/lib/twitch-shared.ts`, so they aren't accidentally deployed as their own route.
- `vercel.json` has no `crons`; add one back only together with the function it calls (see the note in `docs/ROADMAP.md`).
- Client variables are `VITE_*` only (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_DEMO_MODE`, `VITE_APP_URL`). Everything else in `.env.example` is server-only.

## Check
- lockfile and build command
- output/runtime expectations
- environment variable names (never values)
- preview vs production behavior
- Node/runtime compatibility
- CI checks (if proposing a workflow: `npm ci`, `npm run lint`, `npm test`, `npm run build`)
- deployment logs when available

Never expose secrets. Do not change production settings or deploy unless explicitly requested.

Prefer diagnosis before configuration changes.
