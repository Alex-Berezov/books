#!/bin/bash

# Скрипт настройки Caddy для домена bibliaris.com
# Выполняется на production сервере 209.74.88.183

set -euo pipefail

echo "🌐 Настройка Caddy для bibliaris.com"
echo "===================================="

# Проверка прав root/sudo
if [[ $EUID -ne 0 ]]; then
   echo "❌ Скрипт должен запускаться с правами sudo"
   exit 1
fi

# Функция логирования
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] $*"
}

log_error() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [ERROR] $*" >&2
}

# Проверка что приложение работает
check_app() {
    log "Проверка работы приложения..."
    
    if curl -sf http://localhost:5000/api/health/liveness > /dev/null; then
        log "✅ Приложение работает на порту 5000"
    else
        log_error "❌ Приложение не отвечает на localhost:5000"
        log_error "Запустите приложение перед установкой Caddy"
        exit 1
    fi
}

# Установка Caddy
install_caddy() {
    log "Проверка установки Caddy..."
    
    if command -v caddy &> /dev/null; then
        log "✅ Caddy уже установлен ($(caddy version))"
        return 0
    fi
    
    log "📦 Установка Caddy..."
    
    # Установка зависимостей
    apt update
    apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    
    # Добавление репозитория Caddy
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    
    # Установка Caddy
    apt update
    apt install -y caddy
    
    log "✅ Caddy установлен: $(caddy version)"
}

# Настройка Caddyfile
setup_caddyfile() {
    log "⚙️ Настройка Caddyfile..."
    
    # Создание директории для логов
    mkdir -p /var/log/caddy
    chown caddy:caddy /var/log/caddy
    
    # Создание Caddyfile
    cat > /etc/caddy/Caddyfile << 'EOF'
bibliaris.com {
    reverse_proxy localhost:5000

    # Заголовки безопасности
    header {
        # Скрыть информацию о сервере
        -Server

        # Security headers
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # Логирование
    log {
        output file /var/log/caddy/bibliaris.com.log
        format json
    }
}

# Редирект с www
www.bibliaris.com {
    redir https://bibliaris.com{uri} permanent
}
EOF
    
    log "✅ Caddyfile создан"
}

# Настройка firewall
setup_firewall() {
    log "🔥 Настройка firewall..."
    
    # Установка UFW если не установлен
    if ! command -v ufw &> /dev/null; then
        apt install -y ufw
    fi
    
    # Открытие портов для HTTP/HTTPS
    ufw allow 80/tcp
    ufw allow 443/tcp
    
    log "✅ Порты 80/443 открыты"
}

# Проверка конфигурации и запуск
start_caddy() {
    log "🔧 Проверка конфигурации Caddy..."
    
    if caddy validate --config /etc/caddy/Caddyfile; then
        log "✅ Конфигурация валидна"
    else
        log_error "❌ Ошибка в конфигурации Caddy"
        exit 1
    fi
    
    log "🚀 Запуск Caddy..."
    
    # Включение и запуск сервиса
    systemctl enable caddy
    systemctl restart caddy
    
    # Проверка статуса
    if systemctl is-active --quiet caddy; then
        log "✅ Caddy запущен успешно"
    else
        log_error "❌ Ошибка запуска Caddy"
        systemctl status caddy
        exit 1
    fi
}

# Финальная проверка
final_check() {
    log "🧪 Финальная проверка..."
    
    sleep 5  # Дать время на запуск
    
    # Проверка портов
    if ss -tlnp | grep -q ":80 "; then
        log "✅ Caddy слушает порт 80"
    else
        log_error "❌ Порт 80 не слушается"
    fi
    
    if ss -tlnp | grep -q ":443 "; then
        log "✅ Caddy слушает порт 443"
    else
        log_error "❌ Порт 443 не слушается"
    fi
    
    # Показать логи
    log "📋 Последние логи Caddy:"
    journalctl -u caddy --no-pager -n 5
}

# Основная логика
main() {
    log "Начало настройки Caddy для bibliaris.com"
    
    check_app
    install_caddy
    setup_caddyfile
    setup_firewall
    start_caddy
    final_check
    
    echo ""
    echo "🎉 Caddy успешно настроен для bibliaris.com!"
    echo ""
    echo "📋 Следующие шаги:"
    echo "1. Настройте DNS A-record: bibliaris.com → 209.74.88.183"
    echo "2. Удалите URL Forward в Namecheap"
    echo "3. Дождитесь DNS propagation (до 48 часов)"
    echo "4. Проверьте доступность: https://bibliaris.com"
    echo ""
    echo "🔍 Для проверки статуса:"
    echo "  systemctl status caddy"
    echo "  journalctl -u caddy -f"
    echo "  curl -I https://bibliaris.com/api/health/liveness"
}

# Запуск
main "$@"
