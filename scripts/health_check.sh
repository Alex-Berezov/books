#!/bin/bash

# Pre-Deployment Health Check Script
# ==================================
# Комплексная проверка готовности к production деплою
#
# Использование:
#   ./scripts/health_check.sh [OPTIONS]
#
# Опции:
#   --url URL          URL для проверки (по умолчанию: http://localhost:5000)
#   --timeout SECONDS  Таймаут для HTTP запросов (по умолчанию: 10)
#   --detailed         Подробный вывод результатов
#   --format FORMAT    Формат вывода: text, json (по умолчанию: text)
#   --save FILE        Сохранить результат в файл
#   -h, --help         Показать справку

set -euo pipefail

# Цветовая схема
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m'

# Переменные по умолчанию
BASE_URL="http://localhost:5000"
TIMEOUT=10
DETAILED=false
FORMAT="text"
SAVE_FILE=""

# Результаты проверок
declare -A RESULTS
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNING_CHECKS=0

# Показать справку
show_help() {
    cat << EOF
Pre-Deployment Health Check Script
==================================

Комплексная проверка готовности Books App к production деплою.

ИСПОЛЬЗОВАНИЕ:
    ./scripts/health_check.sh [OPTIONS]

ОПЦИИ:
    --url URL          URL для проверки (по умолчанию: http://localhost:5000)
    --timeout SECONDS  Таймаут для HTTP запросов (по умолчанию: 10)
    --detailed         Подробный вывод результатов
    --format FORMAT    Формат вывода: text, json (по умолчанию: text)
    --save FILE        Сохранить результат в файл
    -h, --help         Показать эту справку

ПРИМЕРЫ:
    # Локальная проверка
    ./scripts/health_check.sh
    
    # Проверка production сервера
    ./scripts/health_check.sh --url https://api.example.com
    
    # Детальная проверка с сохранением в JSON
    ./scripts/health_check.sh --detailed --format json --save health_report.json

ПРОВЕРКИ:
    ✓ API Health Endpoints
    ✓ Database Connection
    ✓ Configuration Validation  
    ✓ Security Headers
    ✓ Performance Metrics
    ✓ Docker Container Status
    ✓ SSL Certificate (если HTTPS)

EOF
}

# Парсинг аргументов
while [[ $# -gt 0 ]]; do
    case $1 in
        --url)
            BASE_URL="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --detailed)
            DETAILED=true
            shift
            ;;
        --format)
            FORMAT="$2"
            shift 2
            ;;
        --save)
            SAVE_FILE="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Неизвестный параметр: $1"
            echo "Используйте --help для справки"
            exit 1
            ;;
    esac
done

# Логирование
log() {
    if [[ "$FORMAT" == "text" ]]; then
        echo -e "${BLUE}[$(date +'%H:%M:%S')] $1${NC}"
    fi
}

log_success() {
    if [[ "$FORMAT" == "text" ]]; then
        echo -e "${GREEN}✅ $1${NC}"
    fi
}

log_warning() {
    if [[ "$FORMAT" == "text" ]]; then
        echo -e "${YELLOW}⚠️  $1${NC}"
    fi
}

log_error() {
    if [[ "$FORMAT" == "text" ]]; then
        echo -e "${RED}❌ $1${NC}"
    fi
}

log_info() {
    if [[ "$FORMAT" == "text" ]]; then
        echo -e "${CYAN}ℹ️  $1${NC}"
    fi
}

# HTTP запрос с таймаутом
http_request() {
    local url=$1
    local expected_status=${2:-200}
    
    local response=$(curl -s -w "\n%{http_code}\n%{time_total}" \
        --max-time "$TIMEOUT" \
        --connect-timeout "$TIMEOUT" \
        -H "Accept: application/json" \
        "$url" 2>/dev/null || echo -e "\nERROR\n0")
    
    local body=$(echo "$response" | head -n -2)
    local status=$(echo "$response" | tail -n 2 | head -n 1)
    local time=$(echo "$response" | tail -n 1)
    
    echo "$body|$status|$time"
}

# Добавить результат проверки
add_result() {
    local check_name=$1
    local status=$2  # PASS, FAIL, WARNING
    local message=$3
    local details=${4:-""}
    
    RESULTS["$check_name"]="$status|$message|$details"
    ((TOTAL_CHECKS++))
    
    case $status in
        PASS) ((PASSED_CHECKS++)) ;;
        FAIL) ((FAILED_CHECKS++)) ;;
        WARNING) ((WARNING_CHECKS++)) ;;
    esac
    
    case $status in
        PASS) log_success "$check_name: $message" ;;
        FAIL) log_error "$check_name: $message" ;;
        WARNING) log_warning "$check_name: $message" ;;
    esac
    
    if [[ "$DETAILED" == true && -n "$details" ]]; then
        log_info "  $details"
    fi
}

