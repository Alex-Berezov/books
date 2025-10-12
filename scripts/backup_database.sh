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
    echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# Конфигурация по умолчанию
BACKUP_DIR="/opt/books/backups"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPRESS_BACKUPS="${COMPRESS_BACKUPS:-true}"
BACKUP_PREFIX="${BACKUP_PREFIX:-books-db}"
LOG_FILE="${BACKUP_DIR}/backup.log"
UPLOADS_DIR="/opt/books/uploads"
INCLUDE_UPLOADS="${INCLUDE_UPLOADS:-true}"

# PostgreSQL настройки (могут быть переопределены через переменные окружения)
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-books}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# Настройки для Docker окружения
DOCKER_COMPOSE_FILE="${DOCKER_COMPOSE_FILE:-docker-compose.prod.yml}"
DOCKER_POSTGRES_SERVICE="${DOCKER_POSTGRES_SERVICE:-postgres}"
USE_DOCKER="${USE_DOCKER:-auto}"

# Функция для определения способа подключения к PostgreSQL
detect_postgres_connection() {
    if [[ "$USE_DOCKER" == "auto" ]]; then
        if docker ps --format "table {{.Names}}" | grep -q postgres; then
            USE_DOCKER="true"
            log_info "Обнаружен PostgreSQL в Docker контейнере"
        elif command -v psql &> /dev/null; then
            USE_DOCKER="false"
            log_info "Обнаружен локальный PostgreSQL"
        else
            log_error "PostgreSQL не найден ни локально, ни в Docker"
            exit 1
        fi
    fi
}

# Функция проверки подключения к БД
test_postgres_connection() {
    log_info "Проверка подключения к PostgreSQL..."
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        # Тест через Docker
        if docker exec "$(docker ps -qf name=postgres)" pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
            log_success "Подключение к PostgreSQL в Docker успешно"
            return 0
        else
            log_error "Не удается подключиться к PostgreSQL в Docker"
            return 1
        fi
    else
        # Тест локального подключения
        if PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" >/dev/null 2>&1; then
            log_success "Подключение к локальному PostgreSQL успешно"
            return 0
        else
            log_error "Не удается подключиться к локальному PostgreSQL"
            return 1
        fi
    fi
}

# Функция создания директорий
setup_backup_directories() {
    log_info "Создание директорий для бэкапов..."
    
    # Создаем основную директорию бэкапов
    mkdir -p "$BACKUP_DIR"
    
    # Создаем поддиректории по датам (для организации)
    mkdir -p "$BACKUP_DIR/daily"
    mkdir -p "$BACKUP_DIR/weekly"
    mkdir -p "$BACKUP_DIR/monthly"
    
    # Проверяем права доступа
    if [[ ! -w "$BACKUP_DIR" ]]; then
        log_error "Нет прав на запись в директорию бэкапов: $BACKUP_DIR"
        exit 1
    fi
    
    log_success "Директории бэкапов готовы"
}

# Функция создания бэкапа базы данных
backup_database() {
    local backup_type="${1:-daily}"
    local timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup_file="${BACKUP_DIR}/${backup_type}/${BACKUP_PREFIX}_${timestamp}.sql"
    
    log_info "Создание бэкапа базы данных (тип: $backup_type)..."
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        # Найти PostgreSQL контейнер
        local postgres_container=$(docker ps -qf name=postgres)
        
        if [[ -z "$postgres_container" ]]; then
            log_error "PostgreSQL контейнер не найден"
            return 1
        fi
        
        # Получить переменные окружения из контейнера
        local container_user=$(docker exec "$postgres_container" env | grep "^POSTGRES_USER=" | cut -d= -f2)
        local container_db=$(docker exec "$postgres_container" env | grep "^POSTGRES_DB=" | cut -d= -f2)
        
        # Использовать переменные из контейнера, если они не пусты
        local db_user="${container_user:-$POSTGRES_USER}"
        local db_name="${container_db:-$POSTGRES_DB}"
        
        log_info "Используем БД: $db_name, пользователь: $db_user"
        
        # Бэкап через Docker
        docker exec "$postgres_container" pg_dump \
            -h localhost \
            -p 5432 \
            -U "$db_user" \
            -d "$db_name" \
            --no-owner \
            --no-privileges \
            --verbose \
            > "$backup_file" 2>>"$LOG_FILE"
    else
        # Локальный бэкап
        PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
            -h "$POSTGRES_HOST" \
            -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            --no-owner \
            --no-privileges \
            --verbose \
            > "$backup_file" 2>>"$LOG_FILE"
    fi
    
    if [[ $? -eq 0 && -f "$backup_file" && -s "$backup_file" ]]; then
        log_success "Бэкап базы данных создан: $(basename "$backup_file")"
        
        # Сжатие бэкапа
        if [[ "$COMPRESS_BACKUPS" == "true" ]]; then
            log_info "Сжатие бэкапа..."
            gzip "$backup_file"
            backup_file="${backup_file}.gz"
            log_success "Бэкап сжат: $(basename "$backup_file")"
        fi
        
        # Проверка размера файла
        local file_size=$(du -h "$backup_file" | cut -f1)
        log_info "Размер бэкапа: $file_size"
        
        echo "$backup_file"
    else
        log_error "Ошибка создания бэкапа базы данных"
        return 1
    fi
}

