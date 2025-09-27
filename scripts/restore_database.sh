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
UPLOADS_DIR="/opt/books/uploads"

# PostgreSQL настройки
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-books}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# Настройки для Docker окружения
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
        if docker exec "$(docker ps -qf name=postgres)" pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
            log_success "Подключение к PostgreSQL в Docker успешно"
            return 0
        else
            log_error "Не удается подключиться к PostgreSQL в Docker"
            return 1
        fi
    else
        if PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" >/dev/null 2>&1; then
            log_success "Подключение к локальному PostgreSQL успешно"
            return 0
        else
            log_error "Не удается подключиться к локальному PostgreSQL"
            return 1
        fi
    fi
}

# Функция поиска бэкапов
list_available_backups() {
    local backup_type="${1:-all}"
    
    log_info "Поиск доступных бэкапов..."
    
    local search_dirs=()
    if [[ "$backup_type" == "all" ]]; then
        search_dirs=("$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly")
    else
        search_dirs=("$BACKUP_DIR/$backup_type")
    fi
    
    local backups=()
    for dir in "${search_dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            while IFS= read -r -d '' file; do
                backups+=("$file")
            done < <(find "$dir" -name "books-db_*.sql*" -type f -print0 | sort -z)
        fi
    done
    
    if [[ ${#backups[@]} -eq 0 ]]; then
        log_warning "Бэкапы не найдены"
        return 1
    fi
    
    echo "Доступные бэкапы:"
    for i in "${!backups[@]}"; do
        local backup_file="${backups[$i]}"
        local backup_date=$(basename "$backup_file" | sed 's/books-db_//' | sed 's/.sql.*//' | sed 's/_/ /')
        local backup_size=$(du -h "$backup_file" | cut -f1)
        local backup_age=$(find "$backup_file" -mtime +0 -printf "%Cr\n" 2>/dev/null || stat -c %y "$backup_file")
        
        echo "$((i+1)). $(basename "$backup_file") (размер: $backup_size, создан: $backup_age)"
    done
    
    printf '%s\n' "${backups[@]}"
}

# Функция выбора бэкапа
select_backup() {
    local backup_type="${1:-all}"
    
    readarray -t available_backups < <(list_available_backups "$backup_type")
    
    if [[ ${#available_backups[@]} -eq 0 ]]; then
        return 1
    fi
    
    echo
    read -p "Выберите номер бэкапа для восстановления (1-${#available_backups[@]}): " selection
    
    if [[ ! "$selection" =~ ^[0-9]+$ ]] || [[ $selection -lt 1 ]] || [[ $selection -gt ${#available_backups[@]} ]]; then
        log_error "Неверный выбор"
        return 1
    fi
    
    echo "${available_backups[$((selection-1))]}"
}

# Функция подготовки бэкапа (распаковка если нужно)
prepare_backup_file() {
    local backup_file="$1"
    
    if [[ ! -f "$backup_file" ]]; then
        log_error "Файл бэкапа не найден: $backup_file"
        return 1
    fi
    
    # Проверяем, нужно ли распаковать файл
    if [[ "$backup_file" == *.gz ]]; then
        log_info "Распаковка сжатого бэкапа..."
        local temp_file="/tmp/restore_$(basename "$backup_file" .gz)"
        
        if ! gunzip -c "$backup_file" > "$temp_file"; then
            log_error "Ошибка распаковки бэкапа"
            return 1
        fi
        
        echo "$temp_file"
    else
        echo "$backup_file"
    fi
}

# Функция создания резервной копии текущей БД
backup_current_database() {
    log_info "Создание резервной копии текущей базы данных..."
    
    local timestamp=$(date '+%Y%m%d_%H%M%S')
    local backup_file="/tmp/pre_restore_backup_${timestamp}.sql"
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        docker exec "$(docker ps -qf name=postgres)" pg_dump \
            -h localhost \
            -p 5432 \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            --no-owner \
            --no-privileges \
            > "$backup_file" 2>/dev/null
    else
        PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
            -h "$POSTGRES_HOST" \
            -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            --no-owner \
            --no-privileges \
            > "$backup_file" 2>/dev/null
    fi
    
    if [[ -f "$backup_file" && -s "$backup_file" ]]; then
        log_success "Резервная копия создана: $backup_file"
        echo "$backup_file"
    else
        log_warning "Не удалось создать резервную копию (возможно, БД пуста)"
        echo ""
    fi
}

# Функция восстановления базы данных
restore_database() {
    local backup_file="$1"
    local confirm_restore="${2:-false}"
    
    log_info "Восстановление базы данных из: $(basename "$backup_file")"
    
    # Подтверждение восстановления
    if [[ "$confirm_restore" != "true" ]]; then
        echo
        log_warning "ВНИМАНИЕ: Восстановление полностью заменит текущую базу данных!"
        read -p "Вы уверены, что хотите продолжить? (yes/no): " confirmation
        
        if [[ "$confirmation" != "yes" ]]; then
            log_info "Восстановление отменено пользователем"
            exit 0
        fi
    fi
    
    # Создание резервной копии текущей БД
    local current_backup
    current_backup=$(backup_current_database)
    
    # Остановка приложения (если запущено)
    if docker ps --format "table {{.Names}}" | grep -q books-app; then
        log_info "Остановка приложения для восстановления..."
        docker stop books-app 2>/dev/null || true
    fi
    
    # Подготовка бэкапа
    local restore_file
    if ! restore_file=$(prepare_backup_file "$backup_file"); then
        log_error "Не удалось подготовить файл бэкапа"
        exit 1
    fi
    
    log_info "Начало восстановления базы данных..."
    
    # Восстановление
    local restore_success=false
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        # Восстановление через Docker
        if docker exec -i "$(docker ps -qf name=postgres)" psql \
            -h localhost \
            -p 5432 \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            < "$restore_file" >/dev/null 2>&1; then
            restore_success=true
        fi
    else
        # Локальное восстановление
        if PGPASSWORD="$POSTGRES_PASSWORD" psql \
            -h "$POSTGRES_HOST" \
            -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            < "$restore_file" >/dev/null 2>&1; then
            restore_success=true
        fi
    fi
    
    # Очистка временного файла
    if [[ "$restore_file" == /tmp/* ]]; then
        rm -f "$restore_file"
    fi
    
    if [[ "$restore_success" == "true" ]]; then
        log_success "База данных успешно восстановлена!"
        
        # Запуск приложения обратно
        if docker ps -a --format "table {{.Names}}" | grep -q books-app; then
            log_info "Запуск приложения..."
            docker start books-app 2>/dev/null || true
        fi
        
        if [[ -n "$current_backup" ]]; then
            log_info "Резервная копия до восстановления сохранена в: $current_backup"
        fi
        
        return 0
    else
        log_error "Ошибка восстановления базы данных!"
        
        # Попытка восстановить предыдущее состояние
        if [[ -n "$current_backup" && -f "$current_backup" ]]; then
            log_info "Попытка восстановить предыдущее состояние..."
            if [[ "$USE_DOCKER" == "true" ]]; then
                docker exec -i "$(docker ps -qf name=postgres)" psql \
                    -h localhost \
                    -p 5432 \
                    -U "$POSTGRES_USER" \
                    -d "$POSTGRES_DB" \
                    < "$current_backup" >/dev/null 2>&1
            else
                PGPASSWORD="$POSTGRES_PASSWORD" psql \
                    -h "$POSTGRES_HOST" \
                    -p "$POSTGRES_PORT" \
                    -U "$POSTGRES_USER" \
                    -d "$POSTGRES_DB" \
                    < "$current_backup" >/dev/null 2>&1
            fi
            log_warning "Предыдущее состояние восстановлено"
        fi
        
        return 1
    fi
}

# Функция восстановления медиафайлов
restore_uploads() {
    local uploads_backup="$1"
    
    if [[ ! -f "$uploads_backup" ]]; then
        log_warning "Бэкап медиафайлов не найден: $uploads_backup"
        return 0
    fi
    
    log_info "Восстановление медиафайлов из: $(basename "$uploads_backup")"
    
    # Создание резервной копии текущих uploads
    if [[ -d "$UPLOADS_DIR" && "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
        local timestamp=$(date '+%Y%m%d_%H%M%S')
        local backup_current_uploads="/tmp/uploads_backup_${timestamp}.tar.gz"
        
        tar -czf "$backup_current_uploads" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" 2>/dev/null
        log_info "Текущие медиафайлы сохранены в: $backup_current_uploads"
    fi
    
    # Восстановление медиафайлов
    if tar -xzf "$uploads_backup" -C "$(dirname "$UPLOADS_DIR")" 2>/dev/null; then
        log_success "Медиафайлы успешно восстановлены"
        
        # Установка правильных прав
        chown -R deploy:deploy "$UPLOADS_DIR" 2>/dev/null || true
        chmod -R 755 "$UPLOADS_DIR" 2>/dev/null || true
        
        return 0
    else
        log_error "Ошибка восстановления медиафайлов"
        return 1
    fi
}

# Функция проверки целостности после восстановления
verify_restore() {
    log_info "Проверка целостности восстановленной базы данных..."
    
    local table_count=0
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        table_count=$(docker exec "$(docker ps -qf name=postgres)" psql \
            -h localhost \
            -p 5432 \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')
    else
        table_count=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
            -h "$POSTGRES_HOST" \
            -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')
    fi
    
    if [[ "$table_count" -gt 0 ]]; then
        log_success "Проверка целостности пройдена (найдено таблиц: $table_count)"
        return 0
    else
        log_error "Проверка целостности не пройдена"
        return 1
    fi
}

# Основная функция
main() {
    local backup_file="${1:-}"
    local backup_type="${2:-all}"
    local auto_confirm="${3:-false}"
    
    log_info "=== Восстановление Books App из бэкапа ==="
    
    # Проверки и подготовка
    detect_postgres_connection
    
    if ! test_postgres_connection; then
        log_error "Не удается подключиться к PostgreSQL"
        exit 1
    fi
    
    # Выбор файла бэкапа
    if [[ -z "$backup_file" ]]; then
        if ! backup_file=$(select_backup "$backup_type"); then
            log_error "Не удалось выбрать файл бэкапа"
            exit 1
        fi
    elif [[ ! -f "$backup_file" ]]; then
        log_error "Указанный файл бэкапа не найден: $backup_file"
        exit 1
    fi
    
    log_info "Выбран бэкап: $(basename "$backup_file")"
    
    # Восстановление базы данных
    if ! restore_database "$backup_file" "$auto_confirm"; then
        log_error "Не удалось восстановить базу данных"
        exit 1
    fi
    
    # Поиск и восстановление медиафайлов
    local uploads_backup_file
    local backup_basename=$(basename "$backup_file" | sed 's/books-db_/uploads_/' | sed 's/.sql.*/.tar.gz/')
    local backup_dir=$(dirname "$backup_file")
    uploads_backup_file="${backup_dir}/${backup_basename}"
    
    restore_uploads "$uploads_backup_file"
    
    # Проверка целостности
    if verify_restore; then
        log_success "=== Восстановление завершено успешно ==="
    else
        log_error "=== Восстановление завершено с ошибками ==="
        exit 1
    fi
}

# Проверка аргументов и справка
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Использование: $0 [файл_бэкапа] [тип_бэкапа] [auto_confirm]"
    echo
    echo "Параметры:"
    echo "  файл_бэкапа   - путь к файлу бэкапа (если не указан, будет предложен выбор)"
    echo "  тип_бэкапа    - тип бэкапов для поиска (daily/weekly/monthly/all)"
    echo "  auto_confirm  - автоматическое подтверждение (true/false)"
    echo
    echo "Переменные окружения:"
    echo "  USE_DOCKER        - использовать Docker (true/false/auto)"
    echo "  POSTGRES_HOST     - хост PostgreSQL (localhost)"
    echo "  POSTGRES_PORT     - порт PostgreSQL (5432)"
    echo "  POSTGRES_DB       - имя БД (books)"
    echo "  POSTGRES_USER     - пользователь PostgreSQL (postgres)"
    echo "  POSTGRES_PASSWORD - пароль PostgreSQL"
    echo
    echo "Примеры:"
    echo "  $0                                    # интерактивный выбор"
    echo "  $0 /path/to/backup.sql.gz            # восстановление конкретного файла"
    echo "  $0 '' daily                          # выбор из ежедневных бэкапов"
    echo "  $0 /path/to/backup.sql.gz '' true    # автоматическое подтверждение"
    echo
    echo "ВНИМАНИЕ: Восстановление полностью заменит текущую базу данных!"
    exit 0
fi

# Запуск основной функции
main "$@"
