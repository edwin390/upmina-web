# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

UPMINA Web is an unofficial fan site (Spanish-language docs, UI copy and most commit messages): a Vite + React 19 SPA plus Vercel serverless functions that proxy Twitch/YouTube/Instagram/TikTok, with Supabase for the community-edits feature. The Node version is pinned by `engines` in `package.json`.

## Commands

```bash
npm run dev          # Vite on :3000 (SPA only; /api is NOT served)
npm run dev:local    # vercel dev on :3001 + Vite on :3000, reads .env.local then .env
npm run build        # tsc -b && vite build (type-check is part of build)
npm run lint         # eslint, --max-warnings 0 (warnings fail)
npm test             # vitest run (jsdom, globals enabled)
npm run test:e2e     # Playwright (auto-starts `npm run dev`)
```

Single test: `npx vitest run src/lib/format.test.ts` or `npx vitest run -t "name"`. Single e2e: `npx playwright test e2e/home.spec.ts`.

A husky pre-commit hook runs `lint-staged` (eslint --fix + prettier on staged `*.{ts,tsx}`). Commits follow Conventional Commits with a scope, e.g. `fix(twitch): ...`, preferably in Spanish.

## Architecture

**Two TypeScript worlds in one repo.** `src/` is the browser SPA (`tsconfig.app.json`, `@/*` → `src/*`). `api/*.ts` are Vercel Functions (checked by `tsconfig.node.json`). Secrets (Twitch/YouTube/Instagram/TikTok credentials) are read only in `api/` via `process.env`; only `VITE_*` vars reach the client. `SUPABASE_SERVICE_ROLE_KEY` is reserved for future admin functions; no code uses it yet.

**Serverless import rules (learned the hard way, see git history):**
- Relative imports in `api/` must use explicit `.js` extensions (e.g. `../src/types/api.js`) because Vercel runs them as ESM.
- Types shared with functions live in `src/types/api.ts` (raw upstream API shapes). Client-facing normalized types live in `src/types/index.ts`. Keep them separate; `api/` may import from `src/lib/format` and `src/types/api` only for things that are safe outside Vite.
- Vercel deploys every file in `api/` as its own route. `api/twitch.ts` is a shared helper (token cache, broadcaster lookup, `TwitchApiError`) used by the other Twitch handlers, so it is also exposed as `/api/twitch`; avoid adding more helpers there.

**Data flow per integration:** component → hook in `src/hooks/use*.ts` (TanStack Query with per-resource `staleTime`, see `docs/ARCHITECTURE.md` cache table) → `fetch("/api/<name>")` → Vercel Function → external API → normalized JSON. Functions set `Cache-Control: s-maxage=...` for edge caching and answer with a generic Spanish error message on upstream failure: `502` by default, and the Twitch handlers use the status carried by `TwitchApiError` (e.g. `503` when credentials are missing). The Twitch handlers also reject non-GET with `405`.

**Local `/api`:** `vite.config.ts` proxies `/api` to `http://localhost:3001`. Plain `npm run dev` starts nothing there, so `/api` calls fail; use `npm run dev:local` (needs real `TWITCH_*` values in `.env.local`) or demo mode to work without the APIs.

**Two independent runtime flags — never mix them:**
- `isDemoMode` (`src/lib/runtime.ts`, from `VITE_DEMO_MODE === "true"`): every social-integration hook short-circuits to mock/empty data before calling `/api`. New integration hooks must honor it.
- `isSupabaseConfigured` / `supabase === null` (`src/lib/supabase.ts`): the Community components (`src/components/community/*`) check `supabase` themselves and degrade gracefully when it is null. Demo mode does not affect Community.

**Community feature** talks to Supabase directly from the browser (no API proxy), relying on Row-Level Security; schema and RLS policies are documented in `docs/ARCHITECTURE.md` (tables: profiles, edits, votes, reports; edits have `pending|approved|rejected` status). `ModerationPanel` exists but is not rendered anywhere yet.

**App shell:** `main.tsx` wraps `App` in `QueryClientProvider` + `HeroUIProvider`; `App` renders Header/HomePage/Footer, and `HomePage` composes the per-integration sections (Twitch, YouTube, Instagram, TikTok, Community) as anchor sections on a single page. Styling is Tailwind with design tokens from `tailwind.config.js` (see `docs/DESIGN_SYSTEM.md`) plus HeroUI components.

## Environment and permissions

Env vars are listed in `.env.example`. `.gitignore` ignores `.env*` but re-includes `.env.example` with `!.env.example`. `.claude/settings.json` denies reading `.env`, `.env.local`, `.env.*.local`, `*.pem` and `*private*key*`; `.env.example` is readable. `docs/ROADMAP.md` tracks phased delivery; several features are still in progress.

The `.claude/` folder holds this project's agents, skills and slash commands (`/feature`, `/review`, `/test`, `/security`, `/release`); they describe this Vite + Vercel stack, not Next.js.

---

# AI Engineering Team — Project Rules

## Mission
Build production-quality JavaScript/TypeScript applications with React/Next.js, APIs and Vercel while minimizing paid-model/token consumption.

## Team model
- `tech-lead`: plans architecture and delegates. Do not implement unless explicitly asked.
- `frontend-engineer`: React/Next.js UI, accessibility, client state, API integration.
- `backend-engineer`: API routes, services, validation, auth, database integration.
- `qa-engineer`: tests, edge cases, regression checks and reproducible bug reports.
- `code-reviewer`: reviews diffs for correctness, maintainability and regressions.
- `security-auditor`: security-focused review; never expose secrets.
- `devops-engineer`: Vercel, CI/CD, environment variables, builds and deployment diagnostics.
- `final-auditor`: release gate; checks requirements, tests, security, build and deployment readiness.

## Cost-control rules
1. Prefer the least expensive capable model.
2. Use free/local models for boilerplate, routine tests, documentation, simple refactors and straightforward CRUD.
3. Reserve the strongest model for architecture, ambiguous requirements, difficult debugging, security findings and final audits.
4. Never ask multiple agents to reread the whole repository. Give each agent the smallest relevant file set.
5. Prefer `git diff`, targeted `Read`, `Glob`, and `Grep` over repository-wide dumps.
6. Do not repeat a completed analysis unless new evidence exists.
7. Before spawning another agent, check whether the current result already answers the question.
8. Never send secrets, `.env` contents, tokens, private keys or credentials to external/free models.
9. Keep generated prompts compact and reference files instead of copying their contents.

## Change protocol
Before editing:
- Identify the requirement.
- Inspect the relevant files.
- State assumptions if they matter.
- Make the smallest coherent change.

After editing:
- Run the narrowest relevant tests/typecheck/lint.
- Inspect the diff.
- Report changed files and verification performed.

## Git safety
- Never reset, force-push, delete branches, or discard user changes unless explicitly requested.
- Do not rewrite unrelated code.
- Keep commits atomic when asked to commit.
- Never commit secrets or `.env` files.

## Definition of Done
A feature is done only when:
- Requirement is implemented.
- Relevant tests pass.
- Typecheck/lint/build pass where configured.
- Error paths have been considered.
- Security-sensitive paths have been reviewed.
- No obvious unrelated regressions remain.
- Deployment configuration is consistent with the project.

## Stack defaults
Prefer:
- TypeScript over JavaScript for new production code.
- Next.js App Router where Next.js is already used.
- Server-side work for secrets and privileged operations.
- Runtime validation at API boundaries.
- Small composable functions.
- Explicit error handling.
- Accessible semantic HTML.
- Environment variables for secrets/configuration.

Do not introduce a framework, library or architecture change without a concrete reason.
