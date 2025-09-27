#!/bin/bash

# Books App Monitoring Test Script
# Проверка работоспособности системы мониторинга

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Счетчики
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Функции для вывода
log() {
    echo -e "${GREEN}[INFO] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[WARNING] $1${NC}"
}

error() {
    echo -e "${RED}[ERROR] $1${NC}"
}

test_result() {
    local test_name="$1"
    local result="$2"
    local details="$3"
    
    ((TOTAL_TESTS++))
    
    if [[ "$result" == "PASS" ]]; then
        echo -e "${GREEN}✓ $test_name${NC}"
        ((PASSED_TESTS++))
    else
        echo -e "${RED}✗ $test_name${NC}"
        if [[ -n "$details" ]]; then
            echo -e "  ${RED}Детали: $details${NC}"
        fi
        ((FAILED_TESTS++))
    fi
}

# Проверка доступности сервиса
check_service() {
    local name="$1"
    local url="$2"
    local expected_status="${3:-200}"
    
    if response=$(curl -s -w "%{http_code}" -o /dev/null "$url" 2>/dev/null); then
        if [[ "$response" == "$expected_status" ]]; then
            test_result "$name доступность" "PASS"
            return 0
        else
            test_result "$name доступность" "FAIL" "HTTP $response (ожидался $expected_status)"
            return 1
        fi
    else
        test_result "$name доступность" "FAIL" "Соединение не установлено"
        return 1
    fi
}

# Проверка метрик Prometheus
check_prometheus_metrics() {
    log "Проверка метрик Prometheus..."
    
    local prometheus_url="http://localhost:${PROMETHEUS_PORT:-9090}"
    
    # Базовая проверка доступности
    if ! check_service "Prometheus" "$prometheus_url/-/healthy"; then
        return 1
    fi
    
    # Проверка наличия targets
    if targets=$(curl -s "$prometheus_url/api/v1/targets" 2>/dev/null); then
        if echo "$targets" | jq -e '.data.activeTargets[] | select(.job=="books-app")' > /dev/null 2>&1; then
            test_result "Prometheus target 'books-app'" "PASS"
        else
            test_result "Prometheus target 'books-app'" "FAIL" "Target не найден или неактивен"
        fi
        
        if echo "$targets" | jq -e '.data.activeTargets[] | select(.job=="node-exporter")' > /dev/null 2>&1; then
            test_result "Prometheus target 'node-exporter'" "PASS"
        else
            test_result "Prometheus target 'node-exporter'" "FAIL" "Target не найден или неактивен"
        fi
    else
        test_result "Prometheus API targets" "FAIL" "Не удалось получить список targets"
    fi
    
    # Проверка наличия метрик приложения
    if metrics=$(curl -s "$prometheus_url/api/v1/query?query=up{job=\"books-app\"}" 2>/dev/null); then
        if echo "$metrics" | jq -e '.data.result[0].value[1]' > /dev/null 2>&1; then
            local up_value=$(echo "$metrics" | jq -r '.data.result[0].value[1]')
            if [[ "$up_value" == "1" ]]; then
                test_result "Books App метрики" "PASS"
            else
                test_result "Books App метрики" "FAIL" "Приложение показывает down (value: $up_value)"
            fi
        else
            test_result "Books App метрики" "FAIL" "Метрика up не найдена"
        fi
    else
        test_result "Prometheus API query" "FAIL" "Не удалось выполнить запрос"
    fi
}

# Проверка Grafana
check_grafana() {
    log "Проверка Grafana..."
    
    local grafana_url="http://localhost:${GRAFANA_PORT:-3000}"
    
    # Базовая проверка доступности
    if ! check_service "Grafana" "$grafana_url/api/health"; then
        return 1
    fi
    
    # Проверка источников данных
    local auth_header="Authorization: Basic $(echo -n "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-admin123}" | base64)"
    
    if datasources=$(curl -s -H "$auth_header" "$grafana_url/api/datasources" 2>/dev/null); then
        if echo "$datasources" | jq -e '.[] | select(.name=="Prometheus")' > /dev/null 2>&1; then
            test_result "Grafana источник данных Prometheus" "PASS"
        else
            test_result "Grafana источник данных Prometheus" "FAIL" "Источник данных не настроен"
        fi
    else
        test_result "Grafana API datasources" "FAIL" "Не удалось получить список источников данных"
    fi
    
    # Проверка дашбордов
    if dashboards=$(curl -s -H "$auth_header" "$grafana_url/api/search?type=dash-db" 2>/dev/null); then
        local dashboard_count=$(echo "$dashboards" | jq length 2>/dev/null || echo "0")
        if [[ "$dashboard_count" -gt 0 ]]; then
            test_result "Grafana дашборды" "PASS" "Найдено $dashboard_count дашборд(ов)"
        else
            test_result "Grafana дашборды" "FAIL" "Дашборды не найдены"
        fi
    else
        test_result "Grafana API dashboards" "FAIL" "Не удалось получить список дашбордов"
    fi
}

