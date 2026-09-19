---
name: vercel-deployment
description: Use for Vercel configuration, preview/production environments, build failures and environment-variable setup.
---

# Vercel Deployment

Never print secret values.

For environment variables:
- verify the variable name against `.env.example`
- verify the intended environment (Development/Preview/Production)
- verify whether it must be server-only (Twitch/YouTube/Instagram/TikTok/`SUPABASE_SERVICE_ROLE_KEY`) or browser-visible (`VITE_*` only)
- trigger a new deployment after configuration changes when appropriate (`VITE_*` values are baked in at build time)

For failures, diagnose from build/runtime logs before changing configuration. Common causes here: missing `.js` extension in an `api/` relative import, shared types imported from inside a function file, a Node version that does not match `engines` in `package.json`, or a helper module placed inside `api/` (it is deployed as its own function).
