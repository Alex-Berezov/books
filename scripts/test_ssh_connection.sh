#!/bin/bash

# 🔐 Скрипт для проверки SSH подключения к production серверу
# Использование: ./test_ssh_connection.sh [server_ip_or_domain]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_KEY="${SCRIPT_DIR}/../.github-secrets/deploy_key"

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔐 Проверка SSH подключения к production серверу${NC}"
echo ""

# Проверка наличия ключа
if [[ ! -f "$DEPLOY_KEY" ]]; then
    echo -e "${RED}❌ Ошибка: Deploy ключ не найден: $DEPLOY_KEY${NC}"
    echo -e "${YELLOW}💡 Запустите: ssh-keygen -t ed25519 -f .github-secrets/deploy_key -N '' -C 'github-actions-deploy@books-app'${NC}"
    exit 1
fi

# Получение адреса сервера
if [[ -n "$1" ]]; then
    SERVER="$1"
else
    echo -e "${YELLOW}📝 Введите адрес production сервера (IP или домен):${NC}"
    read -r SERVER
fi

if [[ -z "$SERVER" ]]; then
    echo -e "${RED}❌ Ошибка: Адрес сервера не указан${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}📋 Параметры подключения:${NC}"
echo -e "  Сервер: ${GREEN}$SERVER${NC}"
echo -e "  Пользователь: ${GREEN}deploy${NC}"
echo -e "  Ключ: ${GREEN}$DEPLOY_KEY${NC}"
echo ""

# Проверка прав на ключ
PERMS=$(stat -c %a "$DEPLOY_KEY" 2>/dev/null || stat -f %A "$DEPLOY_KEY" 2>/dev/null)
if [[ "$PERMS" != "600" ]]; then
    echo -e "${YELLOW}⚠️  Неправильные права на ключ: $PERMS (ожидается 600)${NC}"
    echo -e "${YELLOW}🔧 Исправляю права...${NC}"
    chmod 600 "$DEPLOY_KEY"
    echo -e "${GREEN}✅ Права исправлены${NC}"
    echo ""
fi

# Попытка подключения
echo -e "${BLUE}🔌 Попытка подключения к серверу...${NC}"
echo ""

if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "deploy@$SERVER" "echo '✅ SSH подключение успешно!'" 2>/dev/null; then
    echo ""
    echo -e "${GREEN}✅ Успешное подключение к серверу!${NC}"
    echo ""
    
    # Дополнительные проверки
    echo -e "${BLUE}🔍 Дополнительные проверки:${NC}"
    echo ""
    
    # Проверка Docker
    if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no "deploy@$SERVER" "docker --version" 2>/dev/null; then
        echo -e "${GREEN}✅ Docker доступен${NC}"
    else
        echo -e "${YELLOW}⚠️  Docker недоступен для пользователя deploy${NC}"
    fi
    
    # Проверка директории
    if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no "deploy@$SERVER" "test -d /opt/books/app && echo 'exists'" 2>/dev/null | grep -q "exists"; then
        echo -e "${GREEN}✅ Директория /opt/books/app существует${NC}"
    else
        echo -e "${YELLOW}⚠️  Директория /opt/books/app не найдена${NC}"
        echo -e "${YELLOW}💡 Создайте: sudo mkdir -p /opt/books/app && sudo chown -R deploy:deploy /opt/books${NC}"
    fi
    
    # Проверка прав на запись
    if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no "deploy@$SERVER" "test -w /opt/books/app && echo 'writable'" 2>/dev/null | grep -q "writable"; then
        echo -e "${GREEN}✅ У deploy есть права на запись в /opt/books/app${NC}"
    else
        echo -e "${YELLOW}⚠️  У deploy нет прав на запись в /opt/books/app${NC}"
    fi
    
    echo ""
    echo -e "${GREEN}🎉 SSH настроен правильно!${NC}"
    echo -e "${BLUE}📝 Следующие шаги:${NC}"
    echo -e "  1. Добавьте приватный ключ в GitHub Secrets (DEPLOY_SSH_KEY)"
    echo -e "  2. Добавьте переменную PRODUCTION_SERVER=$SERVER в GitHub Variables"
    echo -e "  3. Запустите GitHub Actions workflow"
    echo ""
    
else
    echo ""
    echo -e "${RED}❌ Не удалось подключиться к серверу${NC}"
    echo ""
    echo -e "${YELLOW}🔍 Возможные причины:${NC}"
    echo -e "  1. Публичный ключ не добавлен на сервер"
    echo -e "  2. Неправильный адрес сервера"
    echo -e "  3. Пользователь 'deploy' не создан"
    echo -e "  4. Неправильные права на ~/.ssh/authorized_keys"
    echo ""
    echo -e "${BLUE}📝 Для детальной диагностики используйте:${NC}"
    echo -e "  ssh -vvv -i $DEPLOY_KEY deploy@$SERVER"
    echo ""
    echo -e "${BLUE}📖 Инструкции по настройке:${NC}"
    echo -e "  cat .github-secrets/SETUP_INSTRUCTIONS.md"
    echo ""
    exit 1
fi
