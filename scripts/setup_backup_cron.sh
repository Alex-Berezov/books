#!/bin/bash
set -euo pipefail

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функции логирования
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Конфигурация по умолчанию
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_SCRIPT="$SCRIPT_DIR/backup_database.sh"
TEST_SCRIPT="$SCRIPT_DIR/test_backup.sh"

# Настройки расписания по умолчанию
DAILY_TIME="${DAILY_TIME:-02:00}"      # Ежедневные бэкапы в 2:00
WEEKLY_DAY="${WEEKLY_DAY:-0}"          # Воскресенье (0-6, где 0=воскресенье)
WEEKLY_TIME="${WEEKLY_TIME:-03:00}"    # Еженедельные бэкапы в 3:00
MONTHLY_DAY="${MONTHLY_DAY:-1}"        # 1-е число месяца
MONTHLY_TIME="${MONTHLY_TIME:-04:00}"  # Ежемесячные бэкапы в 4:00
TEST_TIME="${TEST_TIME:-06:00}"        # Проверка целостности в 6:00

# Email для уведомлений
NOTIFICATION_EMAIL="${NOTIFICATION_EMAIL:-}"

# Пользователь для выполнения бэкапов
BACKUP_USER="${BACKUP_USER:-deploy}"

# Функция проверки существования пользователя
check_backup_user() {
    if ! id "$BACKUP_USER" &>/dev/null; then
        log_error "Пользователь $BACKUP_USER не существует"
        log_info "Создайте пользователя или измените BACKUP_USER"
        exit 1
    fi
    
    log_info "Бэкапы будут выполняться от имени пользователя: $BACKUP_USER"
}

# Функция проверки скриптов бэкапов
check_backup_scripts() {
    log_info "Проверка скриптов бэкапов..."
    
    if [[ ! -f "$BACKUP_SCRIPT" ]]; then
        log_error "Скрипт бэкапа не найден: $BACKUP_SCRIPT"
        exit 1
    fi
    
    if [[ ! -x "$BACKUP_SCRIPT" ]]; then
        log_warning "Скрипт бэкапа не исполняемый, исправляем..."
        chmod +x "$BACKUP_SCRIPT"
    fi
    
    log_success "Скрипт бэкапа найден: $BACKUP_SCRIPT"
    
    if [[ -f "$TEST_SCRIPT" ]]; then
        if [[ ! -x "$TEST_SCRIPT" ]]; then
            chmod +x "$TEST_SCRIPT"
        fi
        log_success "Скрипт проверки найден: $TEST_SCRIPT"
    else
        log_warning "Скрипт проверки не найден: $TEST_SCRIPT"
    fi
}

# Функция проверки сервиса cron
check_cron_service() {
    log_info "Проверка сервиса cron..."
    
    if systemctl is-active cron >/dev/null 2>&1; then
        log_success "Сервис cron активен"
    elif systemctl is-active crond >/dev/null 2>&1; then
        log_success "Сервис crond активен"
    else
        log_error "Сервис cron не активен"
        log_info "Запуск сервиса cron..."
        
        if command -v systemctl &>/dev/null; then
            systemctl enable cron 2>/dev/null || systemctl enable crond 2>/dev/null || true
            systemctl start cron 2>/dev/null || systemctl start crond 2>/dev/null || true
        fi
        
        sleep 2
        
        if systemctl is-active cron >/dev/null 2>&1 || systemctl is-active crond >/dev/null 2>&1; then
            log_success "Сервис cron успешно запущен"
        else
            log_error "Не удалось запустить сервис cron"
            exit 1
        fi
    fi
}

