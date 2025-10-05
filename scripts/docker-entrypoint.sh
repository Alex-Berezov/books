#!/usr/bin/env bash
set -euo pipefail

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
