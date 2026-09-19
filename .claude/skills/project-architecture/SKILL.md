---
name: project-architecture
description: Use when planning or changing architecture in this Vite/React SPA, its Vercel Functions or the Supabase community feature.
---

# Project Architecture

Inspect before proposing. `CLAUDE.md` already summarizes the stack; do not re-derive it.

## Required inspection (only what the question needs)
- `CLAUDE.md`, then `docs/ARCHITECTURE.md` for data flow, cache strategy, schema/RLS and ADRs
- the relevant `api/` handler, `src/hooks/` hook and section component
- `src/types/api.ts` vs `src/types/index.ts` when a contract changes
- `vite.config.ts`, `vercel.json`, `tsconfig.app.json` / `tsconfig.node.json` for build/runtime boundaries

Prefer existing conventions. Introduce abstractions only when they reduce duplication or isolate a real boundary. A new integration follows the pattern: `api/<name>.ts` → hook honoring `isDemoMode` → section component under `src/components/<name>/`.

## Context economy
Read only files needed to answer the architectural question. Summarize discoveries instead of repeatedly copying source into prompts.
