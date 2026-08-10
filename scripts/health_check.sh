#!/bin/bash

# Pre-Deployment Health Check Script
# ==================================
# Comprehensive readiness verification before production deployment
#
# Usage:
#   ./scripts/health_check.sh [OPTIONS]
#
# Options:
#   --url URL          URL to check (default: http://localhost:5000)
#   --timeout SECONDS  Timeout for HTTP requests (default: 10)
#   --detailed         Show detailed results
#   --format FORMAT    Output format: text, json (default: text)
#   --save FILE        Save result to file
#   -h, --help         Show help

set -euo pipefail

# Color palette
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m'

# Default variables
BASE_URL="http://localhost:5000"
TIMEOUT=10
DETAILED=false
FORMAT="text"
SAVE_FILE=""

# Check results tracking
declare -A RESULTS
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNING_CHECKS=0

# Результат последнего http_request
HTTP_BODY=""
HTTP_STATUS=""
HTTP_TIME=""

# Show help
show_help() {
    cat << EOF
Pre-Deployment Health Check Script
==================================

Comprehensive readiness verification of Books App before production deployment.

USAGE:
    ./scripts/health_check.sh [OPTIONS]

OPTIONS:
    --url URL          URL to check (default: http://localhost:5000)
    --timeout SECONDS  Timeout for HTTP requests (default: 10)
    --detailed         Show detailed results
    --format FORMAT    Output format: text, json (default: text)
    --save FILE        Save result to file
    -h, --help         Show this help

EXAMPLES:
    # Local check
    ./scripts/health_check.sh
    
    # Check production server
    ./scripts/health_check.sh --url https://api.example.com
    
    # Detailed check saving JSON
    ./scripts/health_check.sh --detailed --format json --save health_report.json

EXIT CODES:
    0   all checks passed
    2   warnings present (nothing failed, but something could not be verified)
    1   at least one check failed

    Прежде код 2 не существовал и предупреждения давали 0 — отчёт с десятком
    WARNING был неотличим от чистого прогона.

CHECKS:
    ✓ API Health Endpoints
    ✓ Database Connection
    ✓ Configuration Validation  
    ✓ Security Headers
    ✓ Performance Metrics
    ✓ Docker Container Status
    ✓ SSL Certificate (if HTTPS)

EOF
}

# Argument parsing
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
            echo "Unknown parameter: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Logging helpers
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

# HTTP request with timeout
#
# 🔴 Функция возвращала строку `"$body|$status|$time"`, а вызывающие разбирали
# её через `cut -d'|'`. Тело ответа — произвольный JSON, и первая же вертикальная
# черта внутри SEO-текста книги сдвигала все поля: проверка каталога получала
# «статус», начинающийся с куска описания, и объявляла отказ на живом маршруте.
# Разделитель, который может встретиться в данных, — не разделитель.
#
# Результат отдаётся глобальными переменными: подстановка команды всё равно
# съедает завершающие переводы строк, а уместить многострочное тело в одну
# строку без потерь нечем.
http_request() {
    local url=$1
    local expected_status=${2:-200}
    
    local response=$(curl -s -w "\n%{http_code}\n%{time_total}" \
        --max-time "$TIMEOUT" \
        --connect-timeout "$TIMEOUT" \
        -H "Accept: application/json" \
        "$url" 2>/dev/null || echo -e "\nERROR\n0")
    
    HTTP_BODY=$(echo "$response" | head -n -2)
    HTTP_STATUS=$(echo "$response" | tail -n 2 | head -n 1)
    HTTP_TIME=$(echo "$response" | tail -n 1)
}

# Add a check result
add_result() {
    local check_name=$1
    local status=$2  # PASS, FAIL, WARNING
    local message=$3
    local details=${4:-""}
    
    RESULTS["$check_name"]="$status|$message|$details"

    # 🔴 Здесь стояло `((TOTAL_CHECKS++))`. Постфиксный инкремент возвращает
    # **старое** значение, то есть 0 на первом вызове, а при `set -e` нулевой
    # результат арифметики — это неуспех команды: скрипт молча умирал на самой
    # первой проверке. Всё, что написано ниже по файлу, никогда не выполнялось.
    #
    # ⚠️ Тот же баг уже дважды чинили рядом — в `deploy_production.sh` и в
    # деплойном workflow, и оба раза оставили комментарий. Сюда не заглянули,
    # потому что скрипт никто не запускал: он и не мог отработать.
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

    case $status in
        PASS) PASSED_CHECKS=$((PASSED_CHECKS + 1)) ;;
        FAIL) FAILED_CHECKS=$((FAILED_CHECKS + 1)) ;;
        WARNING) WARNING_CHECKS=$((WARNING_CHECKS + 1)) ;;
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

