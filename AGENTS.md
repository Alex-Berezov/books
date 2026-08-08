# AI Agent Guide — Bibliaris Backend

> Read this file BEFORE starting any development task.

---

## Project Overview

**Bibliaris Backend** — NestJS + Prisma + PostgreSQL API backend for classic literature audiobook platform.

- **Location:** `D:\newDev\books`
- **Stack:** NestJS, TypeScript, Prisma ORM, PostgreSQL, Docker
- **Base API URL:** `https://api.bibliaris.com/api`
- **Package Manager:** Yarn (NOT npm/pnpm)

---

## CRITICAL: Backend Execution Environment

**Production backend runs ONLY in Docker on a VPS.** Locally there is exactly one thing: a **throwaway PostgreSQL + Redis pair for e2e tests** (added 31.07.2026, WP-0.3). It is not a dev environment and not a copy of production data.

**What you CAN do:**

- Read and modify schema, DTOs, services, controllers
- Write migration SQL files in `prisma/migrations/` — the **user** applies them on the VPS
- Run e2e against the local test DB: `yarn test:e2e` (see below)
- Start/stop the local test services: `docker compose up -d postgres redis`, `docker compose ps`, `docker compose stop postgres redis`

**What you STILL CANNOT do:**

- Run the backend server locally
- Run `yarn prisma:migrate`, `yarn prisma:seed`, `npx prisma generate` or `psql` **directly** — still denied in `.claude/settings.json`. Migrations reach a database only through the e2e harness (throwaway DB) or through the user on the VPS
- Touch anything pointing at production: `docker-compose.prod.yml`, `--profile prod`, `docker compose down` (it would drop the local volume)
- Deploy. All backend changes are reviewed by the user before deployment

### Local e2e

```bash
docker compose up -d postgres redis   # once per session; user starts it if not running
# Требует REDIS_PASSWORD в `.env` — без переменной redis не поднимется (LEGACY-071)
yarn test:e2e                          # ~6–8 min, 46 suites (sentry self-skips)
```

`test/setup-e2e.ts` creates a **fresh database `e2e_<timestamp>`** per run, applies all migrations with `prisma migrate deploy`, seeds it, and `teardown-e2e.ts` drops it afterwards. Nothing persists between runs.

Two consequences worth using:

- **A hand-written migration is now testable before the VPS.** A full e2e run replays all migrations onto an empty database, so a broken one fails locally. `yarn drift-check` compares names only — the e2e run is what catches bad types, constraints and FK targets.
- **A failing trace test can be shown to fail.** The fix protocol (`books-app-docs/tasks/fixes/PLAN.md` §1) requires a test that fails before the change; without a database that was impossible for anything touching rights.

⚠️ **`.env.test` must point at localhost.** The harness runs `CREATE DATABASE` / `DROP DATABASE` against whatever `DATABASE_URL` it finds there. Never edit that file to point anywhere else, and never run e2e if you cannot confirm it is local.

---

## Code Style & Strict Quality Rules

- Backend STYLE_GUIDE: `D:\newDev\books\STYLE_GUIDE.md`
- **MANDATORY STYLE GUIDE CHECK**: Before reporting completion, the agent MUST review all modified/new code against `STYLE_GUIDE.md` (early throws, DTO structure, swagger decorators, controller/service split, naming conventions).
- **CRITICAL: NEVER IGNORE LINT ERRORS OR WARNINGS.**
- `any` types (`@typescript-eslint/no-explicit-any`) are STRICTLY FORBIDDEN.
- All DTOs must have class-validator and Swagger decorators.
- Controllers handle HTTP routing; business logic belongs in Services.

---

## Mandatory Validation Workflow & Post-Task Checklist

**MANDATORY after every backend change:**

1. **Code Style Check**: Verify all changes against `D:\newDev\books\STYLE_GUIDE.md`. Explicitly state in the response: _"всё соответствует кодстайлу (STYLE_GUIDE.md)"_.
2. **Docs Update Check**: Check if documentation in `books-app-docs` needs updating (API endpoints, DTOs, data model, etc.). If no update is required, explicitly state: _"документация не требует обновления"_.
3. **Quality Gates**: Run automated checks:

```bash
cd D:\newDev\books
yarn lint
yarn typecheck
yarn test
```

The AI agent MUST run `yarn lint`, `yarn typecheck`, and `yarn test` and ensure 0 errors and 0 warnings in modified files before reporting task completion to the user!

---

## Git Workflow

**CRITICAL RULE: NEVER commit or push without explicit user permission!**

The AI agent must **NEVER** execute `git commit` or `git push` on its own. All changes must be reviewed by the user first.

**Correct workflow:**

1. Complete task & verify tests/lint/typecheck
2. Present diff summary to user
3. Wait for explicit user confirmation before committing/pushing.
