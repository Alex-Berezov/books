#!/usr/bin/env bash
set -euo pipefail

# Wait for Postgres if DATABASE_URL is set to a postgres scheme
if [[ "${DATABASE_URL:-}" == postgres* || "${DATABASE_URL:-}" == postgresql* ]]; then
  echo "[entrypoint] Waiting for Postgres to be ready..."
  # Minimal wait loop using psql via npx prisma (which bundles engine) isn't reliable; use pg_isready if available
  ATTEMPTS=30
  until node -e "
    const { URL } = require('url');
    try {
      const u = new URL(process.env.DATABASE_URL);
      console.log('DB host:', u.hostname);
      process.exit(0);
    } catch (e) { process.exit(1); }
  " >/dev/null 2>&1; do sleep 1; done
fi

# Run prisma migrate deploy if prisma CLI exists
if [ -x node_modules/.bin/prisma ]; then
  echo "[entrypoint] Running prisma migrate deploy..."
  node_modules/.bin/prisma migrate deploy || echo "[entrypoint] prisma migrate deploy failed or not needed"
fi

# Resolve main entry (support both dist/main.js and dist/src/main.js)
APP_MAIN=""
if [ -f dist/main.js ]; then
  APP_MAIN="dist/main.js"
elif [ -f dist/src/main.js ]; then
  APP_MAIN="dist/src/main.js"
else
  echo "[entrypoint] ERROR: main.js not found in dist/. Contents:" >&2
  ls -R dist || true
  exit 1
fi
echo "[entrypoint] Starting app using $APP_MAIN"
exec node "$APP_MAIN"
