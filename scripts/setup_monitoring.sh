#!/bin/bash

# Books App Monitoring Setup Script
# Настройка системы мониторинга (Prometheus + Grafana + AlertManager)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функция для логирования
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[WARNING] $1${NC}"
}

error() {
    echo -e "${RED}[ERROR] $1${NC}"
    exit 1
}

# Проверка зависимостей
check_dependencies() {
    log "Проверка зависимостей..."
    
    if ! command -v docker &> /dev/null; then
        error "Docker не установлен. Установите Docker и повторите попытку."
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        if ! docker compose version &> /dev/null; then
            error "Docker Compose не найден. Установите Docker Compose и повторите попытку."
        fi
    fi
    
    log "✓ Все зависимости установлены"
}

# Создание сетей Docker
create_networks() {
    log "Создание Docker сетей..."
    
    # Проверяем существует ли сеть books-network
    if ! docker network ls | grep -q "books-network"; then
        docker network create books-network
        log "✓ Создана сеть books-network"
    else
        log "✓ Сеть books-network уже существует"
    fi
}

# Настройка конфигурационных файлов
setup_configs() {
    log "Настройка конфигурационных файлов..."
    
    # Проверка существования необходимых файлов
    required_files=(
        "configs/prometheus.yml"
        "configs/alert_rules.yml"
        "configs/alertmanager.yml"
        "docker-compose.monitoring.yml"
    )
    
    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            error "Файл $file не найден. Убедитесь, что все конфигурационные файлы на месте."
        fi
    done
    
    # Копируем alert_rules.yml в директорию Prometheus конфигурации
    cp configs/alert_rules.yml configs/prometheus_alert_rules.yml 2>/dev/null || true
    
    log "✓ Конфигурационные файлы проверены"
}

# Обновление конфигурации Prometheus для правильного доступа к приложению
update_prometheus_config() {
    log "Обновление конфигурации Prometheus..."
    
    # Определяем правильный target для Docker окружения
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS (Docker Desktop)
        TARGET="host.docker.internal:5000"
    elif [[ -f /.dockerenv ]] || grep -q docker /proc/1/cgroup 2>/dev/null; then
        # Внутри Docker контейнера
        TARGET="172.17.0.1:5000"
    else
        # Linux хост
        TARGET="172.17.0.1:5000"
    fi
    
    # Обновляем target в конфигурации Prometheus
    if grep -q "host.docker.internal:5000" configs/prometheus.yml; then
        if [[ "$OSTYPE" != "darwin"* ]]; then
            sed -i "s/host.docker.internal:5000/$TARGET/g" configs/prometheus.yml
            log "✓ Обновлен target для Linux окружения: $TARGET"
        fi
    fi
}

# Запуск мониторинга
start_monitoring() {
    log "Запуск системы мониторинга..."
    
    # Остановка существующих контейнеров (если есть)
    docker-compose -f docker-compose.monitoring.yml down 2>/dev/null || true
    
    # Загрузка переменных окружения
    if [[ -f ".env.monitoring" ]]; then
        log "Загрузка переменных окружения из .env.monitoring"
        export $(cat .env.monitoring | grep -v '^#' | xargs)
    fi
    
    # Запуск сервисов
    docker-compose -f docker-compose.monitoring.yml up -d
    
    log "✓ Система мониторинга запущена"
}

# Ожидание готовности сервисов
wait_for_services() {
    log "Ожидание готовности сервисов..."
    
    local services=("prometheus:9090" "grafana:3000" "node-exporter:9100" "alertmanager:9093")
    local max_attempts=30
    local attempt=0
    
    for service in "${services[@]}"; do
        local name=${service%:*}
        local port=${service#*:}
        
        attempt=0
        while [[ $attempt -lt $max_attempts ]]; do
            if docker-compose -f docker-compose.monitoring.yml exec -T $name wget -q --spider http://localhost:$port 2>/dev/null; then
                log "✓ $name готов"
                break
            fi
            
            ((attempt++))
            if [[ $attempt -eq $max_attempts ]]; then
                warn "$name не готов после $max_attempts попыток"
            else
                sleep 2
            fi
        done
    done
}

# Проверка доступности сервисов
test_services() {
    log "Тестирование доступности сервисов..."
    
    local prometheus_port=${PROMETHEUS_PORT:-9090}
    local grafana_port=${GRAFANA_PORT:-3000}
    local alertmanager_port=${ALERTMANAGER_PORT:-9093}
    
    # Тест Prometheus
    if curl -sf "http://localhost:$prometheus_port/-/healthy" > /dev/null; then
        log "✓ Prometheus доступен на порту $prometheus_port"
    else
        error "Prometheus недоступен на порту $prometheus_port"
    fi
    
    # Тест Grafana
    if curl -sf "http://localhost:$grafana_port/api/health" > /dev/null; then
        log "✓ Grafana доступен на порту $grafana_port"
    else
        error "Grafana недоступен на порту $grafana_port"
    fi
    
    # Тест AlertManager
    if curl -sf "http://localhost:$alertmanager_port/-/healthy" > /dev/null; then
        log "✓ AlertManager доступен на порту $alertmanager_port"
    else
        error "AlertManager недоступен на порту $alertmanager_port"
    fi
}

# Вывод информации для доступа
show_access_info() {
    log "Система мониторинга успешно установлена!"
    echo
    echo -e "${BLUE}╭─────────────────────────────────────────────────────────────╮${NC}"
    echo -e "${BLUE}│                    ДОСТУП К СЕРВИСАМ                        │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Grafana:      http://localhost:${GRAFANA_PORT:-3000}                              │${NC}"
    echo -e "${BLUE}│ Prometheus:   http://localhost:${PROMETHEUS_PORT:-9090}                              │${NC}"
    echo -e "${BLUE}│ AlertManager: http://localhost:${ALERTMANAGER_PORT:-9093}                              │${NC}"
    echo -e "${BLUE}│ Node Exporter: http://localhost:${NODE_EXPORTER_PORT:-9100}                             │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Grafana логин: ${GRAFANA_ADMIN_USER:-admin} / ${GRAFANA_ADMIN_PASSWORD:-admin123}                          │${NC}"
    echo -e "${BLUE}╰─────────────────────────────────────────────────────────────╯${NC}"
    echo
    echo -e "${GREEN}Дашборды Grafana будут автоматически загружены.${NC}"
    echo -e "${GREEN}Для проверки работы запустите: ./scripts/test_monitoring.sh${NC}"
}

# Основная функция
main() {
    echo -e "${BLUE}"
    echo "████████████████████████████████████████████████████"
    echo "█ Books App - Monitoring Setup                    █"
    echo "█ Установка Prometheus + Grafana + AlertManager   █"
    echo "████████████████████████████████████████████████████"
    echo -e "${NC}"
    
    check_dependencies
    create_networks
    setup_configs
    update_prometheus_config
    start_monitoring
    
    sleep 10  # Даем время сервисам запуститься
    
    wait_for_services
    test_services
    show_access_info
}

# Обработка прерывания
trap 'error "Установка прервана пользователем"' INT

# Запуск скрипта
main "$@"
