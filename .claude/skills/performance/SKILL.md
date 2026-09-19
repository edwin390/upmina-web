---
name: performance
description: Use when diagnosing slow frontend, API or build behavior.
---

# Performance

Measure or identify a concrete bottleneck before optimizing.

Check:
- repeated renders
- duplicate requests or a wrong `staleTime`/`refetchInterval` (see the cache table in `docs/ARCHITECTURE.md`)
- missing or too-short `s-maxage` on `api/` handlers (upstream quota: YouTube 10k units/day, Instagram 200 req/h)
- N+1 calls to Supabase or upstream APIs
- large bundles and eagerly loaded social embeds
- expensive serialization
- image/font loading
- unnecessary dependencies

Prefer simple changes with measurable impact.