# Функция создания cron задач для пользователя
setup_user_cron() {
    log_info "Настройка cron задач для пользователя $BACKUP_USER..."
    
    # Получаем текущий crontab
    local current_cron=""
    if sudo -u "$BACKUP_USER" crontab -l 2>/dev/null; then
        current_cron=$(sudo -u "$BACKUP_USER" crontab -l 2>/dev/null)
    fi
    
    # Создаем временный файл с новыми задачами
    local temp_cron="/tmp/books_backup_cron_$$"
    
    {
        # Сохраняем существующие задачи (исключая наши)
        if [[ -n "$current_cron" ]]; then
            echo "$current_cron" | grep -v "backup_database.sh\|test_backup.sh\|# Books App Backup"
        fi
        
        echo ""
        echo "# Books App Backup Jobs - Created by setup_backup_cron.sh"
        echo "# Do not edit manually - use setup_backup_cron.sh to modify"
        echo ""
        
        # Ежедневные бэкапы
        local daily_hour=$(echo "$DAILY_TIME" | cut -d: -f1)
        local daily_minute=$(echo "$DAILY_TIME" | cut -d: -f2)
        echo "$daily_minute $daily_hour * * * $BACKUP_SCRIPT daily >/dev/null 2>&1"
        
        # Еженедельные бэкапы
        local weekly_hour=$(echo "$WEEKLY_TIME" | cut -d: -f1)
        local weekly_minute=$(echo "$WEEKLY_TIME" | cut -d: -f2)
        echo "$weekly_minute $weekly_hour * * $WEEKLY_DAY $BACKUP_SCRIPT weekly >/dev/null 2>&1"
        
        # Ежемесячные бэкапы
        local monthly_hour=$(echo "$MONTHLY_TIME" | cut -d: -f1)
        local monthly_minute=$(echo "$MONTHLY_TIME" | cut -d: -f2)
        echo "$monthly_minute $monthly_hour $MONTHLY_DAY * * $BACKUP_SCRIPT monthly >/dev/null 2>&1"
        
        # Проверка целостности (если скрипт существует)
        if [[ -f "$TEST_SCRIPT" ]]; then
            local test_hour=$(echo "$TEST_TIME" | cut -d: -f1)
            local test_minute=$(echo "$TEST_TIME" | cut -d: -f2)
            echo "$test_minute $test_hour * * 1 $TEST_SCRIPT >/dev/null 2>&1  # Weekly integrity check"
        fi
        
        echo ""
        
    } > "$temp_cron"
    
    # Применяем новый crontab
    if sudo -u "$BACKUP_USER" crontab "$temp_cron"; then
        log_success "Cron задачи успешно настроены для пользователя $BACKUP_USER"
    else
        log_error "Ошибка настройки cron задач"
        rm -f "$temp_cron"
        exit 1
    fi
    
    rm -f "$temp_cron"
}

# Функция создания системного cron файла (альтернативный метод)
setup_system_cron() {
    log_info "Настройка системного cron файла..."
    
    local system_cron="/etc/cron.d/books_backup"
    
    cat > "$system_cron" << EOF
# Books App Backup Schedule
# Created by setup_backup_cron.sh on $(date)

SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=${NOTIFICATION_EMAIL:-root}

# Daily backup at ${DAILY_TIME}
$(echo "$DAILY_TIME" | awk -F: '{print $2 " " $1}') * * * $BACKUP_USER $BACKUP_SCRIPT daily

# Weekly backup on $(case $WEEKLY_DAY in 0) echo "Sunday";; 1) echo "Monday";; 2) echo "Tuesday";; 3) echo "Wednesday";; 4) echo "Thursday";; 5) echo "Friday";; 6) echo "Saturday";; esac) at ${WEEKLY_TIME}
$(echo "$WEEKLY_TIME" | awk -F: '{print $2 " " $1}') * * $WEEKLY_DAY $BACKUP_USER $BACKUP_SCRIPT weekly

# Monthly backup on day ${MONTHLY_DAY} at ${MONTHLY_TIME}
$(echo "$MONTHLY_TIME" | awk -F: '{print $2 " " $1}') $MONTHLY_DAY * * $BACKUP_USER $BACKUP_SCRIPT monthly

EOF

    # Добавляем проверку целостности если скрипт существует
    if [[ -f "$TEST_SCRIPT" ]]; then
        cat >> "$system_cron" << EOF
# Weekly integrity check on Monday at ${TEST_TIME}
$(echo "$TEST_TIME" | awk -F: '{print $2 " " $1}') * * 1 $BACKUP_USER $TEST_SCRIPT

EOF
    fi
    
    # Устанавливаем правильные права
    chmod 644 "$system_cron"
    chown root:root "$system_cron"
    
    log_success "Системный cron файл создан: $system_cron"
}