# Проверка AlertManager
check_alertmanager() {
    log "Проверка AlertManager..."
    
    local alertmanager_url="http://localhost:${ALERTMANAGER_PORT:-9093}"
    
    # Базовая проверка доступности
    if ! check_service "AlertManager" "$alertmanager_url/-/healthy"; then
        return 1
    fi
    
    # Проверка статуса
    if status=$(curl -s "$alertmanager_url/api/v1/status" 2>/dev/null); then
        if echo "$status" | jq -e '.status=="success"' > /dev/null 2>&1; then
            test_result "AlertManager статус" "PASS"
        else
            test_result "AlertManager статус" "FAIL" "Статус не success"
        fi
    else
        test_result "AlertManager API status" "FAIL" "Не удалось получить статус"
    fi
    
    # Проверка конфигурации
    if config=$(curl -s "$alertmanager_url/api/v1/status" 2>/dev/null); then
        test_result "AlertManager конфигурация" "PASS"
    else
        test_result "AlertManager конфигурация" "FAIL" "Не удалось получить конфигурацию"
    fi
}

# Проверка Node Exporter
check_node_exporter() {
    log "Проверка Node Exporter..."
    
    local node_exporter_url="http://localhost:${NODE_EXPORTER_PORT:-9100}"
    
    # Базовая проверка доступности
    if ! check_service "Node Exporter" "$node_exporter_url/metrics"; then
        return 1
    fi
    
    # Проверка наличия ключевых метрик
    if metrics=$(curl -s "$node_exporter_url/metrics" 2>/dev/null); then
        local key_metrics=("node_cpu_seconds_total" "node_memory_MemTotal_bytes" "node_filesystem_size_bytes")
        
        for metric in "${key_metrics[@]}"; do
            if echo "$metrics" | grep -q "^$metric"; then
                test_result "Node Exporter метрика '$metric'" "PASS"
            else
                test_result "Node Exporter метрика '$metric'" "FAIL" "Метрика не найдена"
            fi
        done
    else
        test_result "Node Exporter метрики" "FAIL" "Не удалось получить метрики"
    fi
}

# Проверка интеграции с основным приложением
check_app_integration() {
    log "Проверка интеграции с основным приложением..."
    
    # Проверяем доступность метрик приложения напрямую
    if curl -s "http://localhost:5000/api/metrics" > /dev/null 2>&1; then
        test_result "Books App /api/metrics" "PASS"
        
        # Проверяем конкретные метрики
        if metrics=$(curl -s "http://localhost:5000/api/metrics" 2>/dev/null); then
            if echo "$metrics" | grep -q "http_request_duration_seconds"; then
                test_result "Books App HTTP метрики" "PASS"
            else
                test_result "Books App HTTP метрики" "FAIL" "HTTP метрики не найдены"
            fi
            
            if echo "$metrics" | grep -q "process_cpu_user_seconds_total"; then
                test_result "Books App process метрики" "PASS"
            else
                test_result "Books App process метрики" "FAIL" "Process метрики не найдены"
            fi
        fi
    else
        test_result "Books App /api/metrics" "FAIL" "Эндпоинт недоступен"
        warn "Убедитесь что Books App запущено на порту 5000"
    fi
    
    # Проверяем health endpoints
    if curl -s "http://localhost:5000/api/health/liveness" > /dev/null 2>&1; then
        test_result "Books App health liveness" "PASS"
    else
        test_result "Books App health liveness" "FAIL" "Health endpoint недоступен"
    fi
    
    if curl -s "http://localhost:5000/api/health/readiness" > /dev/null 2>&1; then
        test_result "Books App health readiness" "PASS"
    else
        test_result "Books App health readiness" "FAIL" "Readiness endpoint недоступен"
    fi
}

