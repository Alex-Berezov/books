#!/bin/bash

# Скрипт установки и настройки Caddy для продакшена
# Запускать от sudo на продакшн сервере

echo "🚀 Установка и настройка Caddy reverse proxy"
echo "============================================="

# Проверка что запущен от root/sudo
if [[ $EUID -ne 0 ]]; then
   echo "❌ Этот скрипт должен запускаться от sudo"
   exit 1
fi

# Шаг 1: Установка Caddy
echo "📦 Установка Caddy..."

# Добавить ключи и репозиторий Caddy
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list

# Обновить пакеты и установить Caddy
apt update
apt install -y caddy

# Шаг 2: Создать директории
echo "📁 Создание директорий..."
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# Шаг 3: Копирование конфигурации
echo "⚙️ Настройка конфигурации..."

# Проверить что конфигурационный файл существует
if [ ! -f "/opt/books/app/src/configs/Caddyfile.prod" ]; then
    echo "❌ Файл конфигурации не найден: /opt/books/app/src/configs/Caddyfile.prod"
    echo "   Скопируйте файл из репозитория в configs/Caddyfile.prod"
    exit 1
fi

# Копировать конфигурацию
cp /opt/books/app/src/configs/Caddyfile.prod /etc/caddy/Caddyfile

# Шаг 4: Настройка файрвола
echo "🔥 Настройка файрвола..."

# Установить ufw если не установлен
if ! command -v ufw &> /dev/null; then
    apt install -y ufw
fi

# Открыть порты HTTP и HTTPS
ufw allow 80/tcp
ufw allow 443/tcp

# Показать статус файрвола
echo "📋 Текущие правила файрвола:"
ufw status

# Шаг 5: Проверка конфигурации
echo "✅ Проверка конфигурации Caddy..."
caddy validate --config /etc/caddy/Caddyfile

if [ $? -ne 0 ]; then
    echo "❌ Ошибка в конфигурации Caddy!"
    exit 1
fi

# Шаг 6: Запуск сервисов
echo "🚀 Запуск Caddy..."

# Включить автозапуск
systemctl enable caddy

# Перезапустить с новой конфигурацией
systemctl restart caddy

# Проверить статус
sleep 2
systemctl status caddy --no-pager -l

echo ""
echo "✅ Установка Caddy завершена!"
echo ""
echo "🔍 Для проверки:"
echo "   systemctl status caddy"
echo "   journalctl -u caddy -f"
echo "   curl -I https://api.example.com/api/health/liveness"
echo ""
echo "📋 Логи Caddy:"
echo "   /var/log/caddy/api.log"
echo ""
echo "⚠️ Не забудьте:"
echo "   1. Настроить DNS A-запись api.example.com → IP сервера"
echo "   2. Обновить CORS_ORIGIN в .env.prod"
echo "   3. Обновить LOCAL_PUBLIC_BASE_URL в .env.prod"
