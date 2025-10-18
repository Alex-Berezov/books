#!/bin/bash
# Скрипт применения настроек api.bibliaris.com на production сервере
# 
# ВНИМАНИЕ: Этот скрипт должен быть выполнен на production сервере!
# 
# Использование:
#   1. Скопируйте этот файл на сервер: scp scripts/apply-api-subdomain.sh deploy@209.74.88.183:~/
#   2. Подключитесь к серверу: ssh deploy@209.74.88.183
#   3. Запустите: bash apply-api-subdomain.sh --dry-run
#   4. Проверьте вывод, затем запустите без --dry-run

set -e

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
  DRY_RUN=true
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Настройка api.bibliaris.com на production${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}🔍 DRY RUN MODE - команды НЕ будут выполнены${NC}"
  echo ""
fi

# Функция для выполнения команд
run_cmd() {
  local cmd="$1"
  local description="$2"
  
  echo -e "${BLUE}▶ ${description}${NC}"
  echo "  Команда: $cmd"
  
  if [ "$DRY_RUN" = false ]; then
    eval "$cmd"
    if [ $? -eq 0 ]; then
      echo -e "  ${GREEN}✓ Успешно${NC}"
    else
      echo -e "  ${RED}✗ Ошибка${NC}"
      exit 1
    fi
  else
    echo -e "  ${YELLOW}⊘ Пропущено (dry-run)${NC}"
  fi
  echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Шаг 1: Проверка DNS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Шаг 1: Проверка DNS ═══${NC}"
echo ""

echo "Проверяем DNS запись для api.bibliaris.com..."
DNS_IP=$(dig +short api.bibliaris.com | head -n 1)

if [ -z "$DNS_IP" ]; then
  echo -e "${RED}✗ DNS запись для api.bibliaris.com не найдена!${NC}"
  echo ""
  echo "Пожалуйста, добавьте A-запись в Namecheap:"
  echo "  Type: A Record"
  echo "  Host: api"
  echo "  Value: 209.74.88.183"
  echo "  TTL: Automatic"
  echo ""
  echo "После добавления записи подождите несколько минут и запустите скрипт снова."
  exit 1
elif [ "$DNS_IP" != "209.74.88.183" ]; then
  echo -e "${YELLOW}⚠ DNS запись существует, но указывает на другой IP: $DNS_IP${NC}"
  echo "Ожидаемый IP: 209.74.88.183"
  echo ""
  read -p "Продолжить? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
else
  echo -e "${GREEN}✓ DNS запись корректна: api.bibliaris.com → $DNS_IP${NC}"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Шаг 2: Бэкап текущей конфигурации Caddy
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Шаг 2: Бэкап Caddy конфигурации ═══${NC}"
echo ""

BACKUP_FILE="/etc/caddy/Caddyfile.backup.$(date +%Y%m%d_%H%M%S)"
run_cmd "sudo cp /etc/caddy/Caddyfile $BACKUP_FILE" "Создание бэкапа Caddyfile"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Шаг 3: Обновление Caddy конфигурации
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Шаг 3: Обновление Caddyfile ═══${NC}"
echo ""

# Создаем новый Caddyfile
CADDYFILE_CONTENT='# API Backend
api.bibliaris.com {
    reverse_proxy localhost:5000

    # Security headers
    header {
        # HSTS
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        
        # Prevent clickjacking
        X-Frame-Options "SAMEORIGIN"
        
        # Prevent MIME sniffing
        X-Content-Type-Options "nosniff"
        
        # XSS Protection
        X-XSS-Protection "1; mode=block"
        
        # Referrer Policy
        Referrer-Policy "strict-origin-when-cross-origin"
        
        # CORS (разрешаем фронтенд домены)
        Access-Control-Allow-Origin "https://bibliaris.com"
        Access-Control-Allow-Credentials "true"
        Access-Control-Allow-Methods "GET, POST, PUT, DELETE, PATCH, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization, X-Admin-Language, Accept-Language"
    }

    # Логирование
    log {
        output file /var/log/caddy/api.bibliaris.com.access.log
        format json
    }
}

# Frontend (временно редирект на API docs)
bibliaris.com {
    redir https://api.bibliaris.com/docs permanent
    
    log {
        output file /var/log/caddy/bibliaris.com.access.log
        format json
    }
}

# Редиректы с www
www.bibliaris.com {
    redir https://bibliaris.com{uri} permanent
}

www.api.bibliaris.com {
    redir https://api.bibliaris.com{uri} permanent
}'

if [ "$DRY_RUN" = false ]; then
  echo "$CADDYFILE_CONTENT" | sudo tee /etc/caddy/Caddyfile > /dev/null
  echo -e "${GREEN}✓ Caddyfile обновлен${NC}"
else
  echo -e "${YELLOW}⊘ Обновление Caddyfile пропущено (dry-run)${NC}"
  echo ""
  echo "Новое содержимое Caddyfile:"
  echo "----------------------------------------"
  echo "$CADDYFILE_CONTENT"
  echo "----------------------------------------"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Шаг 4: Проверка и применение Caddy конфигурации
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Шаг 4: Проверка Caddy конфигурации ═══${NC}"
echo ""

run_cmd "sudo caddy validate --config /etc/caddy/Caddyfile" "Проверка синтаксиса Caddyfile"
run_cmd "sudo systemctl reload caddy" "Перезагрузка Caddy"
run_cmd "sudo systemctl status caddy --no-pager -l" "Проверка статуса Caddy"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Шаг 5: Обновление .env.prod
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Шаг 5: Обновление .env.prod ═══${NC}"
echo ""

ENV_FILE="/opt/books/app/src/.env.prod"

if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}✗ Файл $ENV_FILE не найден!${NC}"
  exit 1
