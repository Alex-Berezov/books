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
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

# Счетчики
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_WARNING=0

# Конфигурация
BACKUP_DIR="/opt/books/backups"
MIN_BACKUP_SIZE_MB="${MIN_BACKUP_SIZE_MB:-1}"
MAX_BACKUP_AGE_DAYS="${MAX_BACKUP_AGE_DAYS:-7}"

# Функция увеличения счетчиков
pass_test() {
    log_success "$1"
    ((TESTS_PASSED++))
}

fail_test() {
    log_error "$1"
    ((TESTS_FAILED++))
}

warn_test() {
    log_warning "$1"
    ((TESTS_WARNING++))
}

# Проверка существования директорий бэкапов
check_backup_directories() {
    log_info "Проверка директорий бэкапов..."
    
    if [[ -d "$BACKUP_DIR" ]]; then
        pass_test "Основная директория бэкапов существует: $BACKUP_DIR"
    else
        fail_test "Основная директория бэкапов не найдена: $BACKUP_DIR"
        return
    fi
    
    for subdir in daily weekly monthly; do
        local dir_path="$BACKUP_DIR/$subdir"
        if [[ -d "$dir_path" ]]; then
            pass_test "Поддиректория $subdir существует"
        else
            warn_test "Поддиректория $subdir не найдена (будет создана при первом бэкапе)"
        fi
    done
    
    # Проверка прав доступа
    if [[ -w "$BACKUP_DIR" ]]; then
        pass_test "Права на запись в директорию бэкапов есть"
    else
        fail_test "Нет прав на запись в директорию бэкапов"
    fi
}

# Проверка наличия бэкапов
check_backup_files() {
    log_info "Проверка файлов бэкапов..."
    
    local total_backups=0
    local total_size=0
    
    for backup_type in daily weekly monthly; do
        local dir_path="$BACKUP_DIR/$backup_type"
        local backup_count=0
        local dir_size=0
        
        if [[ -d "$dir_path" ]]; then
            # Подсчет бэкапов БД
            while IFS= read -r -d '' file; do
                ((backup_count++))
                ((total_backups++))
                local file_size=$(du -b "$file" | cut -f1)
                dir_size=$((dir_size + file_size))
                total_size=$((total_size + file_size))
            done < <(find "$dir_path" -name "books-db_*.sql*" -type f -print0 2>/dev/null)
        fi
        
        if [[ $backup_count -gt 0 ]]; then
            local dir_size_mb=$((dir_size / 1024 / 1024))
            pass_test "Найдено бэкапов типа $backup_type: $backup_count (размер: ${dir_size_mb}MB)"
        else
            warn_test "Бэкапы типа $backup_type не найдены"
        fi
    done
    
    if [[ $total_backups -gt 0 ]]; then
        local total_size_mb=$((total_size / 1024 / 1024))
        pass_test "Общее количество бэкапов: $total_backups (общий размер: ${total_size_mb}MB)"
    else
        fail_test "Бэкапы не найдены"
    fi
}

# Проверка актуальности бэкапов
check_backup_freshness() {
    log_info "Проверка актуальности бэкапов..."
    
    local latest_backup=""
    local latest_timestamp=0
    
    # Поиск самого свежего бэкапа
    while IFS= read -r -d '' file; do
        local file_timestamp=$(stat -c %Y "$file" 2>/dev/null)
        if [[ $file_timestamp -gt $latest_timestamp ]]; then
            latest_timestamp=$file_timestamp
            latest_backup=$file
        fi
    done < <(find "$BACKUP_DIR" -name "books-db_*.sql*" -type f -print0 2>/dev/null)
    
    if [[ -n "$latest_backup" ]]; then
        local backup_age_seconds=$(($(date +%s) - latest_timestamp))
        local backup_age_days=$((backup_age_seconds / 86400))
        local backup_date=$(date -d "@$latest_timestamp" '+%Y-%m-%d %H:%M:%S')
        
        pass_test "Последний бэкап: $(basename "$latest_backup")"
        log_info "Дата создания: $backup_date (возраст: $backup_age_days дней)"
        
        if [[ $backup_age_days -le $MAX_BACKUP_AGE_DAYS ]]; then
            pass_test "Бэкап актуален (возраст $backup_age_days дней <= $MAX_BACKUP_AGE_DAYS дней)"
        else
            fail_test "Бэкап устарел (возраст $backup_age_days дней > $MAX_BACKUP_AGE_DAYS дней)"
        fi
    else
        fail_test "Бэкапы не найдены для проверки актуальности"
    fi
}