# Функция создания бэкапа медиафайлов
backup_uploads() {
    local backup_type="${1:-daily}"
    local timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup_file="${BACKUP_DIR}/${backup_type}/uploads_${timestamp}.tar.gz"
    
    if [[ "$INCLUDE_UPLOADS" != "true" ]]; then
        log_info "Бэкап медиафайлов отключен"
        return 0
    fi
    
    if [[ ! -d "$UPLOADS_DIR" ]]; then
        log_warning "Директория uploads не найдена: $UPLOADS_DIR"
        return 0
    fi
    
    log_info "Создание бэкапа медиафайлов..."
    
    # Подсчет файлов для бэкапа
    local file_count=$(find "$UPLOADS_DIR" -type f | wc -l)
    log_info "Найдено файлов для бэкапа: $file_count"
    
    if [[ $file_count -eq 0 ]]; then
        log_warning "Нет файлов для бэкапа в $UPLOADS_DIR"
        return 0
    fi
    
    # Создание архива
    tar -czf "$backup_file" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" 2>>"$LOG_FILE"
    
    if [[ $? -eq 0 && -f "$backup_file" ]]; then
        local file_size=$(du -h "$backup_file" | cut -f1)
        log_success "Бэкап медиафайлов создан: $(basename "$backup_file") (размер: $file_size)"
        echo "$backup_file"
    else
        log_error "Ошибка создания бэкапа медиафайлов"
        return 1
    fi
}

# Функция ротации старых бэкапов
cleanup_old_backups() {
    local backup_type="${1:-daily}"
    local retention_days="$BACKUP_RETENTION_DAYS"
    
    log_info "Очистка старых бэкапов (старше $retention_days дней)..."
    
    local cleanup_dir="${BACKUP_DIR}/${backup_type}"
    local deleted_count=0
    
    if [[ -d "$cleanup_dir" ]]; then
        # Удаляем файлы старше указанного количества дней
        while IFS= read -r -d '' file; do
            rm "$file"
            ((deleted_count++))
            log_info "Удален старый бэкап: $(basename "$file")"
        done < <(find "$cleanup_dir" -type f \( -name "*.sql" -o -name "*.sql.gz" -o -name "*.tar.gz" \) -mtime +$retention_days -print0 2>/dev/null)
    fi
    
    if [[ $deleted_count -gt 0 ]]; then
        log_success "Удалено старых бэкапов: $deleted_count"
    else
        log_info "Старые бэкапы не найдены"
    fi
}