fi

# Создаем бэкап .env.prod
run_cmd "cp $ENV_FILE ${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)" "Создание бэкапа .env.prod"

# Обновляем переменные
if [ "$DRY_RUN" = false ]; then
  # Обновляем LOCAL_PUBLIC_BASE_URL
  if grep -q "^LOCAL_PUBLIC_BASE_URL=" "$ENV_FILE"; then
    sudo sed -i 's|^LOCAL_PUBLIC_BASE_URL=.*|LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com|' "$ENV_FILE"
    echo -e "${GREEN}✓ LOCAL_PUBLIC_BASE_URL обновлен${NC}"
  else
    echo "LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com" | sudo tee -a "$ENV_FILE" > /dev/null
    echo -e "${GREEN}✓ LOCAL_PUBLIC_BASE_URL добавлен${NC}"
  fi
  
  # Обновляем CORS_ORIGIN
  if grep -q "^CORS_ORIGIN=" "$ENV_FILE"; then
    sudo sed -i 's|^CORS_ORIGIN=.*|CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001|' "$ENV_FILE"
    echo -e "${GREEN}✓ CORS_ORIGIN обновлен${NC}"
  else
    echo "CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001" | sudo tee -a "$ENV_FILE" > /dev/null
    echo -e "${GREEN}✓ CORS_ORIGIN добавлен${NC}"
  fi
else
  echo -e "${YELLOW}⊘ Обновление .env.prod пропущено (dry-run)${NC}"
  echo ""
  echo "Будут обновлены следующие переменные:"
  echo "  LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com"
  echo "  CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Шаг 6: Перезапуск приложения
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Шаг 6: Перезапуск приложения ═══${NC}"
echo ""

APP_DIR="/opt/books/app/src"
cd "$APP_DIR" || exit 1

run_cmd "docker compose -f docker-compose.prod.yml restart app" "Перезапуск Docker контейнера"

echo "Ожидание готовности контейнера (30 секунд)..."
if [ "$DRY_RUN" = false ]; then
  sleep 30
fi
echo ""

run_cmd "docker compose -f docker-compose.prod.yml ps" "Проверка статуса контейнеров"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Шаг 7: Проверка работоспособности
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Шаг 7: Проверка работоспособности ═══${NC}"
echo ""

if [ "$DRY_RUN" = false ]; then
  echo "Проверяем SSL и API endpoints..."
  echo ""
  
  # Проверка liveness
  echo "1. Проверка Liveness endpoint..."
  if curl -f -s -o /dev/null -w "HTTP %{http_code}" https://api.bibliaris.com/api/health/liveness; then
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${RED}✗${NC}"
  fi
  echo ""
  
  # Проверка readiness
  echo "2. Проверка Readiness endpoint..."
  if curl -f -s -o /dev/null -w "HTTP %{http_code}" https://api.bibliaris.com/api/health/readiness; then
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${RED}✗${NC}"
  fi
  echo ""
  
  # Проверка Swagger
  echo "3. Проверка Swagger UI..."
  if curl -f -s -o /dev/null -w "HTTP %{http_code}" https://api.bibliaris.com/docs; then
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${RED}✗${NC}"
  fi
  echo ""
  
  # Проверка CORS headers
  echo "4. Проверка CORS headers..."
  CORS_HEADER=$(curl -s -I https://api.bibliaris.com/api/health/liveness -H "Origin: https://bibliaris.com" | grep -i "access-control-allow-origin")
  if [ -n "$CORS_HEADER" ]; then
    echo -e " ${GREEN}✓ $CORS_HEADER${NC}"
  else
    echo -e " ${YELLOW}⚠ CORS headers не найдены${NC}"
  fi
  echo ""
  
  # Проверка SSL сертификата
  echo "5. Проверка SSL сертификата..."
  SSL_INFO=$(echo | openssl s_client -servername api.bibliaris.com -connect api.bibliaris.com:443 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null)
  if [ -n "$SSL_INFO" ]; then
    echo -e " ${GREEN}✓${NC}"
    echo "$SSL_INFO" | sed 's/^/   /'
  else
    echo -e " ${RED}✗ Не удалось получить информацию о сертификате${NC}"
  fi
else
  echo -e "${YELLOW}⊘ Проверки пропущены (dry-run)${NC}"
  echo ""
  echo "После применения настроек выполните следующие проверки:"
  echo "  1. curl https://api.bibliaris.com/api/health/liveness"
  echo "  2. curl https://api.bibliaris.com/api/health/readiness"
  echo "  3. Откройте в браузере: https://api.bibliaris.com/docs"
  echo "  4. Проверьте CORS: curl -I https://api.bibliaris.com/api/health/liveness -H 'Origin: https://bibliaris.com'"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Завершение
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}🔍 DRY RUN завершен!${NC}"
  echo ""
  echo "Для применения настроек запустите без флага --dry-run:"
  echo "  bash apply-api-subdomain.sh"
else
  echo -e "${GREEN}✅ Настройка api.bibliaris.com завершена успешно!${NC}"
  echo ""
  echo "Проверьте работу API:"
  echo "  • https://api.bibliaris.com/api/health/liveness"
  echo "  • https://api.bibliaris.com/api/health/readiness"
  echo "  • https://api.bibliaris.com/docs"
  echo "  • https://api.bibliaris.com/metrics"
  echo ""
  echo "Следующий шаг: Обновите GitHub Secret ENV_PROD с новыми значениями"
fi
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