# Проверка размеров бэкапов
check_backup_sizes() {
    log_info "Проверка размеров бэкапов..."
    
    local min_size_bytes=$((MIN_BACKUP_SIZE_MB * 1024 * 1024))
    local small_backups=0
    
    while IFS= read -r -d '' file; do
        local file_size=$(du -b "$file" | cut -f1)
        local file_size_mb=$((file_size / 1024 / 1024))
        
        if [[ $file_size -ge $min_size_bytes ]]; then
            pass_test "$(basename "$file"): размер OK (${file_size_mb}MB)"
        else
            fail_test "$(basename "$file"): подозрительно маленький размер (${file_size_mb}MB < ${MIN_BACKUP_SIZE_MB}MB)"
            ((small_backups++))
        fi
    done < <(find "$BACKUP_DIR" -name "books-db_*.sql*" -type f -print0 2>/dev/null)
    
    if [[ $small_backups -eq 0 ]]; then
        pass_test "Все бэкапы имеют нормальный размер"
    fi
}

# Проверка целостности сжатых файлов
check_compressed_integrity() {
    log_info "Проверка целостности сжатых бэкапов..."
    
    local corrupted_backups=0
    
    while IFS= read -r -d '' file; do
        if gzip -t "$file" 2>/dev/null; then
            pass_test "$(basename "$file"): сжатие корректно"
        else
            fail_test "$(basename "$file"): поврежденный архив"
            ((corrupted_backups++))
        fi
    done < <(find "$BACKUP_DIR" -name "*.gz" -type f -print0 2>/dev/null)
    
    if [[ $corrupted_backups -eq 0 ]]; then
        pass_test "Все сжатые бэкапы целостны"
    fi
}

