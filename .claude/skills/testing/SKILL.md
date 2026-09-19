---
name: testing
description: Use when creating or improving tests for this repo's TypeScript code, React components and Vercel Functions (Vitest + Playwright).
---

# Testing

Prefer focused tests that prove behavior.

Use the existing runners: Vitest (jsdom, globals, `src/setupTests.ts`, tests co-located with the file) and Playwright (`e2e/`, excluded from Vitest). Test normal behavior plus boundaries and failures. For `api/` changes, include malformed-input and upstream-failure cases (mock `fetch`). For hooks, cover demo mode on/off and a non-OK response. For UI changes, test user-visible behavior rather than implementation details.

Do not add snapshots unless they provide clear value.
