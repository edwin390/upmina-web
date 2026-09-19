---
name: git-workflow
description: Use for safe Git changes, commits, diffs and pull-request preparation.
---

# Git Workflow

Before committing:
- inspect git status
- inspect diff
- ensure no secrets (`.env` is never committed)
- ensure unrelated changes are excluded
- run relevant verification (`npm run lint`, `npm test`, `npm run build`)

Commits use Conventional Commits with a scope and preferably a Spanish description (history mixes both languages), e.g. `fix(twitch): mantener visible el estado del canal`. Branches: `feat/`, `fix/`, `chore/` prefixes; `main` is protected (PR + review). The husky pre-commit hook runs lint-staged; never bypass it with `--no-verify`.

Never force-push or discard user work without explicit instruction.
