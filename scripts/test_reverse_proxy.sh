#!/bin/bash

# Скрипт проверки работы reverse proxy
# Запускать на продакшн сервере после установки Caddy

echo "🧪 Проверка работы Reverse Proxy"
echo "================================="

DOMAIN=${1:-"api.example.com"}
echo "🌐 Тестируемый домен: $DOMAIN"
echo ""

# Функция для проверки HTTP ответа
check_endpoint() {
    local url=$1
    local expected_code=${2:-200}
    local description=$3
    
    echo -n "🔍 $description: "
    
    response=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$url" 2>/dev/null)
    
    if [ "$response" = "$expected_code" ]; then
        echo "✅ $response"
        return 0
    else
        echo "❌ $response (ожидался $expected_code)"
        return 1
    fi
}

# Функция для проверки перенаправления
check_redirect() {
    local url=$1
    local expected_location=$2
    local description=$3
    
    echo -n "🔀 $description: "
    
    location=$(curl -s -I -m 10 "$url" | grep -i "location:" | awk '{print $2}' | tr -d '\r\n')
    
    if [[ "$location" == *"$expected_location"* ]]; then
        echo "✅ $location"
        return 0
    else
        echo "❌ $location (ожидался $expected_location)"
        return 1
    fi
}

echo "📋 Проверка основных эндпоинтов:"
echo "--------------------------------"

# Проверка HTTPS перенаправления
check_redirect "http://$DOMAIN" "https://$DOMAIN" "HTTP → HTTPS редирект"

# Проверка основных эндпоинтов
check_endpoint "https://$DOMAIN/api/health/liveness" 200 "Health Liveness"
check_endpoint "https://$DOMAIN/api/health/readiness" 200 "Health Readiness"

# Проверка что metrics заблокированы
check_endpoint "https://$DOMAIN/api/metrics" 403 "Metrics (должен быть заблокирован)"

# Проверка что Swagger отключен в проде
check_endpoint "https://$DOMAIN/api/docs" 404 "Swagger Docs (должен быть недоступен)"

# Проверка корневого редиректа
check_redirect "https://$DOMAIN/" "https://$DOMAIN/api/docs" "Корневой редирект"

# Проверка www редиректа
check_redirect "http://www.$DOMAIN" "https://$DOMAIN" "WWW редирект"

echo ""
echo "🔒 Проверка заголовков безопасности:"
echo "------------------------------------"

# Проверка заголовков безопасности
headers_check() {
    local header=$1
    local description=$2
    
    echo -n "🛡️  $description: "
    
    header_value=$(curl -s -I -m 10 "https://$DOMAIN/api/health/liveness" | grep -i "$header" | awk -F': ' '{print $2}' | tr -d '\r\n')
    
    if [ -n "$header_value" ]; then
        echo "✅ $header_value"
    else
        echo "❌ Отсутствует"
    fi
}

headers_check "X-Content-Type-Options" "X-Content-Type-Options"
headers_check "X-Frame-Options" "X-Frame-Options"
headers_check "Strict-Transport-Security" "HSTS"

echo ""
echo "📊 Проверка SSL сертификата:"
echo "-----------------------------"

# Проверка SSL сертификата
echo -n "🔐 SSL сертификат: "
ssl_info=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -issuer -dates 2>/dev/null)

if [ $? -eq 0 ]; then
    echo "✅ Действителен"
    echo "   $(echo "$ssl_info" | grep "issuer")"
    echo "   $(echo "$ssl_info" | grep "notAfter")"
else
    echo "❌ Проблема с сертификатом"
fi

echo ""
echo "🎯 Проверка производительности:"
echo "-------------------------------"

# Проверка времени ответа
echo -n "⚡ Время ответа API: "
response_time=$(curl -o /dev/null -s -w "%{time_total}s" "https://$DOMAIN/api/health/liveness")
echo "$response_time"

echo ""
echo "📝 Логи Caddy (последние 10 строк):"
echo "------------------------------------"

if [ -f "/var/log/caddy/api.log" ]; then
    tail -n 10 /var/log/caddy/api.log
else
    echo "❌ Файл логов не найден: /var/log/caddy/api.log"
fi

echo ""
echo "🔍 Статус сервиса Caddy:"
echo "------------------------"
systemctl status caddy --no-pager -l | head -n 10

echo ""
echo "✅ Проверка завершена!"
echo "Если все тесты прошли успешно - reverse proxy настроен корректно."