# 1. API Health Endpoints check
check_api_health() {
    log "Checking API Health endpoints..."
    
    # Liveness probe
    http_request "$BASE_URL/api/health/liveness"
    local liveness_body="$HTTP_BODY"
    local liveness_status="$HTTP_STATUS"
    local liveness_time="$HTTP_TIME"
    
    if [[ "$liveness_status" == "200" ]]; then
        local version=$(echo "$liveness_body" | jq -r '.version // "unknown"' 2>/dev/null || echo "unknown")
    add_result "liveness" "PASS" "Service available (${liveness_time}s)" "Version: $version"
    else
    add_result "liveness" "FAIL" "Service unavailable (HTTP $liveness_status)"
        return 1
    fi
    
    # Readiness probe
    http_request "$BASE_URL/api/health/readiness"
    local readiness_status="$HTTP_STATUS"
    local readiness_time="$HTTP_TIME"
    
    # ⚠️ Кода 200 мало: маршрут отвечает JSON со `status`, и «ответил» не значит
    # «готов». Деплойный шаг в .github/workflows/deploy.yml ждёт `status: up` —
    # проба обязана спрашивать то же самое.
    local readiness_body="$HTTP_BODY"
    local readiness_state=$(echo "$readiness_body" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")

    if [[ "$readiness_status" == "200" && "$readiness_state" == "up" ]]; then
    add_result "readiness" "PASS" "Service ready (${readiness_time}s)"
    else
    add_result "readiness" "FAIL" "Service not ready (HTTP $readiness_status, status=$readiness_state)"
    fi
}

# 2. Database connectivity check
check_database() {
    log "Checking database connection..."
    
    http_request "$BASE_URL/api/health/readiness"
    local readiness_body="$HTTP_BODY"
    local readiness_status="$HTTP_STATUS"
    
    if [[ "$readiness_status" == "200" ]]; then
        # 🔴 Читалось поле `.database`, которого в ответе нет и, судя по всему,
        # никогда не было: readiness отдаёт `{"status":"up","details":{"prisma":…}}`.
        # Проверка базы поэтому **всегда** заканчивалась «indeterminate» —
        # то есть ни разу не подтвердила то, ради чего написана. Заметить это
        # было нечем: WARNING не влиял на код выхода.
        local db_status=$(echo "$readiness_body" | jq -r '.details.prisma // "unknown"' 2>/dev/null || echo "unknown")
        if [[ "$db_status" == "up" ]]; then
            add_result "database" "PASS" "Database connected"
        else
            add_result "database" "FAIL" "Database not reporting up: $db_status"
        fi
    else
    add_result "database" "FAIL" "Failed to check database status"
    fi
}

# 3. Security configuration check
check_security_config() {
    log "Checking security configuration..."
    
    # Verify Swagger is disabled in production
    http_request "$BASE_URL/api/docs"
    local swagger_status="$HTTP_STATUS"
    
    if [[ "$swagger_status" == "404" ]]; then
    add_result "swagger" "PASS" "Swagger disabled in production"
    else
    add_result "swagger" "WARNING" "Swagger accessible (HTTP $swagger_status) - not recommended for production"
    fi
    
    # Metrics endpoint. LEGACY-072: с 08.08.2026 маршрут закрыт гвардом
    # `admin`, поэтому анонимный ответ — 401 в любой среде, включая localhost.
    # Прежняя ветка ждала на localhost 200 и объявляла PASS ровно тому состоянию,
    # которое теперь считается дефектом. 403 остаётся допустимым, пока снаружи
    # стоит блок Caddy; 200 — всегда провал: значит гвард не применился.
    http_request "$BASE_URL/api/metrics"
    local metrics_status="$HTTP_STATUS"

    if [[ "$metrics_status" == "401" ]]; then
        add_result "metrics" "PASS" "Metrics require authentication"
    elif [[ "$metrics_status" == "403" ]] || [[ "$metrics_status" == "404" ]]; then
        add_result "metrics" "PASS" "Metrics blocked before the application (HTTP $metrics_status)"
    elif [[ "$metrics_status" == "200" ]]; then
        add_result "metrics" "FAIL" "Metrics served anonymously — the admin guard is not in effect"
    else
        add_result "metrics" "WARNING" "Unexpected metrics response (HTTP $metrics_status)"
    fi
}

# 4. Security headers check
check_security_headers() {
    log "Checking security headers..."
    
    local headers=$(curl -s -I "$BASE_URL/api/health/liveness" --max-time "$TIMEOUT" 2>/dev/null || echo "")
    
    local required_headers=(
        "X-Content-Type-Options"
        "X-Frame-Options" 
        "X-XSS-Protection"
    )
    
    local found_headers=0
    for header in "${required_headers[@]}"; do
        if echo "$headers" | grep -qi "$header:"; then
            found_headers=$((found_headers + 1))
        fi
    done
    
    if [[ $found_headers -eq ${#required_headers[@]} ]]; then
    add_result "security_headers" "PASS" "All required security headers present"
    elif [[ $found_headers -gt 0 ]]; then
    add_result "security_headers" "WARNING" "$found_headers/${#required_headers[@]} security headers found"
    else
    add_result "security_headers" "FAIL" "Security headers missing"
    fi
}

# 5. Performance check
check_performance() {
    log "Checking performance..."
    
    http_request "$BASE_URL/api/health/liveness"
    local response_time="$HTTP_TIME"
    
    if awk "BEGIN{exit !($response_time < 1.0)}"; then
    add_result "response_time" "PASS" "Response time: ${response_time}s (excellent)"
    elif awk "BEGIN{exit !($response_time < 2.0)}"; then
    add_result "response_time" "WARNING" "Response time: ${response_time}s (acceptable)"
    else
    add_result "response_time" "FAIL" "Response time: ${response_time}s (slow)"
    fi
}

# 6. SSL certificate check (if HTTPS)
check_ssl_certificate() {
    if [[ "$BASE_URL" =~ ^https:// ]]; then
    log "Checking SSL certificate..."
        
        local domain=$(echo "$BASE_URL" | sed 's|https://||' | sed 's|/.*||')
        local ssl_info=$(echo | openssl s_client -connect "$domain:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -dates 2>/dev/null || echo "")
        
        if [[ -n "$ssl_info" ]]; then
            local not_after=$(echo "$ssl_info" | grep "notAfter=" | cut -d= -f2)
            local expiry_date=$(date -d "$not_after" +%s 2>/dev/null || echo "0")
            local current_date=$(date +%s)
            local days_left=$(( (expiry_date - current_date) / 86400 ))
            
            if [[ $days_left -gt 30 ]]; then
                add_result "ssl_certificate" "PASS" "SSL certificate valid ($days_left days until expiry)"
            elif [[ $days_left -gt 7 ]]; then
                add_result "ssl_certificate" "WARNING" "SSL certificate expires in $days_left days"
            else
                add_result "ssl_certificate" "FAIL" "SSL certificate expires in $days_left days"
            fi
        else
            add_result "ssl_certificate" "FAIL" "Could not retrieve SSL certificate information"
        fi
    else
    add_result "ssl_certificate" "WARNING" "HTTP connection - SSL not in use"
    fi
}

# 7. Docker containers check (if available)
check_docker_status() {
    if command -v docker &> /dev/null && [[ "$BASE_URL" =~ ^https?://localhost ]] || [[ "$BASE_URL" =~ ^http://127\.0\.0\.1 ]]; then
    log "Checking Docker containers..."
        
        if [[ -f "docker-compose.prod.yml" ]]; then
            local containers=$(docker compose -f docker-compose.prod.yml ps --format json 2>/dev/null || echo "[]")
            local running_containers=$(echo "$containers" | jq '[.[] | select(.State == "running")] | length' 2>/dev/null || echo "0")
            local total_containers=$(echo "$containers" | jq 'length' 2>/dev/null || echo "0")
            
            if [[ $running_containers -eq $total_containers && $total_containers -gt 0 ]]; then
                add_result "docker_containers" "PASS" "All containers running ($running_containers/$total_containers)"
            elif [[ $running_containers -gt 0 ]]; then
                add_result "docker_containers" "WARNING" "Partially running containers ($running_containers/$total_containers)"
            else
                add_result "docker_containers" "FAIL" "Containers not running"
            fi
        else
            add_result "docker_containers" "WARNING" "docker-compose.prod.yml not found"
        fi
    else
    add_result "docker_containers" "WARNING" "Docker unavailable or remote check"
    fi
}

# 8. API functionality check
check_api_functionality() {
    log "Checking API functionality..."
    
    # Public endpoint check.
    #
    # Проба смотрит на ПУБЛИЧНЫЙ /:lang/books, а не на /api/books: последний с
    # 10.08.2026 закрыт гвардом как административный (LEGACY-093). На закрытом
    # маршруте эта проверка не упала бы — она отдаёт WARNING и выходит с нулём,
    # то есть молча перестала бы что-либо проверять. Ровно та форма ошибки, что
    # дважды сработала в LEGACY-072.
    http_request "$BASE_URL/api/en/books?limit=1"
    local books_status="$HTTP_STATUS"

    if [[ "$books_status" == "200" ]]; then
    add_result "api_books" "PASS" "Books API accessible"
    else
    # FAIL, а не WARNING: недоступный публичный каталог — это поломка витрины,
    # а не повод для сноски. В WARNING эта строка сидела ровно потому, что
    # WARNING ничего не стоил — прогон всё равно завершался нулём.
    add_result "api_books" "FAIL" "Books API not accessible (HTTP $books_status)"
    fi
    
    # CORS headers check
    local cors_headers=$(curl -s -I -H "Origin: https://example.com" "$BASE_URL/api/health/liveness" --max-time "$TIMEOUT" 2>/dev/null || echo "")
    if echo "$cors_headers" | grep -qi "access-control-allow-origin"; then
    add_result "cors" "PASS" "CORS headers configured"
    else
    add_result "cors" "WARNING" "CORS headers not detected"
    fi
}

# Generate JSON report
generate_json_report() {
    local json_results="{"
    json_results+='"timestamp":"'$(date -Iseconds)'",'
    json_results+='"base_url":"'$BASE_URL'",'
    json_results+='"total_checks":'$TOTAL_CHECKS','
    json_results+='"passed":'$PASSED_CHECKS','
    json_results+='"failed":'$FAILED_CHECKS','
    json_results+='"warnings":'$WARNING_CHECKS','
    json_results+='"success_rate":'$(awk "BEGIN{printf \"%.2f\", $PASSED_CHECKS * 100 / $TOTAL_CHECKS}")'%,'
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

# Generate text report
generate_text_report() {
    echo ""
    echo "========================================"
    echo "📊 FINAL READINESS CHECK REPORT"
    echo "========================================"
    echo "URL: $BASE_URL"
    echo "Time: $(date)"
    echo ""
    echo "📈 STATISTICS:"
    echo "  Total checks: $TOTAL_CHECKS"
    echo "  Passed: $PASSED_CHECKS"
    echo "  Warnings: $WARNING_CHECKS" 
    echo "  Failures: $FAILED_CHECKS"
    echo "  Success rate: $(awk "BEGIN{printf \"%.1f\", $PASSED_CHECKS * 100 / $TOTAL_CHECKS}")%"
    echo ""
    
    if [[ $FAILED_CHECKS -eq 0 && $WARNING_CHECKS -eq 0 ]]; then
    echo -e "${GREEN}🎉 ALL CHECKS PASSED - READY FOR DEPLOYMENT!${NC}"
    elif [[ $FAILED_CHECKS -eq 0 ]]; then
    echo -e "${YELLOW}⚠️  Warnings present, but deployment acceptable${NC}"
    else
    echo -e "${RED}❌ Critical issues found - deployment NOT RECOMMENDED${NC}"
    fi
    echo ""
    
    if [[ "$DETAILED" == true ]]; then
    echo "🔍 DETAILED RESULTS:"
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

# Main function
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
    
    # Run checks
    check_api_health
    check_database  
    check_security_config
    check_security_headers
    check_performance
    check_ssl_certificate
    check_docker_status
    check_api_functionality
    
    # Generate report
    local report=""
    if [[ "$FORMAT" == "json" ]]; then
        report=$(generate_json_report)
    else
        report=$(generate_text_report)
    fi
    
    # Output or save
    if [[ -n "$SAVE_FILE" ]]; then
        echo "$report" > "$SAVE_FILE"
    [[ "$FORMAT" == "text" ]] && echo "📁 Report saved: $SAVE_FILE"
    else
        echo "$report"
    fi
    
    # Exit code
    #
    # 🔴 Раньше здесь было только «0 или 1 по FAILED_CHECKS», и любое число
    # WARNING давало нулевой выход. То есть отчёт с десятком предупреждений
    # выглядел для вызывающего ровно как чистый прогон. А в WARNING попадает
    # именно то, ради чего проверку и запускают: недоступный публичный каталог,
    # непроверяемый Docker, отсутствующие заголовки CORS.
    #
    # Три состояния вместо двух: 0 — чисто, 2 — есть предупреждения, 1 — отказ.
    # Код 2 выбран так, чтобы существующие `if ./health_check.sh` продолжали
    # считать предупреждения неуспехом, а не чтобы тихо совпасть с нулём.
    if [[ $FAILED_CHECKS -gt 0 ]]; then
        exit 1
    elif [[ $WARNING_CHECKS -gt 0 ]]; then
        exit 2
    else
        exit 0
    fi
}

# Error trap
trap 'echo "❌ Error at line $LINENO"' ERR

# Dependency check
#
# 🔴 `bc` из списка убран, а вычисления переведены на `awk`: на продовом VPS
# пакета `bc` нет, и скрипт падал на этой самой проверке — то есть проба,
# заявленная в документации как способ проверить прод, не могла там
# выполниться вовсе. `awk` есть в любом POSIX-окружении.
for cmd in curl jq; do
    if ! command -v $cmd &> /dev/null; then
    echo "❌ Required command missing: $cmd"
        exit 1
    fi
done

# Execute
main "$@"
