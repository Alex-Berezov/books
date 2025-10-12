#!/bin/bash

# 🔑 Помощник для настройки GitHub Secrets
# Использование: ./copy_github_secret.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_FILE="${SCRIPT_DIR}/../.github-secrets/deploy_key"

# Цвета
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}🔑 GitHub Secrets Setup Helper${NC}"
echo ""

# Проверка наличия ключа
if [[ ! -f "$KEY_FILE" ]]; then
    echo -e "${RED}❌ Ошибка: Ключ не найден: $KEY_FILE${NC}"
    exit 1
fi

# Копирование в буфер обмена
if command -v xclip &> /dev/null; then
    cat "$KEY_FILE" | xclip -selection clipboard
    CLIPBOARD_CMD="xclip"
elif command -v xsel &> /dev/null; then
    cat "$KEY_FILE" | xsel --clipboard
    CLIPBOARD_CMD="xsel"
elif command -v wl-copy &> /dev/null; then
    cat "$KEY_FILE" | wl-copy
    CLIPBOARD_CMD="wl-copy"
else
    echo -e "${YELLOW}⚠️  Утилита копирования не найдена${NC}"
    echo -e "${YELLOW}📦 Установите: sudo apt install xclip${NC}"
    echo ""
    echo -e "${BLUE}📋 Приватный ключ:${NC}"
    cat "$KEY_FILE"
    exit 0
fi

echo -e "${GREEN}✅ Приватный ключ скопирован в буфер обмена (через $CLIPBOARD_CMD)!${NC}"
echo ""
echo -e "${BLUE}📝 Следующие шаги:${NC}"
echo ""
echo "1️⃣  Откройте GitHub Secrets:"
echo "   https://github.com/Alex-Berezov/books/settings/secrets/actions"
echo ""
echo "2️⃣  Нажмите 'New repository secret'"
echo ""
echo "3️⃣  Заполните:"
echo "   Name: DEPLOY_SSH_KEY"
echo "   Value: Ctrl+V (вставить из буфера)"
echo ""
echo "4️⃣  Нажмите 'Add secret'"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "5️⃣  Откройте GitHub Variables:"
echo "   https://github.com/Alex-Berezov/books/settings/variables/actions"
echo ""
echo "6️⃣  Добавьте две переменные:"
echo ""
echo "   Variable 1:"
echo "   Name: PRODUCTION_SERVER"
echo "   Value: bibliaris.com"
echo ""
echo "   Variable 2:"
echo "   Name: PRODUCTION_DOMAIN"
echo "   Value: bibliaris.com"
echo ""
echo -e "${GREEN}🚀 После настройки запустите workflow:${NC}"
echo "   https://github.com/Alex-Berezov/books/actions/workflows/deploy.yml"
echo ""
