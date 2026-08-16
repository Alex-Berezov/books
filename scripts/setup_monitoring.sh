#!/bin/bash

# Books App Monitoring Setup Script
# Monitoring system setup (Prometheus + Grafana + AlertManager)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging helpers
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

# Dependency check
check_dependencies() {
    log "Checking dependencies..."
    
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed. Install Docker and try again."
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        if ! docker compose version &> /dev/null; then
            error "Docker Compose not found. Install Docker Compose and try again."
        fi
    fi
    
    log "✓ All dependencies are installed"
}

# Load `.env.monitoring` before anything reads its variables.
#
# 🔴 Раньше он подхватывался только внутри `start_monitoring()`, то есть уже
# после `setup_configs()`. `NODE_TEXTFILE_DIR` при этом читалась дважды из разных
# источников: скрипт брал умолчание, а docker — значение из `.env.monitoring`.
# Итог — каталог создан по одному пути, смонтирован по другому: бэкап пишет
# метрику туда, где node-exporter её не видит, при исправных бэкапах горит
# `DatabaseBackupMetricMissing`. Значение обязано быть одно на всех.
load_monitoring_env() {
    if [[ -f ".env.monitoring" ]]; then
        log "Loading environment variables from .env.monitoring"
        set -a
        # shellcheck disable=SC1091
        source .env.monitoring
        set +a
    fi
}

# Create Docker networks
create_networks() {
    log "Creating Docker networks..."
    
    # Check if books-network exists
    if ! docker network ls | grep -q "books-network"; then
        docker network create books-network
        log "✓ Created network books-network"
    else
        log "✓ Network books-network already exists"
    fi
}

