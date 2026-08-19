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

# LEGACY-241. Синтаксис shell-скриптов. `scripts/*.sh` — слепая зона: их не читает ни
# eslint (он ходит по `{src,apps,libs,test}/**/*.ts`), ни tsc, ни jest. До 17.08.2026
# это было терпимо: единственный `deploy_production.sh` исполнялся на сервере, и его
# отказ был отказом выката. Теперь `notify_telegram.sh` вызывается из job'а `deploy`
# **до** отметки `📍 Mark server stage reached`, и опечатка в нём валит релиз при
# полностью исправном приложении.
#
# ⚠️ Стоит рядом с линтом, а не в конце: это самая дешёвая проверка в файле (доли
# секунды на 26 скриптов), и ответ о неразобранной кавычке не должен ждать тестов.
#
# ⚠️ `bash -n` ловит только синтаксис. Логику он не проверяет и проверять не должен:
# поведенческие ветки скрипта закрывает `src/devops/deploy-trigger.spec.ts`.
step "Shell script syntax (bash -n)"
for sh_file in "$ROOT_DIR"/scripts/*.sh; do
  echo "  $(basename "$sh_file")"
  bash -n "$sh_file"
done

# Migrations are hand-written and applied by a human on the VPS (ADR-011), so nothing else
# proves that their sum still equals schema.prisma. Drift surfaces only in production.
#
# LEGACY-123. С 19.08.2026 тот же прогон несёт третий проход: имена таблиц и колонок внутри
# шаблонов `$queryRaw` и `Prisma.sql` сверяются с `schema.prisma`. Читаются `src/`, `prisma/`
# и `libs/` — обслуживающие скрипты в `prisma/scripts/` ломает то же переименование. До него связь этих шести
# запросов со схемой не держало ничто: `tsc` внутрь шаблона не смотрит, `prisma generate`
# типизирует делегатов, и переименование колонки уезжало на прод зелёным, чтобы упасть
# на публичном маршруте. Отдельного шага у прохода нет намеренно — источник имён у всех
# трёх проходов один, а два места вызова означали бы два места, где можно забыть про третье.
#
# Self-test идёт первым и здесь тоже: проверка, которая не краснеет на подложенном дефекте,
# приучает игнорировать свой вывод (LEGACY-045).
step "Schema/migration drift + raw SQL identifiers"
yarn drift-check:self-test
yarn drift-check

# ADR-018. Релиз несёт всё, что слито с прошлого тега (LEGACY-241), а `prisma migrate deploy`
# не оборачивает пачку в транзакцию: отказ на пятой миграции из семи оставляет четыре
# применёнными. Пережить это можно ровно пока предыдущий образ работает на новой схеме —
# то есть пока в миграции нет разрушающей конструкции. Откат здесь откатывает образ, а не
# схему, поэтому проверка и делает откат осмысленным (LEGACY-242).
step "Migration backwards-compatibility check"
yarn check-migration-compat:self-test
yarn check-migration-compat

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

# LEGACY-224/225. `prometheus.yml` до 16.08.2026 не разбирал ни один шаг: `check rules`
# читает только файлы правил, `amtool check-config` — только конфиг Alertmanager. При этом
# именно в `prometheus.yml` живут абсолютные пути внутрь контейнера (`credentials_file`)
# и относительные `rule_files`, резолвящиеся от каталога конфига. Опечатка в любом из них
# не краснеет нигде и всплывает только тем, что Prometheus на сервере не поднимается.
#
# ⚠️ Каталог копируется, а не монтируется как есть: в непроверочном режиме `check config`
# требует существования файла из `credentials_file`, а `configs/metrics_token` в git
# не едет (`.gitignore`). Пустышка нужна ровно для проверки раскладки путей, значение
# секрета здесь не участвует. `--syntax-only` не годится: он отключает как раз проверку
# существования файлов правил, то есть единственное, зачем этот шаг заведён.
# Точка монтирования `/cfg` совпадает с продовой (`docker-compose.monitoring.yml`),
# поэтому проверяются те же абсолютные пути, что будут на сервере.
step "Prometheus config check (promtool check config)"
# Оба каталога создаются до trap'а по одному, чтобы уборка ловила и отказ второго
# `mktemp`. Других trap'ов в файле нет — этот не перекрывает чужой; через trap,
# а не строкой после вызова, потому что при `set -e` падение `check config`
# оборвало бы скрипт до уборки.
CFG_CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CFG_CHECK_DIR" "${SECRETS_CHECK_DIR:-}"' EXIT
SECRETS_CHECK_DIR="$(mktemp -d)"
# Каталог копируется целиком, включая `grafana/**`: иначе `rule_files`, указывающий
# во вложенный каталог, краснел бы в CI при исправном сервере. Прямое монтирование
# `configs/` не годится: `chmod -R a+rX` нужен, чтобы promtool под `nobody` вошёл
# в каталог, а рабочее дерево портить нельзя. `--exclude` — страховка от возврата
# секрета внутрь `configs/` (там он `400` и принадлежит 65534, `cp` из-под `deploy`
# вернул бы `Permission denied`); с 16.08.2026 секретов там быть не должно вовсе.
tar -cf - -C "$ROOT_DIR/configs" --exclude='*token*' . | tar -xf - -C "$CFG_CHECK_DIR"
# Секреты монтируются отдельным каталогом (LEGACY-226), поэтому и пустышка лежит
# в отдельном: `credentials_file` указывает в `/secrets`, а `check config`
# в непроверочном режиме требует, чтобы файл существовал. Значение не участвует.
printf 'ci-dummy-token\n' > "$SECRETS_CHECK_DIR/metrics_token"
# 🔴 `mktemp -d` создаёт каталог `0700`, а promtool в образе работает под `nobody`
# (uid 65534): без прав на вход он не откроет ни конфиг, ни секрет. Соседние шаги
# живы потому, что монтируют `configs/` после checkout, то есть `0755`.
chmod -R a+rX "$CFG_CHECK_DIR" "$SECRETS_CHECK_DIR"
docker run --rm --entrypoint promtool \
  -v "$CFG_CHECK_DIR:/cfg:ro" -v "$SECRETS_CHECK_DIR:/secrets:ro" \
  prom/prometheus:v2.45.1 check config /cfg/prometheus.yml

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
