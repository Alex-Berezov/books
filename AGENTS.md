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
- Run `yarn prisma:generate` after changing `schema.prisma`. Это **кодогенерация типов из файла схемы**, к базе она не обращается вовсе — в отличие от `migrate`/`seed`/`studio`, вместе с которыми запрет стоял до 08.08.2026. Без неё после правки схемы падают typecheck и lint (`prisma.<новаяМодель>` — «error typed value»), и работа встаёт на ровном месте
- Run e2e against the local test DB: `yarn test:e2e` (see below)
- Start/stop the local test services: `docker compose up -d postgres redis`, `docker compose ps`, `docker compose stop postgres redis`

**What you STILL CANNOT do:**

- Run the backend server locally
- Touch anything pointing at production: `docker-compose.prod.yml`, `--profile prod`, `ssh`/`docker`/`psql` on the VPS, `prisma migrate deploy` bypassing the pipeline
- Run `docker run`, `docker exec`, `docker cp`, `docker container`, `docker create`, `docker start` or bare `docker-compose` — still denied in `.claude/settings.json`. A mounted volume reads `.env` around `Read(./.env)`, and `db-guard.js` does not look inside a container image
- Apply a **destructive** migration (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, narrowing a type with data loss). Write it, do not run it: `git revert` will not bring the rows back. It waits for the owner, and no release tag is cut in that pass

**What changed on 25.08.2026** (ТЗ `tasks/2026-08-25-avtonomnyy-harness.md`, раздел 8): the local
database is open. `yarn prisma:migrate`, `yarn prisma:seed`, `yarn prisma:studio`, `yarn db:*`,
`npx prisma …` and `psql` against `localhost` are **allowed** — you write a migration, apply it
locally, verify it, and ship it by tag through the pipeline. The line between the local database
and production is no longer a `deny` list by command name but the hook
`D:/newDev/.claude/hooks/db-guard.js`, which reads the connection string and sees the utility
through `docker exec`, `docker run`, `npx`, `yarn` and a shell wrapper.

⚠️ **Name the target in the command itself.** The guard is a whitelist: a command whose database
is not visible gets refused, because the address would come from `.env`, which the guard does not
read. Bare `yarn prisma:migrate` will not pass;
`DATABASE_URL="postgresql://...@localhost:5432/..." yarn prisma:migrate` will. "I cannot see where
it goes" is not "it goes locally" — that distinction is the whole point of replacing the `deny`
list with a hook.

Commit, push and release are allowed too, in the order `/auto` sets. `commit-gate.js` refuses a
commit without a `/qa` mark and green gates **for the current diff**, so the order holds without
a human in the loop.

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

**Commit and push are allowed, in the order `/auto` sets.** Changed 25.08.2026 (ТЗ
`tasks/2026-08-25-avtonomnyy-harness.md`). The owner no longer reads diffs; what a human used
to catch before a commit, a hook must now catch instead.

**Correct workflow:**

1. Complete the task and land a test that goes red if the defect comes back
2. Run `/qa` with the full reviewer set, then `node .claude/hooks/gates.js` with no `--repo`
3. Update the documents, then commit each touched repository separately, conventional commits,
   naming the record ids in the message
4. Push to `main`, then watch the run: `gh run list --limit 3`

**What holds the order is `D:/newDev/.claude/hooks/commit-gate.js`, not willpower.** It refuses
a commit with no `/qa` mark and no green gates **for the current diff**, a commit carrying
`--no-verify` or `--force`, build artefacts or freshly added secrets in the diff, a weakening
of a check in the added lines, or a message that is not conventional commits. Fix the cause
the refusal names; do not look for a way around it.

The only place you still stop and ask is the owner's four closed topics: secrets;
production infrastructure and the live database by hand, destructive migrations included;
public addresses; the legal semantics of book rights. Everything else you decide yourself
or through the `arbiter` subagent.
