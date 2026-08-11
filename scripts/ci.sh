#!/usr/bin/env bash

# Portable CI pipeline for this repository.
# Runs the same checks locally and in any CI provider (GitHub/GitLab/etc.).
# Uses Yarn (classic) as the only package manager.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$ROOT_DIR"

echo "[CI] Node: $(node -v)"
echo "[CI] Yarn: $(yarn -v || true)"

step() { echo -e "\n\x1b[36m[CI] >>> $*\x1b[0m"; }

step "Install dependencies (frozen lockfile)"
yarn install --frozen-lockfile

step "Generate Prisma Client"
yarn prisma:generate

step "Lint"
yarn lint

step "Typecheck"
yarn typecheck

# Migrations are hand-written and applied by a human on the VPS (ADR-011), so nothing else
# proves that their sum still equals schema.prisma. Drift surfaces only in production.
step "Schema/migration drift check"
yarn drift-check:self-test
yarn drift-check

# С покрытием, а не просто `yarn test`: порог в `jest.coverageThreshold`
# срабатывает только при `--coverage`, иначе он декорация (LEGACY-016).
# Замер 11.08.2026: statements 63.98, branches 59.64, functions 61.18,
# lines 64.80 — пороги стоят примерно на 5 п.п. ниже. Запас взят намеренно
# большой: у фронта порог с зазором 0.1 п.п. краснел от любого коммита и
# приучал игнорировать CI (LEGACY-078).
step "Unit tests (with coverage thresholds)"
yarn test:cov

# E2E are optional by default to keep the script provider-agnostic.
# Enable by setting CI_E2E=1 and providing a working DATABASE_URL.
if [[ "${CI_E2E:-0}" == "1" ]]; then
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "[CI] CI_E2E=1, but DATABASE_URL is not set — skipping e2e."
  else
    step "E2E tests (serial)"
    yarn test:e2e:serial
  fi
else
  echo "[CI] E2E disabled (set CI_E2E=1 to enable)."
fi

step "Build"
yarn build

echo -e "\n\x1b[32m[CI] All steps completed successfully.\x1b[0m"