# Функция создания скрипта для ручного тестирования
create_test_wrapper() {
    local test_wrapper="/opt/books/app/run_backup_test.sh"
    
    cat > "$test_wrapper" << 'EOF'
#!/bin/bash
# Manual backup test script
# Created by setup_backup_cron.sh

set -e

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Manual Backup Test ==="
echo "Date: $(date)"
echo

# Test backup script
if [[ -f "$PROJECT_DIR/scripts/backup_database.sh" ]]; then
    echo "Running backup test..."
    "$PROJECT_DIR/scripts/backup_database.sh" daily
    echo
fi

# Test integrity
if [[ -f "$PROJECT_DIR/scripts/test_backup.sh" ]]; then
    echo "Running integrity check..."
    "$PROJECT_DIR/scripts/test_backup.sh"
fi

echo "=== Test Complete ==="
EOF
    
    chmod +x "$test_wrapper"
    chown "$BACKUP_USER:$BACKUP_USER" "$test_wrapper" 2>/dev/null || true
    
    log_success "Скрипт ручного тестирования создан: $test_wrapper"
}

# Функция настройки переменных окружения
setup_environment() {
    log_info "Настройка переменных окружения для бэкапов..."
    
    local env_file="/opt/books/app/.env.backup"
    
    cat > "$env_file" << EOF
# Backup Environment Variables
# Created by setup_backup_cron.sh on $(date)

# Backup Configuration
BACKUP_DIR="/opt/books/backups"
BACKUP_RETENTION_DAYS=14
COMPRESS_BACKUPS=true
INCLUDE_UPLOADS=true
MIN_BACKUP_SIZE_MB=1

# PostgreSQL Configuration (adjust as needed)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=books
POSTGRES_USER=postgres
# POSTGRES_PASSWORD=your_password_here

# Docker Configuration
USE_DOCKER=auto

# Logging
LOG_LEVEL=INFO
EOF
    
    chmod 600 "$env_file"
    chown "$BACKUP_USER:$BACKUP_USER" "$env_file" 2>/dev/null || true
    
    log_success "Файл переменных окружения создан: $env_file"
    log_warning "Не забудьте настроить POSTGRES_PASSWORD в $env_file"
}

# Функция настройки логирования
setup_logging() {
    log_info "Настройка логирования бэкапов..."
    
    local logrotate_config="/etc/logrotate.d/books_backup"
    
    cat > "$logrotate_config" << EOF
/opt/books/backups/backup.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 $BACKUP_USER $BACKUP_USER
    postrotate
        # Signal processes if needed
    endscript
}