# Функция генерации отчета
generate_backup_report() {
    local db_backup_file="$1"
    local uploads_backup_file="$2"
    local backup_type="${3:-daily}"
    
    log_info "Генерация отчета о бэкапе..."
    
    local report_file="${BACKUP_DIR}/backup_report_$(date '+%Y%m%d_%H%M%S').txt"
    
    {
        echo "=== Отчет о создании бэкапа ==="
        echo "Дата и время: $(date)"
        echo "Тип бэкапа: $backup_type"
        echo "Хост: $(hostname)"
        echo ""
        
        echo "=== База данных ==="
        if [[ -n "$db_backup_file" && -f "$db_backup_file" ]]; then
            echo "Файл: $(basename "$db_backup_file")"
            echo "Размер: $(du -h "$db_backup_file" | cut -f1)"
            echo "Путь: $db_backup_file"
            echo "Статус: Успешно"
        else
            echo "Статус: Ошибка"
        fi
        echo ""
        
        echo "=== Медиафайлы ==="
        if [[ "$INCLUDE_UPLOADS" == "true" ]]; then
            if [[ -n "$uploads_backup_file" && -f "$uploads_backup_file" ]]; then
                echo "Файл: $(basename "$uploads_backup_file")"
                echo "Размер: $(du -h "$uploads_backup_file" | cut -f1)"
                echo "Путь: $uploads_backup_file"
                echo "Статус: Успешно"
            else
                echo "Статус: Ошибка или нет файлов"
            fi
        else
            echo "Статус: Отключено"
        fi
        echo ""
        
        echo "=== Конфигурация ==="
        echo "Retention: $BACKUP_RETENTION_DAYS дней"
        echo "Сжатие: $COMPRESS_BACKUPS"
        echo "PostgreSQL: $POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
        echo "Метод подключения: $([ "$USE_DOCKER" == "true" ] && echo "Docker" || echo "Локально")"
    } > "$report_file"
    
    log_success "Отчет создан: $(basename "$report_file")"
    
    # Выводим краткий отчет в консоль
    echo ""
    echo "=== ИТОГОВЫЙ ОТЧЕТ ==="
    if [[ -n "$db_backup_file" && -f "$db_backup_file" ]]; then
        echo -e "${GREEN}✓${NC} База данных: $(basename "$db_backup_file") ($(du -h "$db_backup_file" | cut -f1))"
    else
        echo -e "${RED}✗${NC} База данных: Ошибка"
    fi
    
    if [[ "$INCLUDE_UPLOADS" == "true" ]]; then
        if [[ -n "$uploads_backup_file" && -f "$uploads_backup_file" ]]; then
            echo -e "${GREEN}✓${NC} Медиафайлы: $(basename "$uploads_backup_file") ($(du -h "$uploads_backup_file" | cut -f1))"
        else
            echo -e "${YELLOW}!${NC} Медиафайлы: Пропущено или ошибка"
        fi
    fi
}

# Основная функция
main() {
    local backup_type="${1:-daily}"
    
    # Инициализация логирования
    mkdir -p "$(dirname "$LOG_FILE")"
    
    {
        echo "=== Начало создания бэкапа ==="
        echo "Дата: $(date)"
        echo "Тип: $backup_type"
        echo "PID: $$"
    } >> "$LOG_FILE"
    
    log_info "=== Создание бэкапа Books App (тип: $backup_type) ==="
    
    # Проверки и подготовка
    detect_postgres_connection
    
    if ! test_postgres_connection; then
        log_error "Не удается подключиться к PostgreSQL"
        exit 1
    fi
    
    setup_backup_directories
    
    # Создание бэкапов
    local db_backup_file=""
    local uploads_backup_file=""
    
    # Бэкап базы данных
    if db_backup_file=$(backup_database "$backup_type"); then
        log_success "Бэкап базы данных завершен"
    else
        log_error "Ошибка создания бэкапа базы данных"
        exit 1
    fi
    
    # Бэкап медиафайлов
    if uploads_backup_file=$(backup_uploads "$backup_type"); then
        log_success "Бэкап медиафайлов завершен"
    fi
    
    # Очистка старых бэкапов
    cleanup_old_backups "$backup_type"
    
    # Генерация отчета
    generate_backup_report "$db_backup_file" "$uploads_backup_file" "$backup_type"
    
    log_success "=== Создание бэкапа завершено успешно ==="
    
    {
        echo "=== Конец создания бэкапа ==="
        echo "Статус: Успешно"
        echo "Дата окончания: $(date)"
        echo ""
    } >> "$LOG_FILE"
}

# Проверка аргументов и справка
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Использование: $0 [тип_бэкапа]"
    echo
    echo "Типы бэкапов:"
    echo "  daily   - ежедневный бэкап (по умолчанию)"
    echo "  weekly  - еженедельный бэкап"  
    echo "  monthly - ежемесячный бэкап"
    echo
    echo "Переменные окружения:"
    echo "  BACKUP_DIR              - директория бэкапов (/opt/books/backups)"
    echo "  BACKUP_RETENTION_DAYS   - срок хранения в днях (14)"
    echo "  COMPRESS_BACKUPS        - сжимать бэкапы (true/false)"
    echo "  INCLUDE_UPLOADS         - включать медиафайлы (true/false)"
    echo "  USE_DOCKER              - использовать Docker (true/false/auto)"
    echo "  POSTGRES_HOST           - хост PostgreSQL (localhost)"
    echo "  POSTGRES_PORT           - порт PostgreSQL (5432)"
    echo "  POSTGRES_DB             - имя БД (books)"
    echo "  POSTGRES_USER           - пользователь PostgreSQL (postgres)"
    echo "  POSTGRES_PASSWORD       - пароль PostgreSQL"
    echo
    echo "Примеры:"
    echo "  $0                      # ежедневный бэкап"
    echo "  $0 weekly               # еженедельный бэкап"
    echo "  INCLUDE_UPLOADS=false $0  # без медиафайлов"
    exit 0
fi

# Запуск основной функции
main "${1:-daily}"
