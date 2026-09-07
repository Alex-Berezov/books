# AI Agent Guide — Bibliaris Backend

> Read this file BEFORE starting any development task.

---

## Project Overview

**Bibliaris Backend** — NestJS + Prisma + PostgreSQL API backend for classic literature audiobook platform.

- **Location:** `D:\newDev\books`
- **Stack:** NestJS 11 on TypeScript 5.7, Prisma 7 through `@prisma/adapter-pg` over `pg.Pool`,
  PostgreSQL 14, Redis 7 with BullMQ, Docker
- **Base API URL:** `https://api.bibliaris.com/api`
- **Package Manager:** Yarn 1 (NOT npm/pnpm); tests — jest; base branch — `main`
- **Neighbours:** `../books-front`, `../books-app-docs`; reach them with `git -C <path>`, never `cd`

---

## CRITICAL: Backend Execution Environment

**Production backend runs ONLY in Docker on a VPS.** Locally there is exactly one thing: a **throwaway PostgreSQL + Redis pair for e2e tests** (added 31.07.2026, WP-0.3). It is not a dev environment and not a copy of production data.

**What you CAN do:**

- Read and modify schema, DTOs, services, controllers
- Write migration SQL files in `prisma/migrations/` — the **user** applies them on the VPS
- Run `yarn prisma:generate` after changing `schema.prisma`. Это **кодогенерация типов из файла схемы**, к базе она не обращается вовсе — в отличие от `migrate`/`seed`/`studio`, вместе с которыми запрет стоял до 08.08.2026. Без неё после правки схемы падают typecheck и lint (`prisma.<новаяМодель>` — «error typed value»), и работа встаёт на ровном месте
- Run e2e against the local test DB: `yarn test:e2e` (see below)
- Start/stop the local test services: `docker compose up -d postgres redis`, `docker compose ps`, `docker compose stop postgres redis`

**What you STILL CANNOT do:** run the backend server locally, and touch anything pointing at
production. The exact list — what is denied outright, where the line between the local database
and production is drawn, and what a destructive migration means for the release tag — is a rule,
not an environment fact, and lives in `books/CLAUDE.md` §«Жёсткие запреты» п.2. Do not restate
it here: the copy that used to stand in this spot is how the two files drifted apart
(`LEGACY-168`).

### Local e2e

```bash
cd D:/newDev/books                     # every command in this block is relative to the repo root
docker compose up -d postgres redis   # once per session; user starts it if not running
# Требует REDIS_PASSWORD в `.env` — без переменной redis не поднимется (LEGACY-071)
yarn test:e2e                          # all test/**/*.e2e-spec.ts (sentry self-skips); count via `find test -name "*.e2e-spec.ts" | wc -l`
# Duration scales with that count and is not quoted here: measure it on your own machine once.
```

`test/setup-e2e.ts` creates a **fresh database `e2e_<timestamp>`** per run, applies all migrations with `prisma migrate deploy`, seeds it, and `teardown-e2e.ts` drops it afterwards. Nothing persists between runs.

Two consequences worth using:

- **A hand-written migration is now testable before the VPS.** A full e2e run replays all migrations onto an empty database, so a broken one fails locally. `yarn drift-check` compares names only — the e2e run is what catches bad types, constraints and FK targets.
- **A failing trace test can be shown to fail.** The landing rule (`books-app-docs/ai-context/tech-debt-autopilot.md`, «Посадка на каждую правку») requires a test that goes red when the defect comes back; without a database that was impossible for anything touching rights. The old address for that protocol — books-app-docs/tasks/fixes/PLAN.md, written here without backticks because it no longer resolves — has not existed for a long time: `tasks/` holds `authors-hub.md` and `relaxation/`, and the fixes stage was archived as `books-app-docs/history/rights-clearance-fixes.md` (`LEGACY-169`).

⚠️ **`.env.test` must point at localhost.** The harness runs `CREATE DATABASE` / `DROP DATABASE` against whatever `DATABASE_URL` it finds there. Never edit that file to point anywhere else, and never run e2e if you cannot confirm it is local.

---

## Code Style & Strict Quality Rules

Where the conventions live: `books/STYLE_GUIDE.md` — early throws, DTO structure, swagger
decorators, the controller/service split, naming. Shape, not procedure:

- All DTOs carry class-validator and Swagger decorators.
- Controllers handle HTTP routing; business logic belongs in Services.
- `any` is unwanted — but note that **nothing catches it here**:
  `@typescript-eslint/no-explicit-any` is switched OFF in `eslint.config.mjs` and
  `noImplicitAny` is off in `tsconfig.json`. Writing «STRICTLY FORBIDDEN» in this file did not
  make it so for six months; the type is written by hand or it is not written at all
  (`books/CLAUDE.md` §«Специфика проекта»).

When to run what, and the requirement of zero warnings in the files you touched, live in
`books/CLAUDE.md` §«Команды» — not here.

---

## Executable rules live in `CLAUDE.md`

This file describes the environment: stack, layout, the local test database, where things are.
**The rules an agent must execute — quality gates, commit and push order, the hard prohibitions —
live in `books/CLAUDE.md`.** That file is what the harness loads automatically; this one is not.
The owner's four topics (secrets; production infrastructure and the live database by hand; public
addresses; the legal semantics of book rights) live one level up, in `D:/newDev/CLAUDE.md`
§«Что остаётся за владельцем» — they are the same for all three repositories, so no repository
keeps its own copy.

The copy that stood here until 07.09.2026 had drifted (`LEGACY-168`): it prescribed running
`yarn lint`, `yarn typecheck` and `yarn test` by hand and then **saying** the phrases «всё
соответствует кодстайлу» and «документация не требует обновления». Both are ritual in place of
output. What actually decides is the real output of `node D:/newDev/.claude/hooks/gates.js`,
checked against the diff by `D:/newDev/.claude/hooks/report-honesty.js`, which does not let a
claim of green checks through without a recorded run.
