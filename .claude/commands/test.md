---
description: Generate and run focused tests for the current change
---

Read the relevant implementation and existing tests. Generate the smallest useful test set with Vitest (co-located `*.test.ts(x)`), run it with `npx vitest run <file>`, and report exact results. Cover happy path, boundaries and failure paths (non-OK fetch, demo mode on/off, Supabase `null`) where applicable. Use Playwright (`e2e/`) only for user-visible flows.
