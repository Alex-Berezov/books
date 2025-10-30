#!/bin/bash
# Скрипт для управления Swagger на production сервере

set -e

DEPLOY_DIR="/opt/books/app/src"
ENV_FILE=".env.prod"

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

function print_usage() {
  echo "Usage: $0 {enable|disable|status}"
  echo ""
  echo "Commands:"
  echo "  enable  - Включить Swagger (SWAGGER_ENABLED=1)"
  echo "  disable - Отключить Swagger (SWAGGER_ENABLED=0)"
  echo "  status  - Проверить текущий статус Swagger"
  echo ""
  echo "Example:"
  echo "  $0 enable   # Включить Swagger"
  echo "  $0 disable  # Отключить Swagger"
  echo "  $0 status   # Показать статус"
  exit 1
}

function check_env_file() {
  if [ ! -f "$DEPLOY_DIR/$ENV_FILE" ]; then
    echo -e "${RED}❌ Файл $ENV_FILE не найден в $DEPLOY_DIR${NC}"
    exit 1
  fi
}

function get_current_value() {
  cd "$DEPLOY_DIR"
  grep "^SWAGGER_ENABLED=" "$ENV_FILE" | cut -d'=' -f2 || echo "not_set"
}

function enable_swagger() {
  echo -e "${YELLOW}🔧 Включение Swagger...${NC}"
  
  cd "$DEPLOY_DIR"
  
  # Проверяем текущее значение
  CURRENT=$(get_current_value)
  
  if [ "$CURRENT" = "1" ]; then
    echo -e "${GREEN}✅ Swagger уже включен${NC}"
    return 0
  fi
  
  # Обновляем значение
  if grep -q "^SWAGGER_ENABLED=" "$ENV_FILE"; then
    sed -i 's/^SWAGGER_ENABLED=.*/SWAGGER_ENABLED=1/' "$ENV_FILE"
  else
    echo "SWAGGER_ENABLED=1" >> "$ENV_FILE"
  fi
  
  echo -e "${GREEN}✅ SWAGGER_ENABLED=1 установлен в $ENV_FILE${NC}"
  
  # Перезапускаем контейнер
  echo -e "${YELLOW}🔄 Перезапуск приложения...${NC}"
  docker compose --profile prod -f docker-compose.prod.yml restart app
  
  echo ""
  echo -e "${GREEN}✅ Swagger включен!${NC}"
  echo -e "${GREEN}📍 URL: https://api.bibliaris.com/docs${NC}"
  echo -e "${GREEN}📍 JSON: https://api.bibliaris.com/docs-json${NC}"
  echo ""
  echo -e "${YELLOW}⚠️  НЕ ЗАБУДЬТЕ ОТКЛЮЧИТЬ после использования: $0 disable${NC}"
}

function disable_swagger() {
  echo -e "${YELLOW}🔧 Отключение Swagger...${NC}"
  
  cd "$DEPLOY_DIR"
  
  # Проверяем текущее значение
  CURRENT=$(get_current_value)
  
  if [ "$CURRENT" = "0" ]; then
    echo -e "${GREEN}✅ Swagger уже отключен${NC}"
    return 0
  fi
  
  # Обновляем значение
  if grep -q "^SWAGGER_ENABLED=" "$ENV_FILE"; then
    sed -i 's/^SWAGGER_ENABLED=.*/SWAGGER_ENABLED=0/' "$ENV_FILE"
  else
    echo "SWAGGER_ENABLED=0" >> "$ENV_FILE"
  fi
  
  echo -e "${GREEN}✅ SWAGGER_ENABLED=0 установлен в $ENV_FILE${NC}"
  
  # Перезапускаем контейнер
  echo -e "${YELLOW}🔄 Перезапуск приложения...${NC}"
  docker compose --profile prod -f docker-compose.prod.yml restart app
  
  echo ""
  echo -e "${GREEN}✅ Swagger отключен${NC}"
}

function check_status() {
  echo -e "${YELLOW}🔍 Проверка статуса Swagger...${NC}"
  
  cd "$DEPLOY_DIR"
  
  CURRENT=$(get_current_value)
  
  echo ""
  echo "Конфигурация ($ENV_FILE):"
  echo "  SWAGGER_ENABLED=$CURRENT"
  echo ""
  
  if [ "$CURRENT" = "1" ]; then
    echo -e "${GREEN}✅ Swagger ВКЛЮЧЕН${NC}"
    echo -e "${GREEN}📍 URL: https://bibliaris.com/docs${NC}"
    echo -e "${GREEN}📍 JSON: https://bibliaris.com/docs-json${NC}"
  elif [ "$CURRENT" = "0" ]; then
    echo -e "${YELLOW}⚠️  Swagger ОТКЛЮЧЕН${NC}"
  else
    echo -e "${RED}❌ SWAGGER_ENABLED не установлен${NC}"
  fi
  
  echo ""
  echo "Проверка логов приложения:"
  docker compose --profile prod -f docker-compose.prod.yml logs app 2>/dev/null | grep -i "swagger" | tail -n 3 || echo "  (логов не найдено)"
}

# Main script
if [ "$#" -ne 1 ]; then
  print_usage
fi

check_env_file

case "$1" in
  enable)
    enable_swagger
    ;;
  disable)
    disable_swagger
    ;;
  status)
    check_status
    ;;
  *)
    print_usage
    ;;
esac