# Симуляция тестового алерта
test_alert_system() {
    log "Тестирование системы алертов..."
    
    # Попытка создать тестовый алерт (это возможно только если AlertManager настроен)
    # Проверяем что правила алертов загружены в Prometheus
    local prometheus_url="http://localhost:${PROMETHEUS_PORT:-9090}"
    
    if rules=$(curl -s "$prometheus_url/api/v1/rules" 2>/dev/null); then
        if echo "$rules" | jq -e '.data.groups[].rules[] | select(.name=="BooksAppDown")' > /dev/null 2>&1; then
            test_result "Alert правила загружены" "PASS"
        else
            test_result "Alert правила загружены" "FAIL" "Правило BooksAppDown не найдено"
        fi
    else
        test_result "Prometheus API rules" "FAIL" "Не удалось получить правила"
    fi
}

# Проверка производительности
check_performance() {
    log "Проверка производительности системы мониторинга..."
    
    # Проверяем время отклика основных сервисов
    local services=("prometheus:${PROMETHEUS_PORT:-9090}/-/healthy" 
                   "grafana:${GRAFANA_PORT:-3000}/api/health" 
                   "alertmanager:${ALERTMANAGER_PORT:-9093}/-/healthy")
    
    for service in "${services[@]}"; do
        local name=${service%%:*}
        local endpoint="http://localhost:${service#*:}"
        
        local response_time=$(curl -s -w "%{time_total}" -o /dev/null "$endpoint" 2>/dev/null || echo "999")
        
        if (( $(echo "$response_time < 2" | bc -l 2>/dev/null || echo "0") )); then
            test_result "$name время отклика" "PASS" "${response_time}s"
        else
            test_result "$name время отклика" "FAIL" "${response_time}s (слишком медленно)"
        fi
    done
}

# Финальный отчет
generate_report() {
    echo
    echo -e "${BLUE}╭─────────────────────────────────────────────────────────────╮${NC}"
    echo -e "${BLUE}│                    ОТЧЕТ О ТЕСТИРОВАНИИ                     │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Всего тестов:     ${TOTAL_TESTS}                                        │${NC}"
    echo -e "${BLUE}│ Пройдено:         ${PASSED_TESTS}                                        │${NC}"
    echo -e "${BLUE}│ Провалено:        ${FAILED_TESTS}                                        │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    
    local success_rate=$((PASSED_TESTS * 100 / TOTAL_TESTS))
    if [[ $success_rate -ge 90 ]]; then
        echo -e "${BLUE}│ Результат: ${GREEN}ОТЛИЧНО${NC} ${BLUE}(${success_rate}%)                               │${NC}"
    elif [[ $success_rate -ge 70 ]]; then
        echo -e "${BLUE}│ Результат: ${YELLOW}ХОРОШО${NC} ${BLUE}(${success_rate}%)                                 │${NC}"
    else
        echo -e "${BLUE}│ Результат: ${RED}ТРЕБУЕТСЯ ВНИМАНИЕ${NC} ${BLUE}(${success_rate}%)                    │${NC}"
    fi
    
    echo -e "${BLUE}╰─────────────────────────────────────────────────────────────╯${NC}"
    echo
    
    if [[ $FAILED_TESTS -gt 0 ]]; then
        echo -e "${YELLOW}Рекомендации по устранению проблем:${NC}"
        echo "1. Проверьте логи контейнеров: docker-compose -f docker-compose.monitoring.yml logs"
        echo "2. Убедитесь что основное приложение запущено: curl http://localhost:5000/api/metrics"
        echo "3. Проверьте конфигурационные файлы на наличие ошибок"
        echo "4. Перезапустите систему мониторинга: ./scripts/setup_monitoring.sh"
        echo
        return 1
    else
        echo -e "${GREEN}Система мониторинга работает отлично!${NC}"
        echo
        return 0
    fi
}

# Основная функция
main() {
    echo -e "${BLUE}"
    echo "████████████████████████████████████████████████████"
    echo "█ Books App - Monitoring Test Suite              █"
    echo "█ Комплексная проверка системы мониторинга        █"
    echo "████████████████████████████████████████████████████"
    echo -e "${NC}"
    
    # Загрузка переменных окружения
    if [[ -f ".env.monitoring" ]]; then
        export $(cat .env.monitoring | grep -v '^#' | xargs)
    fi
    
    # Проверка зависимостей
    if ! command -v curl &> /dev/null; then
        error "curl не установлен. Установите curl и повторите попытку."
    fi
    
    if ! command -v jq &> /dev/null; then
        warn "jq не установлен. Некоторые тесты могут быть ограничены."
    fi
    
    # Запуск тестов
    check_prometheus_metrics
    check_grafana
    check_alertmanager
    check_node_exporter
    check_app_integration
    test_alert_system
    check_performance
    
    # Генерация отчета
    generate_report
}

# Запуск скрипта
main "$@"