# 1. Проверка API Health Endpoints
check_api_health() {
    log "Проверка API Health endpoints..."
    
    # Liveness probe
    local liveness=$(http_request "$BASE_URL/api/health/liveness")
    local liveness_body=$(echo "$liveness" | cut -d'|' -f1)
    local liveness_status=$(echo "$liveness" | cut -d'|' -f2)
    local liveness_time=$(echo "$liveness" | cut -d'|' -f3)
    
    if [[ "$liveness_status" == "200" ]]; then
        local version=$(echo "$liveness_body" | jq -r '.version // "unknown"' 2>/dev/null || echo "unknown")
        add_result "liveness" "PASS" "Сервис доступен (${liveness_time}s)" "Version: $version"
    else
        add_result "liveness" "FAIL" "Сервис недоступен (HTTP $liveness_status)"
        return 1
    fi
    
    # Readiness probe  
    local readiness=$(http_request "$BASE_URL/api/health/readiness")
    local readiness_status=$(echo "$readiness" | cut -d'|' -f2)
    local readiness_time=$(echo "$readiness" | cut -d'|' -f3)
    
    if [[ "$readiness_status" == "200" ]]; then
        add_result "readiness" "PASS" "Сервис готов к работе (${readiness_time}s)"
    else
        add_result "readiness" "FAIL" "Сервис не готов (HTTP $readiness_status)"
    fi
}

# 2. Проверка базы данных
check_database() {
    log "Проверка подключения к базе данных..."
    
    local readiness=$(http_request "$BASE_URL/api/health/readiness")
    local readiness_body=$(echo "$readiness" | cut -d'|' -f1)
    local readiness_status=$(echo "$readiness" | cut -d'|' -f2)
    
    if [[ "$readiness_status" == "200" ]]; then
        local db_status=$(echo "$readiness_body" | jq -r '.database // "unknown"' 2>/dev/null || echo "unknown")
        if [[ "$db_status" == "connected" ]] || [[ "$db_status" == "healthy" ]]; then
            add_result "database" "PASS" "База данных подключена"
        else
            add_result "database" "WARNING" "Статус БД неопределен: $db_status"
        fi
    else
        add_result "database" "FAIL" "Не удалось проверить статус БД"
    fi
}

