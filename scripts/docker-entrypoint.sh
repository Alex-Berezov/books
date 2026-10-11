#!/usr/bin/env bash
set -euo pipefail

# Expand variable placeholders in DATABASE_URL if present (e.g., ${POSTGRES_PORT})
if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" == *'${'* ]]; then
  echo "[entrypoint] Expanding variables in DATABASE_URL from environment..."
  # shellcheck disable=SC2034
  DATABASE_URL=$(eval echo "$DATABASE_URL")
  export DATABASE_URL
fi

# Wait for Postgres if DATABASE_URL is set to a postgres scheme
if [[ "${DATABASE_URL:-}" == postgres* || "${DATABASE_URL:-}" == postgresql* ]]; then
  echo "[entrypoint] Waiting for Postgres to be ready..."
  # Extract host and port from DATABASE_URL and test actual connection
  DB_HOST=$(node -e "
    try {
      const u = new URL(process.env.DATABASE_URL);
      console.log(u.hostname);
    } catch (e) { 
      console.log('postgres'); 
    }
  ")
  DB_PORT=$(node -e "
    try {
      const u = new URL(process.env.DATABASE_URL);
      console.log(u.port || '5432');
    } catch (e) { 
      console.log('5432'); 
    }
  ")
  
  ATTEMPTS=30
  for i in $(seq 1 $ATTEMPTS); do
    if nc -z "$DB_HOST" "$DB_PORT"; then
      echo "[entrypoint] Postgres is ready!"
      break
    fi
    if [ "$i" -eq "$ATTEMPTS" ]; then
      echo "[entrypoint] Postgres is not ready after $ATTEMPTS attempts, continuing anyway..."
    fi
    echo "[entrypoint] Waiting for Postgres... attempt $i/$ATTEMPTS"
    sleep 2
  done
fi

# LEGACY-457: процесс работает не от root. Локальный драйвер хранилища (STORAGE_DRIVER не r2,
# пусто - тоже local) пишет на диск, поэтому каталоги должны быть доступны на запись: иначе
# первая загрузка упадёт EACCES посреди работы. Заполненный том, созданный под root, надо
# отдать uid 1000 снаружи (chown -R), образ его владельца не меняет. Проверяется только верхний
# уровень каталога: вложенные каталоги под root эта проверка не видит, поэтому chown - рекурсивный.
storage_driver=$(printf '%s' "${STORAGE_DRIVER:-local}" | tr '[:upper:]' '[:lower:]')
if [ "$storage_driver" != "r2" ]; then
  for dir in "${LOCAL_UPLOADS_DIR:-./var/uploads}" "${RIGHTS_FILES_LOCAL_DIR:-./var/rights-files}"; do
    if ! mkdir -p "$dir" 2>/dev/null || ! probe=$(mktemp "$dir/.write-check.XXXXXX" 2>/dev/null); then
      echo "[entrypoint] ERROR: directory '$dir' is not writable for uid $(id -u) (STORAGE_DRIVER='${STORAGE_DRIVER:-}'). Give the volume to uid 1000 recursively (chown -R 1000:1000) or set STORAGE_DRIVER=r2." >&2
      exit 1
    fi
    rm -f "$probe"
  done
fi

# Run prisma migrate deploy if prisma CLI exists
if [ -x node_modules/.bin/prisma ]; then
  echo "[entrypoint] Running prisma migrate deploy..."
  node_modules/.bin/prisma migrate deploy || echo "[entrypoint] prisma migrate deploy failed or not needed"
fi

# Start the application
if [ ! -f dist/main.js ]; then
  echo "[entrypoint] ERROR: dist/main.js not found. Contents:" >&2
  ls -R dist || true
  exit 1
fi
echo "[entrypoint] Starting application..."
exec node dist/main.js
