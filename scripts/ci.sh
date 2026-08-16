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

# Nothing else compares the keys the code reads with `.env.example`: there is no validation
# schema on ConfigModule and no test over the example. That is how LEGACY-171 lived for years —
# the geo-block policy key was simply missing from the example (LEGACY-207).
step "Environment key check"
yarn check:env:self-test
yarn check:env

# Конфигурация мониторинга — единственная часть репозитория, которую до сих пор
# не читал ни один прогон: ни typecheck, ни lint, ни jest её не видят. Опечатка
# в `expr` или лишний отступ в `receivers` уезжали в main зелёными и всплывали
# только тем, что Alertmanager не поднимался на сервере (LEGACY-096, LEGACY-220).
# Образы пришпилены на те же версии, что в docker-compose.monitoring.yml:
# разойдутся — проверка перестанет отвечать на вопрос «а заведётся ли на проде».
# `amtool check-config` разбирает конфиг, но не читает `bot_token_file`, поэтому
# отсутствие секрета на машине проверке не мешает.
step "Monitoring config check (promtool + amtool)"
if ! command -v docker >/dev/null 2>&1; then
  echo "[CI] docker не найден, а без него конфиги мониторинга проверить нечем." >&2
  echo "[CI] Поставь docker или запускай этот шаг там, где он есть." >&2
  exit 1
fi
docker run --rm --entrypoint promtool -v "$ROOT_DIR/configs:/cfg:ro" \
  prom/prometheus:v2.45.1 check rules /cfg/alert_rules.yml /cfg/recording_rules.yml
docker run --rm --entrypoint amtool -v "$ROOT_DIR/configs:/cfg:ro" \
  prom/alertmanager:v0.26.0 check-config /cfg/alertmanager.yml

# `check rules` разбирает синтаксис, и правило с верным синтаксисом молчит навсегда,
# если наборы меток по обе стороны бинарного оператора не совпали. Так и случилось
# 16.08.2026 с обоими гео-правилами. `test rules` подставляет настоящие ряды и
# проверяет, срабатывает правило или нет — единственная проверка, которая это ловит.
step "Monitoring alert rules behaviour (promtool test rules)"
docker run --rm --entrypoint promtool -w /cfg -v "$ROOT_DIR/configs:/cfg:ro" \
  prom/prometheus:v2.45.1 test rules /cfg/alert_rules.test.yml

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
