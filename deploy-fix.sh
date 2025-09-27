#!/bin/bash
# Скрипт для исправления проблемы с развертыванием на сервере

set -euo pipefail

echo "=== Fixing Docker deployment issue ==="

# 1. Остановить контейнеры
echo "1. Stopping containers..."
docker compose -f docker-compose.prod.yml down

# 2. Пересобрать образ без кэша
echo "2. Rebuilding image without cache..."
if ! docker compose -f docker-compose.prod.yml build --no-cache app; then
  echo "ERROR: Docker build failed. Checking builder stage..."
  docker build --target builder -t books-app:builder-debug .
  echo "Checking if dist directory exists in builder:"
  docker run --rm books-app:builder-debug ls -la /app/ || true
  docker run --rm books-app:builder-debug ls -la /app/dist/ || true
  exit 1
fi

# 3. Запустить контейнеры
echo "3. Starting containers..."
docker compose -f docker-compose.prod.yml up -d

# 4. Показать логи для проверки
echo "4. Checking logs (first 50 lines)..."
sleep 5
docker compose -f docker-compose.prod.yml logs --tail=50 app

echo "=== Deployment fix completed ==="
echo "Check if application is running with:"
echo "docker compose -f docker-compose.prod.yml ps"
echo "curl -I http://localhost:5000/metrics"