# Проверка структуры SQL бэкапов
check_sql_structure() {
    log_info "Проверка структуры SQL бэкапов..."
    
    # Найдем один из последних бэкапов для проверки
    local test_backup=""
    test_backup=$(find "$BACKUP_DIR" -name "books-db_*.sql*" -type f -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
    
    if [[ -z "$test_backup" ]]; then
        warn_test "Нет бэкапов для проверки структуры"
        return
    fi
    
    log_info "Проверка структуры: $(basename "$test_backup")"
    
    # Подготавливаем файл для анализа
    local sql_content=""
    if [[ "$test_backup" == *.gz ]]; then
        sql_content=$(gunzip -c "$test_backup" | head -50)
    else
        sql_content=$(head -50 "$test_backup")
    fi
    
    # Проверяем наличие ключевых элементов
    if echo "$sql_content" | grep -q "PostgreSQL database dump"; then
        pass_test "SQL бэкап содержит заголовок PostgreSQL"
    else
        warn_test "SQL бэкап может быть поврежден (нет заголовка PostgreSQL)"
    fi
    
    if echo "$sql_content" | grep -q "CREATE TABLE\|DROP TABLE"; then
        pass_test "SQL бэкап содержит DDL команды"
    else
        warn_test "SQL бэкап может не содержать структуру таблиц"
    fi
    
    # Проверка на наличие основных таблиц проекта
    local full_content=""
    if [[ "$test_backup" == *.gz ]]; then
        full_content=$(gunzip -c "$test_backup")
    else
        full_content=$(cat "$test_backup")
    fi
    
    local expected_tables=("User" "Book" "BookVersion" "Category" "Page" "_prisma_migrations")
    local found_tables=0
    
    for table in "${expected_tables[@]}"; do
        if echo "$full_content" | grep -q "CREATE TABLE.*\"$table\""; then
            ((found_tables++))
        fi
    done
    
    if [[ $found_tables -ge 3 ]]; then
        pass_test "SQL бэкап содержит основные таблицы проекта ($found_tables/${#expected_tables[@]})"
    else
        fail_test "SQL бэкап содержит мало таблиц проекта ($found_tables/${#expected_tables[@]})"
    fi
}

# Проверка бэкапов медиафайлов
check_uploads_backups() {
    log_info "Проверка бэкапов медиафайлов..."
    
    local uploads_count=0
    
    while IFS= read -r -d '' file; do
        ((uploads_count++))
        
        # Проверка целостности архива
        if tar -tzf "$file" >/dev/null 2>&1; then
            pass_test "$(basename "$file"): архив медиафайлов корректен"
        else
            fail_test "$(basename "$file"): поврежденный архив медиафайлов"
        fi
        
        # Проверка содержимого архива
        local files_in_archive=$(tar -tzf "$file" 2>/dev/null | wc -l)
        if [[ $files_in_archive -gt 0 ]]; then
            pass_test "$(basename "$file"): содержит $files_in_archive файлов"
        else
            warn_test "$(basename "$file"): архив пустой или поврежден"
        fi
        
    done < <(find "$BACKUP_DIR" -name "uploads_*.tar.gz" -type f -print0 2>/dev/null)
    
    if [[ $uploads_count -eq 0 ]]; then
        warn_test "Бэкапы медиафайлов не найдены (может быть отключено)"
    else
        pass_test "Найдено бэкапов медиафайлов: $uploads_count"
    fi
}

# Проверка логов бэкапов
check_backup_logs() {
    log_info "Проверка логов бэкапов..."
    
    local log_file="$BACKUP_DIR/backup.log"
    
    if [[ -f "$log_file" ]]; then
        pass_test "Лог-файл бэкапов существует"
        
        local log_size=$(du -h "$log_file" | cut -f1)
        log_info "Размер лог-файла: $log_size"
        
        # Проверка последних записей
        local recent_entries=$(tail -10 "$log_file" | grep -c "$(date '+%Y-%m-%d')" || true)
        if [[ $recent_entries -gt 0 ]]; then
            pass_test "Лог содержит записи за сегодня: $recent_entries"
        else
            warn_test "Нет записей в логе за сегодня"
        fi
        
        # Проверка на ошибки в логах
        local error_count=$(grep -c "ERROR\|FAIL" "$log_file" || true)
        if [[ $error_count -eq 0 ]]; then
            pass_test "В логах нет записей об ошибках"
        else
            warn_test "Найдено записей об ошибках в логе: $error_count"
        fi
    else
        warn_test "Лог-файл бэкапов не найден: $log_file"
    fi
}

# Проверка дискового пространства
check_disk_space() {
    log_info "Проверка дискового пространства..."
    
    local backup_fs=$(df "$BACKUP_DIR" | tail -1)
    local available_space=$(echo "$backup_fs" | awk '{print $4}')
    local available_gb=$((available_space / 1024 / 1024))
    local used_percent=$(echo "$backup_fs" | awk '{print $5}' | tr -d '%')
    
    log_info "Доступно места: ${available_gb}GB (использовано: ${used_percent}%)"
    
    if [[ $used_percent -lt 80 ]]; then
        pass_test "Достаточно свободного места (использовано ${used_percent}% < 80%)"
    elif [[ $used_percent -lt 90 ]]; then
        warn_test "Мало свободного места (использовано ${used_percent}%)"
    else
        fail_test "Критически мало места (использовано ${used_percent}% >= 90%)"
    fi
    
    if [[ $available_gb -gt 1 ]]; then
        pass_test "Достаточно места для новых бэкапов (${available_gb}GB)"
    else
        fail_test "Недостаточно места для новых бэкапов (${available_gb}GB < 1GB)"
    fi
}

# Проверка расписания бэкапов (cron)
check_backup_schedule() {
    log_info "Проверка расписания бэкапов..."
    
    # Проверка cron задач для текущего пользователя
    if crontab -l 2>/dev/null | grep -q "backup_database.sh"; then
        pass_test "Найдена cron задача для бэкапов пользователя"
    else
        warn_test "Не найдена cron задача для бэкапов пользователя"
    fi
    
    # Проверка системных cron задач
    if [[ -f "/etc/cron.d/books_backup" ]] || ls /etc/cron.*/*books* >/dev/null 2>&1; then
        pass_test "Найдена системная cron задача для бэкапов"
    else
        warn_test "Не найдена системная cron задача для бэкапов"
    fi
    
    # Проверка сервиса cron
    if systemctl is-active cron >/dev/null 2>&1 || systemctl is-active crond >/dev/null 2>&1; then
        pass_test "Сервис cron активен"
    else
        fail_test "Сервис cron неактивен"
    fi
}

# Генерация отчета
generate_report() {
    local report_file="$BACKUP_DIR/integrity_report_$(date '+%Y%m%d_%H%M%S').txt"
    
    {
        echo "=== Отчет о проверке целостности бэкапов ==="
        echo "Дата проверки: $(date)"
        echo "Сервер: $(hostname)"
        echo ""
        echo "=== Результаты ==="
        echo "Тесты пройдены: $TESTS_PASSED"
        echo "Предупреждения: $TESTS_WARNING"
        echo "Ошибки: $TESTS_FAILED"
        echo ""
        echo "=== Статистика бэкапов ==="
        
        # Статистика по каждому типу
        for backup_type in daily weekly monthly; do
            local dir_path="$BACKUP_DIR/$backup_type"
            if [[ -d "$dir_path" ]]; then
                local count=$(find "$dir_path" -name "books-db_*.sql*" -type f | wc -l)
                local size=$(du -sh "$dir_path" 2>/dev/null | cut -f1 || echo "0")
                echo "$backup_type: $count бэкапов, размер: $size"
            fi
        done
        
        echo ""
        echo "=== Рекомендации ==="
        if [[ $TESTS_FAILED -gt 0 ]]; then
            echo "- Устраните критические ошибки немедленно"
            echo "- Проверьте поврежденные бэкапы"
            echo "- Убедитесь в наличии свободного места"
        fi
        
        if [[ $TESTS_WARNING -gt 0 ]]; then
            echo "- Обратите внимание на предупреждения"
            echo "- Рассмотрите настройку автоматических бэкапов"
            echo "- Проверьте актуальность бэкапов"
        fi
        
        if [[ $TESTS_FAILED -eq 0 && $TESTS_WARNING -eq 0 ]]; then
            echo "- Система бэкапов работает корректно"
            echo "- Продолжайте регулярные проверки"
        fi
        
    } > "$report_file"
    
    log_info "Подробный отчет сохранен: $(basename "$report_file")"
}

# Основная функция
main() {
    echo "=== Проверка целостности бэкапов Books App ==="
    echo "Дата проверки: $(date)"
    echo "Директория бэкапов: $BACKUP_DIR"
    echo

    # Выполнение всех проверок
    check_backup_directories
    echo
    check_backup_files
    echo
    check_backup_freshness
    echo
    check_backup_sizes
    echo
    check_compressed_integrity
    echo
    check_sql_structure
    echo
    check_uploads_backups
    echo
    check_backup_logs
    echo
    check_disk_space
    echo
    check_backup_schedule
    
    echo
    echo "=== Итоговые результаты ==="
    echo -e "${GREEN}Пройдено: $TESTS_PASSED${NC}"
    echo -e "${YELLOW}Предупреждений: $TESTS_WARNING${NC}" 
    echo -e "${RED}Ошибок: $TESTS_FAILED${NC}"
    
    # Генерация отчета
    generate_report
    
    echo
    if [[ $TESTS_FAILED -eq 0 ]]; then
        if [[ $TESTS_WARNING -eq 0 ]]; then
            echo -e "${GREEN}✓ Все проверки пройдены успешно${NC}"
            exit 0
        else
            echo -e "${YELLOW}! Проверки пройдены с предупреждениями${NC}"
            exit 0
        fi
    else
        echo -e "${RED}✗ Обнаружены критические проблемы с бэкапами${NC}"
        exit 1
    fi
}

# Проверка аргументов и справка
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Использование: $0"
    echo
    echo "Этот скрипт проверяет целостность и состояние системы бэкапов:"
    echo "- Наличие и структуру директорий"
    echo "- Файлы бэкапов и их размеры"
    echo "- Актуальность бэкапов"
    echo "- Целостность сжатых архивов"
    echo "- Структуру SQL бэкапов"
    echo "- Бэкапы медиафайлов"
    echo "- Логи бэкапов"
    echo "- Свободное место на диске"
    echo "- Расписание автоматических бэкапов"
    echo
    echo "Переменные окружения:"
    echo "  MIN_BACKUP_SIZE_MB     - минимальный размер бэкапа в МБ (1)"
    echo "  MAX_BACKUP_AGE_DAYS    - максимальный возраст бэкапа в днях (7)"
    echo
    echo "Коды возврата:"
    echo "  0 - Все проверки пройдены"
    echo "  1 - Обнаружены критические проблемы"
    exit 0
fi

# Запуск основной функции
main "$@"
