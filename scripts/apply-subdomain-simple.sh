#!/bin/bash
# Простой скрипт применения настроек api.bibliaris.com
# Запуск: sudo bash apply-subdomain-simple.sh

set -e

echo "=== Применение настроек api.bibliaris.com ==="
echo ""

# 1. Создать бэкап Caddyfile
echo "▶ Создание бэкапа Caddyfile..."
BACKUP_FILE="/etc/caddy/Caddyfile.backup.$(date +%Y%m%d_%H%M%S)"
cp /etc/caddy/Caddyfile "$BACKUP_FILE"
echo "✓ Бэкап создан: $BACKUP_FILE"
echo ""

# 2. Обновить Caddyfile
echo "▶ Обновление Caddyfile..."
cp ~/Caddyfile.new /etc/caddy/Caddyfile
echo "✓ Caddyfile обновлён"
echo ""

# 3. Проверить синтаксис Caddy
echo "▶ Проверка синтаксиса Caddy..."
caddy validate --config /etc/caddy/Caddyfile
echo "✓ Синтаксис корректен"
echo ""

# 4. Перезапустить Caddy
echo "▶ Перезапуск Caddy..."
systemctl reload caddy
echo "✓ Caddy перезапущен"
echo ""

# 5. Обновить .env.prod
echo "▶ Обновление .env.prod..."
cd /opt/books/app/src

# Бэкап .env.prod
cp .env.prod .env.prod.backup.$(date +%Y%m%d_%H%M%S)

# Обновить переменные
sed -i 's|LOCAL_PUBLIC_BASE_URL=.*|LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com|' .env.prod
sed -i 's|CORS_ORIGIN=.*|CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001|' .env.prod

echo "✓ .env.prod обновлён"
echo ""

# 6. Перезапустить приложение
echo "▶ Перезапуск приложения..."
docker compose -f docker-compose.prod.yml restart app
echo "✓ Приложение перезапущено"
echo ""

# 7. Ожидание готовности
echo "▶ Ожидание готовности приложения (30 секунд)..."
sleep 30
echo ""

# 8. Проверка статуса
echo "▶ Проверка статуса контейнеров..."
docker compose -f docker-compose.prod.yml ps
echo ""

echo "=== ✓ Настройка завершена успешно! ==="
echo ""
echo "Проверьте endpoints:"
echo "  curl https://api.bibliaris.com/api/health/liveness"
echo "  curl https://api.bibliaris.com/docs"
echo "  curl https://api.bibliaris.com/metrics"
