---
name: security-review
description: Use when reviewing authentication, authorization, APIs, secrets, user input, dependencies or deployment configuration.
---

# Security Review

Treat all external input as untrusted. Review trust boundaries and authorization separately from authentication.

Never reveal secret values. Check that private environment variables never cross into client bundles: only `VITE_*` names are exposed by Vite, so a secret under that prefix is a leak. Server-only credentials belong in `api/` via `process.env`.

For Community, Supabase RLS is the authorization layer (the browser queries directly): verify policies for `edits`, `votes` and `reports`, and that only moderators can change `edits.status`. See `docs/SECURITY.md`.