# 3. Проверка конфигурации безопасности
check_security_config() {
    log "Проверка настроек безопасности..."
    
    # Проверка что Swagger отключен в production
    local swagger=$(http_request "$BASE_URL/api/docs" "404")
    local swagger_status=$(echo "$swagger" | cut -d'|' -f2)
    
    if [[ "$swagger_status" == "404" ]]; then
        add_result "swagger" "PASS" "Swagger отключен в production"
    else
        add_result "swagger" "WARNING" "Swagger доступен (HTTP $swagger_status) - не рекомендуется для production"
    fi
    
    # Проверка метрик (должны быть доступны только локально в production)
    local metrics=$(http_request "$BASE_URL/api/metrics")
    local metrics_status=$(echo "$metrics" | cut -d'|' -f2)
    
    if [[ "$BASE_URL" =~ ^https?://localhost ]] || [[ "$BASE_URL" =~ ^http://127\.0\.0\.1 ]]; then
        if [[ "$metrics_status" == "200" ]]; then
            add_result "metrics" "PASS" "Метрики доступны локально"
        else
            add_result "metrics" "FAIL" "Метрики недоступны (HTTP $metrics_status)"
        fi
    else
        if [[ "$metrics_status" == "403" ]] || [[ "$metrics_status" == "404" ]]; then
            add_result "metrics" "PASS" "Метрики защищены от внешнего доступа"
        else
            add_result "metrics" "WARNING" "Метрики могут быть доступны извне (HTTP $metrics_status)"
        fi
    fi
}

# 4. Проверка заголовков безопасности
check_security_headers() {
    log "Проверка заголовков безопасности..."
    
    local headers=$(curl -s -I "$BASE_URL/api/health/liveness" --max-time "$TIMEOUT" 2>/dev/null || echo "")
    
    local required_headers=(
        "X-Content-Type-Options"
        "X-Frame-Options" 
        "X-XSS-Protection"
    )
    
    local found_headers=0
    for header in "${required_headers[@]}"; do
        if echo "$headers" | grep -qi "$header:"; then
            ((found_headers++))
        fi
    done
    
    if [[ $found_headers -eq ${#required_headers[@]} ]]; then
        add_result "security_headers" "PASS" "Все заголовки безопасности присутствуют"
    elif [[ $found_headers -gt 0 ]]; then
        add_result "security_headers" "WARNING" "Найдено $found_headers/${#required_headers[@]} заголовков безопасности"
    else
        add_result "security_headers" "FAIL" "Заголовки безопасности отсутствуют"
    fi
}

# 5. Проверка производительности
check_performance() {
    log "Проверка производительности..."
    
    local liveness=$(http_request "$BASE_URL/api/health/liveness")
    local response_time=$(echo "$liveness" | cut -d'|' -f3)
    
    if (( $(echo "$response_time < 1.0" | bc -l) )); then
        add_result "response_time" "PASS" "Время отклика: ${response_time}s (отлично)"
    elif (( $(echo "$response_time < 2.0" | bc -l) )); then
        add_result "response_time" "WARNING" "Время отклика: ${response_time}s (приемлемо)"
    else
        add_result "response_time" "FAIL" "Время отклика: ${response_time}s (медленно)"
    fi
}

# 6. Проверка SSL сертификата (если HTTPS)
check_ssl_certificate() {
    if [[ "$BASE_URL" =~ ^https:// ]]; then
        log "Проверка SSL сертификата..."
        
        local domain=$(echo "$BASE_URL" | sed 's|https://||' | sed 's|/.*||')
        local ssl_info=$(echo | openssl s_client -connect "$domain:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -dates 2>/dev/null || echo "")
        
        if [[ -n "$ssl_info" ]]; then
            local not_after=$(echo "$ssl_info" | grep "notAfter=" | cut -d= -f2)
            local expiry_date=$(date -d "$not_after" +%s 2>/dev/null || echo "0")
            local current_date=$(date +%s)
            local days_left=$(( (expiry_date - current_date) / 86400 ))
            
            if [[ $days_left -gt 30 ]]; then
                add_result "ssl_certificate" "PASS" "SSL сертификат действителен ($days_left дней до истечения)"
            elif [[ $days_left -gt 7 ]]; then
                add_result "ssl_certificate" "WARNING" "SSL сертификат истекает через $days_left дней"
            else
                add_result "ssl_certificate" "FAIL" "SSL сертификат истекает через $days_left дней"
            fi
        else
            add_result "ssl_certificate" "FAIL" "Не удалось получить информацию о SSL сертификате"
        fi
    else
        add_result "ssl_certificate" "WARNING" "HTTP соединение - SSL не используется"
    fi
}

# 7. Проверка Docker контейнеров (если доступен)
check_docker_status() {
    if command -v docker &> /dev/null && [[ "$BASE_URL" =~ ^https?://localhost ]] || [[ "$BASE_URL" =~ ^http://127\.0\.0\.1 ]]; then
        log "Проверка Docker контейнеров..."
        
        if [[ -f "docker-compose.prod.yml" ]]; then
            local containers=$(docker compose -f docker-compose.prod.yml ps --format json 2>/dev/null || echo "[]")
            local running_containers=$(echo "$containers" | jq '[.[] | select(.State == "running")] | length' 2>/dev/null || echo "0")
            local total_containers=$(echo "$containers" | jq 'length' 2>/dev/null || echo "0")
            
            if [[ $running_containers -eq $total_containers && $total_containers -gt 0 ]]; then
                add_result "docker_containers" "PASS" "Все контейнеры запущены ($running_containers/$total_containers)"
            elif [[ $running_containers -gt 0 ]]; then
                add_result "docker_containers" "WARNING" "Частично запущено контейнеров ($running_containers/$total_containers)"
            else
                add_result "docker_containers" "FAIL" "Контейнеры не запущены"
            fi
        else
            add_result "docker_containers" "WARNING" "docker-compose.prod.yml не найден"
        fi
    else
        add_result "docker_containers" "WARNING" "Docker недоступен или удаленная проверка"
    fi
}

# 8. Проверка API функциональности
check_api_functionality() {
    log "Проверка функциональности API..."
    
    # Проверка публичного эндпоинта (если есть)
    local books=$(http_request "$BASE_URL/api/books?limit=1")
    local books_status=$(echo "$books" | cut -d'|' -f2)
    
    if [[ "$books_status" == "200" ]]; then
        add_result "api_books" "PASS" "API книг доступен"
    else
        add_result "api_books" "WARNING" "API книг недоступен (HTTP $books_status)"
    fi
    
    # Проверка CORS заголовков
    local cors_headers=$(curl -s -I -H "Origin: https://example.com" "$BASE_URL/api/health/liveness" --max-time "$TIMEOUT" 2>/dev/null || echo "")
    if echo "$cors_headers" | grep -qi "access-control-allow-origin"; then
        add_result "cors" "PASS" "CORS заголовки настроены"
    else
        add_result "cors" "WARNING" "CORS заголовки не обнаружены"
    fi
}

# Генерация отчета в JSON
generate_json_report() {
    local json_results="{"
    json_results+='"timestamp":"'$(date -Iseconds)'",'
    json_results+='"base_url":"'$BASE_URL'",'
    json_results+='"total_checks":'$TOTAL_CHECKS','
    json_results+='"passed":'$PASSED_CHECKS','
    json_results+='"failed":'$FAILED_CHECKS','
    json_results+='"warnings":'$WARNING_CHECKS','
    json_results+='"success_rate":'$(echo "scale=2; $PASSED_CHECKS * 100 / $TOTAL_CHECKS" | bc)'%,'
    json_results+='"checks":{'
    
    local first=true
    for check_name in "${!RESULTS[@]}"; do
        [[ "$first" == false ]] && json_results+=","
        
        local result_data="${RESULTS[$check_name]}"
        local status=$(echo "$result_data" | cut -d'|' -f1)
        local message=$(echo "$result_data" | cut -d'|' -f2)
        local details=$(echo "$result_data" | cut -d'|' -f3)
        
        json_results+='"'$check_name'":{'
        json_results+='"status":"'$status'",'
        json_results+='"message":"'$message'"'
        [[ -n "$details" ]] && json_results+=',"details":"'$details'"'
        json_results+='}'
        
        first=false
    done
    
    json_results+='}}'
    echo "$json_results"
}

# Генерация отчета в текстовом формате
generate_text_report() {
    echo ""
    echo "========================================"
    echo "📊 ИТОГОВЫЙ ОТЧЕТ ПРОВЕРКИ ГОТОВНОСТИ"
    echo "========================================"
    echo "URL: $BASE_URL"
    echo "Время: $(date)"
    echo ""
    echo "📈 СТАТИСТИКА:"
    echo "  Всего проверок: $TOTAL_CHECKS"
    echo "  Пройдено: $PASSED_CHECKS"
    echo "  Предупреждения: $WARNING_CHECKS" 
    echo "  Неудач: $FAILED_CHECKS"
    echo "  Успешность: $(echo "scale=1; $PASSED_CHECKS * 100 / $TOTAL_CHECKS" | bc)%"
    echo ""
    
    if [[ $FAILED_CHECKS -eq 0 && $WARNING_CHECKS -eq 0 ]]; then
        echo -e "${GREEN}🎉 ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ - ГОТОВ К ДЕПЛОЮ!${NC}"
    elif [[ $FAILED_CHECKS -eq 0 ]]; then
        echo -e "${YELLOW}⚠️  Есть предупреждения, но можно деплоить${NC}"
    else
        echo -e "${RED}❌ Есть критические проблемы - деплой НЕ РЕКОМЕНДУЕТСЯ${NC}"
    fi
    echo ""
    
    if [[ "$DETAILED" == true ]]; then
        echo "🔍 ДЕТАЛЬНЫЕ РЕЗУЛЬТАТЫ:"
        for check_name in "${!RESULTS[@]}"; do
            local result_data="${RESULTS[$check_name]}"
            local status=$(echo "$result_data" | cut -d'|' -f1)
            local message=$(echo "$result_data" | cut -d'|' -f2)
            local details=$(echo "$result_data" | cut -d'|' -f3)
            
            case $status in
                PASS) echo -e "  ${GREEN}✅${NC} $check_name: $message" ;;
                FAIL) echo -e "  ${RED}❌${NC} $check_name: $message" ;;
                WARNING) echo -e "  ${YELLOW}⚠️${NC} $check_name: $message" ;;
            esac
            
            [[ -n "$details" ]] && echo -e "     ${GRAY}$details${NC}"
        done
    fi
}

# Основная функция
main() {
    if [[ "$FORMAT" == "text" ]]; then
        echo -e "${PURPLE}"
        echo "========================================"
        echo "🏥 Books App Pre-Deployment Health Check"
        echo "========================================"
        echo -e "${NC}"
        echo "URL: $BASE_URL"
        echo "Timeout: ${TIMEOUT}s"
        echo ""
    fi
    
    # Выполнение проверок
    check_api_health
    check_database  
    check_security_config
    check_security_headers
    check_performance
    check_ssl_certificate
    check_docker_status
    check_api_functionality
    
    # Генерация отчета
    local report=""
    if [[ "$FORMAT" == "json" ]]; then
        report=$(generate_json_report)
    else
        report=$(generate_text_report)
    fi
    
    # Вывод или сохранение
    if [[ -n "$SAVE_FILE" ]]; then
        echo "$report" > "$SAVE_FILE"
        [[ "$FORMAT" == "text" ]] && echo "📁 Отчет сохранен: $SAVE_FILE"
    else
        echo "$report"
    fi
    
    # Код возврата
    if [[ $FAILED_CHECKS -eq 0 ]]; then
        exit 0
    else
        exit 1
    fi
}

# Обработка ошибок
trap 'echo "❌ Ошибка в строке $LINENO"' ERR

# Проверка зависимостей
for cmd in curl jq bc; do
    if ! command -v $cmd &> /dev/null; then
        echo "❌ Требуется команда: $cmd"
        exit 1
    fi
done

# Запуск
main "$@"
