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

step "Unit tests"
yarn test

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