# Configure files
setup_configs() {
    log "Configuring files..."
    
    # Check required files exist
    required_files=(
        "configs/prometheus.yml"
        "configs/alert_rules.yml"
        # `rule_files` в prometheus.yml перечисляет и его: без файла Prometheus
        # не поднимется вовсе, а раньше скрипт печатал «✓ verified».
        "configs/recording_rules.yml"
        "configs/alertmanager.yml"
        "docker-compose.monitoring.yml"
    )

    # LEGACY-226. Секреты живут вне репозитория и по сервису: каждый контейнер
    # монтирует только свой каталог, поэтому Prometheus больше не видит токен
    # бота, а Alertmanager — bearer ко всем метрикам. Создаются руками на сервере;
    # без них стек поднимается зелёным, а bearer к /api/metrics и доставка
    # в Telegram молча не работают — оба файла читаются не при старте,
    # а при обращении.
    local secrets_root="${MONITORING_SECRETS_DIR:-/opt/books/monitoring/secrets}"

    # 🔴 Каталоги заводятся здесь, а не «ожидаются готовыми». Если их нет к моменту
    # `up -d`, docker создаёт на их месте пустые root:root, оба контейнера
    # поднимаются здоровыми, а скрейп и доставка молча мертвы. Так и вышло
    # 16.08.2026 при переносе секретов. Ошибки `mkdir`/`chown` установку не роняют:
    # то же решение, что у каталога textfile-коллектора ниже.
    local secret_dir
    for secret_dir in "$secrets_root/prometheus" "$secrets_root/alertmanager"; do
        if [[ ! -d "$secret_dir" ]]; then
            if mkdir -p "$secret_dir" 2>/dev/null; then
                log "✓ Created secrets directory: $secret_dir"
            else
                warn "Could not create $secret_dir — create it manually: sudo mkdir -p $secret_dir"
            fi
        fi
        # Владелец — тот же uid, под которым работает процесс в контейнере.
        # `700` при этом владельце достаточно: посторонним каталог не нужен вовсе.
        chown 65534:65534 "$secret_dir" 2>/dev/null || warn "Could not chown $secret_dir to 65534"
        chmod 700 "$secret_dir" 2>/dev/null || true
    done

    required_files+=(
        "$secrets_root/prometheus/metrics_token"
        "$secrets_root/alertmanager/telegram_token"
    )

    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            case "$file" in
                "$secrets_root"/*)
                    error "Secret $file not found. Fix: sudo install -o 65534 -g 65534 -m 400 /dev/stdin $file <<< 'ЗНАЧЕНИЕ'"
                    ;;
                *)
                    error "File $file not found. Ensure all configuration files are present."
                    ;;
            esac
        fi
    done

    # LEGACY-096. Мало того что файл существует — его должен читать процесс в контейнере.
    # Образ `prom/alertmanager` работает под `USER nobody` (uid 65534), а самый естественный
    # способ создать файл (`echo ... > configs/telegram_token` из-под `deploy`) даёт
    # `deploy:deploy 600`. Alertmanager при этом стартует, UI зелёный, `AlertmanagerDown`
    # молчит — и канал не получает ничего. Проверять здесь, а не по факту тишины в Telegram.
    #
    # Требование одинаково для обоих секретов: `prom/prometheus` работает под тем же
    # uid 65534. Нечитаемый `metrics_token` даёт не 401 от приложения, а ошибку чтения
    # `credentials_file` на скрейпе — job `books-app` уходит в down и `BooksAppDown`
    # горит при полностью живом приложении.
    local secret_uid secret
    for secret in "$secrets_root/alertmanager/telegram_token" "$secrets_root/prometheus/metrics_token"; do
        secret_uid=$(stat -c '%u' "$secret" 2>/dev/null || echo "?")
        if [[ "$secret_uid" != "65534" ]]; then
            warn "$secret принадлежит uid ${secret_uid}, а процесс в контейнере работает под 65534"
            warn "Fix: sudo chown 65534:65534 $secret && sudo chmod 400 $secret"
        fi
    done

    # LEGACY-229. Предусловие, которого не было при пофайловом монтаже: монтируются
    # каталоги (LEGACY-224, LEGACY-226), и uid 65534 обязан иметь на каждый бит `x`,
    # иначе не откроется ни один файл внутри. Отказ выглядит как «Prometheus
    # не стартовал» без объяснения: `permission denied` в логах контейнера.
    # Нужен именно `x`: файл открывается по полному пути, листинг каталога никому
    # не нужен, поэтому `751` достаточно, а `750` — уже нет.
    # Считается доступ именно для uid 65534, а не «для остальных»: у `configs/`
    # владелец `deploy`, и процессу в контейнере важен последний бит, а у каталогов
    # секретов владелец — сам 65534, и там решает владельческий бит. Проверка
    # только по «остальным» уговаривала бы расширить доступ к хранилищу секретов
    # до траверса любым пользователем хоста.
    local dir_mode dir_uid dir_digit checked_dir
    for checked_dir in configs "$secrets_root/prometheus" "$secrets_root/alertmanager"; do
        dir_mode=$(stat -c '%a' "$checked_dir" 2>/dev/null || echo "?")
        dir_uid=$(stat -c '%u' "$checked_dir" 2>/dev/null || echo "?")
        if [[ "$dir_uid" == "65534" ]]; then
            dir_digit="${dir_mode:0:1}"   # владельческие биты
        else
            dir_digit="${dir_mode: -1}"   # биты «для остальных»
        fi
        if [[ ! "$dir_digit" =~ ^[0-7]$ ]] || (( (dir_digit & 1) == 0 )); then
            warn "каталог $checked_dir (uid ${dir_uid}, права ${dir_mode}) не проходим для uid 65534"
            if [[ "$dir_uid" == "65534" ]]; then
                warn "Fix: sudo chmod 700 $checked_dir"
            else
                warn "Fix: sudo chmod 751 $checked_dir"
            fi
        fi
    done

    # LEGACY-219. Каталог textfile-коллектора: сюда backup_database.sh кладёт
    # отметку успешного прогона, отсюда node-exporter её читает.
    #
    # 🔴 Одного `mkdir` мало. Скрипт установки запускается от root
    # (`setup_server.sh` зовёт его после `check_root`), а бэкап ходит под
    # пользователем cron — `BACKUP_USER`, по умолчанию `deploy`. Каталог
    # `root:root 755` этому пользователю на запись недоступен, и метрика молча
    # не пишется. Поэтому обязателен `chown`.
    #
    # Ни одна из трёх команд не имеет права уронить установку: под `set -e`
    # отказ `chmod`/`chown` на уже существующем чужом каталоге оборвал бы
    # скрипт до `start_monitoring`, то есть правка, включающая оповещения,
    # ломала бы их установку.
    local textfile_dir="${NODE_TEXTFILE_DIR:-/opt/books/monitoring/textfile}"
    local textfile_owner="${BACKUP_USER:-deploy}"

    if ! mkdir -p "$textfile_dir" 2>/dev/null; then
        warn "Could not create $textfile_dir — create it manually and rerun"
    elif ! chown "$textfile_owner" "$textfile_dir" 2>/dev/null; then
        warn "Could not chown $textfile_dir to $textfile_owner — the backup metric will not be written"
        warn "Fix: sudo chown $textfile_owner $textfile_dir"
    else
        chmod 755 "$textfile_dir" 2>/dev/null || true
        log "✓ Textfile collector directory ready: $textfile_dir (owner $textfile_owner)"
    fi

    # Copy alert_rules.yml into Prometheus config dir
    cp configs/alert_rules.yml configs/prometheus_alert_rules.yml 2>/dev/null || true
    
    log "✓ Configuration files verified"
}

# Update Prometheus config for correct app access
update_prometheus_config() {
    log "Updating Prometheus configuration..."
    
    # Determine correct target for Docker environment
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS (Docker Desktop)
        TARGET="host.docker.internal:5000"
    elif [[ -f /.dockerenv ]] || grep -q docker /proc/1/cgroup 2>/dev/null; then
        # Inside a Docker container
        TARGET="172.17.0.1:5000"
    else
        # Linux host
        TARGET="172.17.0.1:5000"
    fi
    
    # Update target in Prometheus configuration
    if grep -q "host.docker.internal:5000" configs/prometheus.yml; then
        if [[ "$OSTYPE" != "darwin"* ]]; then
            sed -i "s/host.docker.internal:5000/$TARGET/g" configs/prometheus.yml
            log "✓ Updated target for Linux environment: $TARGET"
        fi
    fi
}

# Start monitoring
start_monitoring() {
    log "Starting monitoring stack..."
    
    # Stop existing containers (if any)
    docker-compose -f docker-compose.monitoring.yml down 2>/dev/null || true
    
    # Переменные уже загружены `load_monitoring_env` первым шагом `main`.

    # Start services
    docker-compose -f docker-compose.monitoring.yml up -d
    
    log "✓ Monitoring system started"
}

# Wait for services to be ready
wait_for_services() {
    log "Waiting for services to become ready..."
    
    local services=("prometheus:9090" "grafana:3000" "node-exporter:9100" "alertmanager:9093")
    local max_attempts=30
    local attempt=0
    
    for service in "${services[@]}"; do
        local name=${service%:*}
        local port=${service#*:}
        
        attempt=0
        while [[ $attempt -lt $max_attempts ]]; do
            if docker-compose -f docker-compose.monitoring.yml exec -T $name wget -q --spider http://localhost:$port 2>/dev/null; then
                log "✓ $name is ready"
                break
            fi
            
            # LEGACY-228. Не `((attempt++))`: постфиксная форма возвращает прежнее
            # значение, то есть при `attempt=0` код возврата 1, и под `set -e` (:6)
            # установка обрывалась на первой же неготовой службе. Из-за этого
            # 16.08.2026 скрипт не запускался вовсе и стек поднимали руками.
            attempt=$((attempt + 1))
            if [[ $attempt -eq $max_attempts ]]; then
                warn "$name not ready after $max_attempts attempts"
            else
                sleep 2
            fi
        done
    done
}

# Test services availability
test_services() {
    log "Testing services availability..."
    
    local prometheus_port=${PROMETHEUS_PORT:-9090}
    local grafana_port=${GRAFANA_PORT:-3000}
    local alertmanager_port=${ALERTMANAGER_PORT:-9093}
    
    # Test Prometheus
    if curl -sf "http://localhost:$prometheus_port/-/healthy" > /dev/null; then
        log "✓ Prometheus available on port $prometheus_port"
    else
        error "Prometheus unavailable on port $prometheus_port"
    fi
    
    # Test Grafana
    if curl -sf "http://localhost:$grafana_port/api/health" > /dev/null; then
        log "✓ Grafana available on port $grafana_port"
    else
        error "Grafana unavailable on port $grafana_port"
    fi
    
    # Test AlertManager
    if curl -sf "http://localhost:$alertmanager_port/-/healthy" > /dev/null; then
        log "✓ AlertManager available on port $alertmanager_port"
    else
        error "AlertManager unavailable on port $alertmanager_port"
    fi
}

# Access information
show_access_info() {
    log "Monitoring system installed successfully!"
    echo
    echo -e "${BLUE}╭─────────────────────────────────────────────────────────────╮${NC}"
    echo -e "${BLUE}│                        SERVICE ACCESS                         │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Grafana:      http://localhost:${GRAFANA_PORT:-3000}                              │${NC}"
    echo -e "${BLUE}│ Prometheus:   http://localhost:${PROMETHEUS_PORT:-9090}                              │${NC}"
    echo -e "${BLUE}│ AlertManager: http://localhost:${ALERTMANAGER_PORT:-9093}                              │${NC}"
    echo -e "${BLUE}│ Node Exporter: http://localhost:${NODE_EXPORTER_PORT:-9100}                             │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Grafana login: ${GRAFANA_ADMIN_USER:-admin} / ${GRAFANA_ADMIN_PASSWORD:-admin123}                          │${NC}"
    echo -e "${BLUE}╰─────────────────────────────────────────────────────────────╯${NC}"
    echo
    echo -e "${GREEN}Grafana dashboards will be loaded automatically.${NC}"
    echo -e "${GREEN}To verify, run: ./scripts/test_monitoring.sh${NC}"
}

# Main function
main() {
    echo -e "${BLUE}"
    echo "████████████████████████████████████████████████████"
    echo "█ Books App - Monitoring Setup                    █"
    echo "█ Install Prometheus + Grafana + AlertManager     █"
    echo "████████████████████████████████████████████████████"
    echo -e "${NC}"
    
    load_monitoring_env
    check_dependencies
    create_networks
    setup_configs
    update_prometheus_config
    start_monitoring
    
    sleep 10  # Give services time to start
    
    wait_for_services
    test_services
    show_access_info
}

# Interrupt handling
trap 'error "Installation interrupted by user"' INT

# Run script
main "$@"
