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

**Backend runs ONLY in Docker on a VPS!**

- Database (PostgreSQL) is NOT available on localhost
- **NEVER** attempt to run database migrations, seeds, or queries locally
- **NEVER** run `yarn prisma:migrate`, `yarn prisma:seed`, `npx prisma generate`, or `psql` commands locally
- All backend changes (schema, migrations, DTOs) must be reviewed by the user before deployment
- To test backend changes, the user will deploy them to VPS manually

**What you CAN do with backend code:**

- Read and modify schema, DTOs, services, controllers
- Create migration SQL files in `prisma/migrations/` (user will apply them on VPS)
- Review and suggest backend improvements

**What you CANNOT do:**

- Run the backend server locally
- Connect to the database locally
- Execute migrations, seeds, or `prisma generate` locally
- Test API endpoints against local server

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
