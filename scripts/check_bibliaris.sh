#!/bin/bash

# Скрипт проверки доступности bibliaris.com после настройки DNS и Caddy
# Можно запускать с локальной машины или сервера

set -euo pipefail

DOMAIN="bibliaris.com"
SERVER_IP="209.74.88.183"

echo "🔍 Проверка доступности $DOMAIN"
echo "================================"

# Функция логирования
log() {
    echo "$(date '+%H:%M:%S') [INFO] $*"
}

log_success() {
    echo "$(date '+%H:%M:%S') [✅] $*"
}

log_error() {
    echo "$(date '+%H:%M:%S') [❌] $*"
}

log_warning() {
    echo "$(date '+%H:%M:%S') [⚠️] $*"
}

# Проверка DNS
check_dns() {
    log "Проверка DNS записей..."
    
    # Проверка A-record
    dns_result=$(dig +short $DOMAIN A 2>/dev/null || echo "")
    
    if [[ "$dns_result" == "$SERVER_IP" ]]; then
        log_success "DNS A-record корректен: $DOMAIN → $SERVER_IP"
        return 0
    elif [[ -n "$dns_result" ]]; then
        log_error "DNS A-record неверен: $DOMAIN → $dns_result (ожидался $SERVER_IP)"
        return 1
    else
        log_error "DNS A-record не найден для $DOMAIN"
        return 1
    fi
}

# Проверка портов на сервере
check_ports() {
    log "Проверка портов на сервере $SERVER_IP..."
    
    # Проверка порта 80 (HTTP)
    if nc -z -w3 $SERVER_IP 80 2>/dev/null; then
        log_success "Порт 80 (HTTP) открыт"
    else
        log_error "Порт 80 (HTTP) недоступен"
        return 1
    fi
    
    # Проверка порта 443 (HTTPS)
    if nc -z -w3 $SERVER_IP 443 2>/dev/null; then
        log_success "Порт 443 (HTTPS) открыт"
    else
        log_error "Порт 443 (HTTPS) недоступен"
        return 1
    fi
    
    return 0
}

# Проверка HTTP доступности
check_http() {
    log "Проверка HTTP доступности..."
    
    # Проверка HTTP (должен перенаправлять на HTTPS)
    http_response=$(curl -s -o /dev/null -w "%{http_code}" -L http://$DOMAIN/api/health/liveness 2>/dev/null || echo "000")
    
    if [[ "$http_response" == "200" ]]; then
        log_success "HTTP доступность: $http_response"
    else
        log_warning "HTTP ответ: $http_response"
    fi
}

# Проверка HTTPS доступности
check_https() {
    log "Проверка HTTPS доступности..."
    
    # Проверка HTTPS health endpoint
    https_response=$(curl -s -o /dev/null -w "%{http_code}" https://$DOMAIN/api/health/liveness 2>/dev/null || echo "000")
    
    if [[ "$https_response" == "200" ]]; then
        log_success "HTTPS API работает: $https_response"
    else
        log_error "HTTPS API недоступен: $https_response"
        return 1
    fi
    
    # Проверка основной страницы
    main_response=$(curl -s -o /dev/null -w "%{http_code}" https://$DOMAIN/ 2>/dev/null || echo "000")
    log "Главная страница: $main_response"
    
    return 0
}

# Проверка SSL сертификата
check_ssl() {
    log "Проверка SSL сертификата..."
    
    # Получение информации о сертификате
    ssl_info=$(echo | openssl s_client -servername $DOMAIN -connect $DOMAIN:443 2>/dev/null | openssl x509 -noout -issuer -dates 2>/dev/null || echo "")
    
    if [[ -n "$ssl_info" ]]; then
        log_success "SSL сертификат найден:"
        echo "$ssl_info" | while IFS= read -r line; do
            echo "   $line"
        done
    else
        log_error "SSL сертификат недоступен"
        return 1
    fi
    
    return 0
}

# Проверка конкретных endpoints
check_endpoints() {
    log "Проверка API endpoints..."
    
    endpoints=(
        "/api/health/liveness"
        "/api/health/readiness"
    )
    
    for endpoint in "${endpoints[@]}"; do
        response=$(curl -s -o /dev/null -w "%{http_code}" https://$DOMAIN$endpoint 2>/dev/null || echo "000")
        if [[ "$response" == "200" ]]; then
            log_success "$endpoint: $response"
        else
            log_error "$endpoint: $response"
        fi
    done
}

# Проверка времени ответа
check_performance() {
    log "Проверка производительности..."
    
    response_time=$(curl -o /dev/null -s -w "%{time_total}s" https://$DOMAIN/api/health/liveness 2>/dev/null || echo "timeout")
    
    if [[ "$response_time" != "timeout" ]]; then
        log "Время ответа API: $response_time"
    else
        log_warning "Timeout при проверке времени ответа"
    fi
}

# Основная функция проверки
main() {
    local errors=0
    
    echo "🌐 Домен: $DOMAIN"
    echo "🖥️ Сервер: $SERVER_IP"
    echo "⏰ Время: $(date)"
    echo ""
    
    # Выполнение всех проверок
    check_dns || errors=$((errors + 1))
    echo ""
    
    check_ports || errors=$((errors + 1))
    echo ""
    
    check_http
    echo ""
    
    check_https || errors=$((errors + 1))
    echo ""
    
    check_ssl || errors=$((errors + 1))
    echo ""
    
    check_endpoints
    echo ""
    
    check_performance
    echo ""
    
    # Финальный результат
    if [[ $errors -eq 0 ]]; then
        log_success "Все проверки пройдены успешно! 🎉"
        echo ""
        echo "✅ bibliaris.com полностью функционален"
        echo "🔗 API доступен по адресу: https://bibliaris.com/"
    else
        log_error "Обнаружено $errors ошибок"
        echo ""
        echo "📋 Возможные причины:"
        echo "  - DNS изменения еще не вступили в силу (подождите до 48 часов)"
        echo "  - Caddy не запущен на сервере"
        echo "  - Firewall блокирует порты 80/443"
        echo "  - Приложение не работает на localhost:5000"
        echo ""
        echo "🔍 Для диагностики на сервере:"
        echo "  systemctl status caddy"
        echo "  journalctl -u caddy -n 20"
        echo "  curl -I http://localhost:5000/api/health/liveness"
        
        return 1
    fi
}

# Проверка зависимостей
check_dependencies() {
    local missing_deps=()
    
    for cmd in dig curl nc openssl; do
        if ! command -v $cmd &> /dev/null; then
            missing_deps+=($cmd)
        fi
    done
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Не найдены необходимые утилиты: ${missing_deps[*]}"
        log "Установите их командой: sudo apt install dnsutils curl netcat-openbsd openssl"
        exit 1
    fi
}

# Запуск
check_dependencies
main "$@"