/opt/books/backups/*.txt {
    weekly
    missingok
    rotate 4
    compress
    delaycompress
    notifempty
    create 644 $BACKUP_USER $BACKUP_USER
}
EOF
    
    log_success "Настройка logrotate создана: $logrotate_config"
}

# Функция проверки настроек
verify_setup() {
    log_info "Проверка настроек бэкапов..."
    
    # Проверяем cron задачи
    if sudo -u "$BACKUP_USER" crontab -l 2>/dev/null | grep -q "backup_database.sh"; then
        log_success "Cron задачи настроены корректно"
        
        echo "Расписание бэкапов:"
        sudo -u "$BACKUP_USER" crontab -l 2>/dev/null | grep -E "backup_database.sh|test_backup.sh" | while read -r line; do
            log_info "  $line"
        done
    else
        log_warning "Cron задачи не найдены в crontab пользователя"
    fi
    
    # Проверяем системный cron файл
    if [[ -f "/etc/cron.d/books_backup" ]]; then
        log_success "Системный cron файл существует"
    fi
    
    # Проверяем права на директории
    if [[ -d "/opt/books/backups" ]]; then
        local backup_owner=$(stat -c %U "/opt/books/backups")
        if [[ "$backup_owner" == "$BACKUP_USER" ]]; then
            log_success "Права на директорию бэкапов корректны"
        else
            log_warning "Владелец директории бэкапов: $backup_owner (ожидается: $BACKUP_USER)"
        fi
    else
        log_warning "Директория бэкапов не существует (будет создана при первом запуске)"
    fi
}

# Функция показа статуса
show_status() {
    echo
    echo "=== Статус системы бэкапов ==="
    
    echo "Расписание:"
    echo "  Ежедневные бэкапы: каждый день в $DAILY_TIME"
    echo "  Еженедельные бэкапы: каждое $(case $WEEKLY_DAY in 0) echo "воскресенье";; 1) echo "понедельник";; 2) echo "вторник";; 3) echo "среду";; 4) echo "четверг";; 5) echo "пятницу";; 6) echo "субботу";; esac) в $WEEKLY_TIME"
    echo "  Ежемесячные бэкапы: ${MONTHLY_DAY}-го числа в $MONTHLY_TIME"
    if [[ -f "$TEST_SCRIPT" ]]; then
        echo "  Проверка целостности: каждый понедельник в $TEST_TIME"
    fi
    
    echo
    echo "Файлы конфигурации:"
    echo "  Скрипт бэкапа: $BACKUP_SCRIPT"
    if [[ -f "$TEST_SCRIPT" ]]; then
        echo "  Скрипт проверки: $TEST_SCRIPT"
    fi
    echo "  Переменные окружения: /opt/books/app/.env.backup"
    
    echo
    echo "Команды для управления:"
    echo "  Ручной бэкап: sudo -u $BACKUP_USER $BACKUP_SCRIPT"
    echo "  Проверка целостности: sudo -u $BACKUP_USER $TEST_SCRIPT"
    echo "  Просмотр cron задач: sudo -u $BACKUP_USER crontab -l"
    echo "  Логи бэкапов: tail -f /opt/books/backups/backup.log"
}

# Основная функция
main() {
    local setup_type="${1:-user}"
    
    log_info "=== Настройка автоматических бэкапов Books App ==="
    
    # Проверка прав root для системных настроек
    if [[ "$setup_type" == "system" && $EUID -ne 0 ]]; then
        log_error "Для системной настройки требуются права root"
        log_info "Запустите: sudo $0 system"
        exit 1
    fi
    
    # Основные проверки
    check_backup_user
    check_backup_scripts
    check_cron_service
    
    # Настройка в зависимости от типа
    if [[ "$setup_type" == "system" ]]; then
        setup_system_cron
        setup_logging
    else
        setup_user_cron
    fi
    
    # Дополнительные настройки
    setup_environment
    create_test_wrapper
    
    # Проверка результата
    verify_setup
    
    log_success "=== Настройка автоматических бэкапов завершена ==="
    
    show_status
    
    echo
    log_info "Следующие шаги:"
    echo "1. Проверьте и отредактируйте /opt/books/app/.env.backup"
    echo "2. Запустите тестовый бэкап: sudo -u $BACKUP_USER $BACKUP_SCRIPT"
    echo "3. Проверьте целостность: sudo -u $BACKUP_USER $TEST_SCRIPT"
    
    if [[ -n "$NOTIFICATION_EMAIL" ]]; then
        echo "4. Настройте почтовые уведомления для $NOTIFICATION_EMAIL"
    else
        echo "4. Рассмотрите настройку email уведомлений (NOTIFICATION_EMAIL)"
    fi
}

# Проверка аргументов и справка
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Использование: $0 [user|system]"
    echo
    echo "Типы установки:"
    echo "  user   - настройка через crontab пользователя (по умолчанию)"
    echo "  system - настройка через системный cron (требует root)"
    echo
    echo "Переменные окружения для настройки расписания:"
    echo "  DAILY_TIME         - время ежедневных бэкапов (02:00)"
    echo "  WEEKLY_DAY         - день недели для еженедельных (0=вс, 1=пн, ..., 6=сб)"
    echo "  WEEKLY_TIME        - время еженедельных бэкапов (03:00)" 
    echo "  MONTHLY_DAY        - день месяца для ежемесячных (1)"
    echo "  MONTHLY_TIME       - время ежемесячных бэкапов (04:00)"
    echo "  TEST_TIME          - время проверки целостности (06:00)"
    echo "  BACKUP_USER        - пользователь для выполнения бэкапов (deploy)"
    echo "  NOTIFICATION_EMAIL - email для уведомлений"
    echo
    echo "Примеры:"
    echo "  $0                                    # настройка для пользователя"
    echo "  sudo $0 system                       # системная настройка"
    echo "  DAILY_TIME=01:30 $0                  # ежедневные бэкапы в 1:30"
    echo "  NOTIFICATION_EMAIL=admin@example.com sudo $0 system"
    exit 0
fi

# Запуск основной функции
main "${1:-user}"
