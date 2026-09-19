---
name: frontend-quality
description: Use for React 19/Vite UI implementation with HeroUI and Tailwind, responsive design, accessibility, loading/error states and frontend performance.
---

# Frontend Quality

For UI work check:
- semantic HTML
- keyboard navigation
- focus states
- responsive layout (mobile, tablet, desktop)
- loading/empty/error states for every query-backed section
- `isDemoMode` behavior (mock/empty data) and Supabase-`null` behavior in Community
- image/font performance and lazy embeds (Twitch, TikTok, Instagram are heavy)
- unnecessary client-side JavaScript and new dependencies
- Tailwind tokens from `tailwind.config.js` instead of ad-hoc colors (goth/alt/neon identity, `docs/DESIGN_SYSTEM.md`)
- Spanish UI copy

Prefer HeroUI components and the project's existing UI primitives.
