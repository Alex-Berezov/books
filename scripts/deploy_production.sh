#!/bin/bash

# Production Deployment Script  
# ============================
# Автоматический деплой Books App Backend в production
#
# Использование:
#   ./scripts/deploy_production.sh [OPTIONS]
#
# Опции:
#   --version VERSION    Версия для деплоя (git tag, branch, commit)
#   --registry REGISTRY  Docker registry (по умолчанию: localhost)
#   --no-backup         Не создавать бэкап перед деплоем
#   --no-migrate        Не выполнять миграции
#   --force             Не спрашивать подтверждение
#   --rollback          Откат к предыдущей версии
#   --dry-run           Показать команды без выполнения
#   -h, --help          Показать эту справку

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
VERSION=""
IMAGE_TAG=""
REGISTRY="localhost"
NO_BACKUP=false
NO_MIGRATE=false
FORCE=false
ROLLBACK=false
DRY_RUN=false
SKIP_GIT_UPDATE=false
PULL_IMAGE=false

# Пути
DEPLOY_DIR="/opt/books/app/src"
BACKUP_DIR="/opt/books/backups"
LOG_DIR="/opt/books/logs"

# Файлы состояния
STATE_FILE="$DEPLOY_DIR/.deployment_state"
ROLLBACK_FILE="$DEPLOY_DIR/.rollback_info"

# Логирование
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}" | tee -a "$LOG_DIR/deployment.log"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}" | tee -a "$LOG_DIR/deployment.log"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}" | tee -a "$LOG_DIR/deployment.log"
}

log_error() {
    echo -e "${RED}❌ $1${NC}" | tee -a "$LOG_DIR/deployment.log"
}

log_info() {
    echo -e "${CYAN}ℹ️  $1${NC}" | tee -a "$LOG_DIR/deployment.log"
}

# Показать справку
show_help() {
    cat << EOF
Production Deployment Script
============================

Автоматический деплой Books App Backend в production окружение.

ИСПОЛЬЗОВАНИЕ:
    ./scripts/deploy_production.sh --version v1.2.3 [OPTIONS]

ПАРАМЕТРЫ:
    --version VERSION    Версия для деплоя (git tag, branch, commit)
                        Примеры: v1.2.3, main, abc1234
    --image-tag TAG     Docker image tag (если отличается от version)
    --registry REGISTRY  Docker registry (по умолчанию: localhost)
    --skip-git-update   Не обновлять Git репозиторий (уже обновлен в CI)
    --pull              Pull образ из registry вместо локальной сборки
    --no-backup         Пропустить создание бэкапа
    --no-migrate        Пропустить выполнение миграций
    --force             Не спрашивать подтверждение
    --rollback          Откат к предыдущей версии
    --dry-run           Показать команды без выполнения
    -h, --help          Показать эту справку

ПРИМЕРЫ:
    # Деплой новой версии (локальная сборка)
    ./scripts/deploy_production.sh --version v1.2.3
    
    # Деплой с пропуском бэкапа
    ./scripts/deploy_production.sh --version main --no-backup
    
    # Деплой из CI (Git уже обновлен, pull образа)
    ./scripts/deploy_production.sh --image-tag main-abc1234 --skip-git-update --pull
    
    # Откат к предыдущей версии
    ./scripts/deploy_production.sh --rollback
    
    # Dry run для проверки
    ./scripts/deploy_production.sh --version v1.2.3 --dry-run

ТРЕБОВАНИЯ:
    - Docker и Docker Compose
    - Git репозиторий в $DEPLOY_DIR
    - Права пользователя deploy
    - Настроенная среда (/opt/books структура)

EOF
}

# Парсинг аргументов
while [[ $# -gt 0 ]]; do
    case $1 in
        --version)
            VERSION="$2"
            shift 2
            ;;
        --image-tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        --registry)
            REGISTRY="$2"
            shift 2
            ;;
        --skip-git-update)
            SKIP_GIT_UPDATE=true
            shift
            ;;
        --pull)
            PULL_IMAGE=true
            shift
            ;;
        --no-backup)
            NO_BACKUP=true
            shift
            ;;
        --no-migrate)
            NO_MIGRATE=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --rollback)
            ROLLBACK=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            log_error "Неизвестный параметр: $1"
            echo "Используйте --help для справки"
            exit 1
            ;;
    esac
done

# Автоопределение IMAGE_TAG если не задан
if [[ -z "$IMAGE_TAG" && -n "$VERSION" ]]; then
    IMAGE_TAG="$VERSION"
fi

# Проверка параметров
if [[ "$ROLLBACK" == false && -z "$IMAGE_TAG" ]]; then
    log_error "Не указан image tag. Используйте --image-tag, --version или --rollback"
    echo "Используйте --help для справки"
    exit 1
fi

# Функция выполнения команд
execute() {
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "${GRAY}[DRY-RUN] $1${NC}"
    else
        log "Выполнение: $1"
        eval "$1"
    fi
}

# Проверка окружения
check_environment() {
    log "Проверка окружения..."
    
    # Проверка пользователя
    if [[ $(whoami) != "deploy" ]] && [[ $(whoami) != "root" ]]; then
        log_warning "Рекомендуется запускать под пользователем deploy"
    fi
    
    # Проверка каталогов
    local required_dirs=("$DEPLOY_DIR" "$BACKUP_DIR" "$LOG_DIR")
    for dir in "${required_dirs[@]}"; do
        if [[ ! -d "$dir" ]]; then
            log_error "Каталог не найден: $dir"
            exit 1
        fi
    done
    
    # Проверка Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker не установлен"
        exit 1
    fi
    
    if ! docker compose version &> /dev/null; then
        log_error "Docker Compose не доступен"
        exit 1
    fi
    
    # Проверка Git репозитория
    if [[ ! -d "$DEPLOY_DIR/.git" ]]; then
        log_error "Git репозиторий не найден в $DEPLOY_DIR"
        exit 1
    fi
    
    log_success "Окружение проверено"
}

# Валидация .env.prod и DATABASE_URL
validate_env() {
    log "Проверка .env.prod и DATABASE_URL..."
    local envfile="$DEPLOY_DIR/.env.prod"
    if [[ ! -f "$envfile" ]]; then
        log_error ".env.prod не найден в $DEPLOY_DIR"
        exit 1
    fi
    # Извлекаем DATABASE_URL (убираем кавычки если есть)
    local raw_db_url
    raw_db_url=$(grep -E '^DATABASE_URL=' "$envfile" | sed 's/^DATABASE_URL=//' | sed 's/^\"\|\"$//g' | sed "s/^'\|'$//g") || true
    if [[ -z "$raw_db_url" ]]; then
        log_error "DATABASE_URL не задан в .env.prod"
        exit 1
    fi
    # Если есть плейсхолдеры вида ${VAR}, пытаемся развернуть их из .env.prod
    local db_url_to_check="$raw_db_url"
    if [[ "$raw_db_url" == *'${'* ]]; then
        db_url_to_check=$(bash -c "set -a; source '$envfile'; set +a; eval echo \"$raw_db_url\"")
    fi
    # Проверяем, что порт числовой, если указан
    if ! node -e "try{const u=new URL(String(process.argv[1])); const p=u.port||''; if(p && !/^\\d+$/.test(String(p))){process.exit(42)} process.exit(0)}catch{process.exit(43)}" "$db_url_to_check"; then
        log_error "DATABASE_URL имеет невалидный порт. Проверьте формат host:port и URL-кодирование пароля."
        log_info "Пример корректного URL: postgresql://user:pass@postgres:5432/db?schema=public"
        exit 1
    fi
    # Логируем без пароля
    local safe_url
    safe_url=$(node -e "const u=new URL(process.argv[1]); u.password=u.password? '***' : ''; console.log(u.toString())" "$db_url_to_check" 2>/dev/null || echo "(не удалось распарсить)")
    log_success "DATABASE_URL валиден: $safe_url"
}

# Проверка состояния сервисов
check_services() {
    log "Проверка состояния сервисов..."
    
    cd "$DEPLOY_DIR"
    
    # Проверка запущенных контейнеров
    if docker compose -f docker-compose.prod.yml ps --format json | jq -e '.State == "running"' &> /dev/null; then
        log_info "Приложение запущено"
        return 0
    else
        log_warning "Приложение не запущено или частично недоступно"
        return 1
    fi
}

# Создание бэкапа
create_backup() {
    if [[ "$NO_BACKUP" == true ]]; then
        log_info "Пропуск создания бэкапа (--no-backup)"
        return 0
    fi
    
    log "Создание бэкапа перед деплоем..."
    
    if [[ -f "./scripts/backup_database.sh" ]]; then
        execute "./scripts/backup_database.sh daily --tag pre-deploy-$(date +%Y%m%d-%H%M%S)"
        log_success "Бэкап создан"
    else
        log_error "Скрипт backup_database.sh не найден"
        exit 1
    fi
}

# Сохранение текущего состояния для отката
save_current_state() {
    log "Сохранение текущего состояния..."
    
    cd "$DEPLOY_DIR"
    
    local current_commit=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    local current_tag=$(git describe --tags --exact-match 2>/dev/null || echo "no-tag")
    # docker compose images --format json outputs an array; pick the app service image if present
    local current_image=$(docker compose -f docker-compose.prod.yml images --format json \
        | jq -r '.[0] | (.Repository + ":" + .Tag)' 2>/dev/null || echo "unknown")
    
    cat > "$ROLLBACK_FILE" << EOF
{
    "timestamp": "$(date -Iseconds)",
    "commit": "$current_commit",
    "tag": "$current_tag", 
    "image": "$current_image",
    "image_tag": "$IMAGE_TAG",
    "deployment_user": "$(whoami)"
}
EOF
    
    log_success "Состояние сохранено для отката"
}

# Обновление кода
update_code() {
    if [[ "$SKIP_GIT_UPDATE" == true ]]; then
        log_info "Пропуск обновления Git (--skip-git-update)"
        cd "$DEPLOY_DIR"
        local current_commit=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
        local current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
        log_info "Текущая версия Git: $current_branch @ $current_commit"
        return 0
    fi
    
    log "Обновление кода до версии: $VERSION"
    
    cd "$DEPLOY_DIR"
    
    # Получение последних изменений
    execute "git fetch --all --tags"
    
    # Переключение на нужную версию
    if git rev-parse --verify "refs/tags/$VERSION" &>/dev/null; then
        log_info "Переключение на тег: $VERSION"
        execute "git checkout tags/$VERSION"
    elif git rev-parse --verify "origin/$VERSION" &>/dev/null; then
        log_info "Переключение на ветку: $VERSION"
        execute "git checkout origin/$VERSION"
    elif git rev-parse --verify "$VERSION" &>/dev/null; then
        log_info "Переключение на коммит: $VERSION"
        execute "git checkout $VERSION"
    else
        log_error "Версия не найдена: $VERSION"
        exit 1
    fi
    
    local new_commit=$(git rev-parse HEAD)
    log_success "Код обновлен до коммита: $new_commit"
}

# Сборка/pull образа
build_image() {
    cd "$DEPLOY_DIR"
    
    local image_tag="books-app:$IMAGE_TAG"
    local full_image_tag="$image_tag"
    
    if [[ "$REGISTRY" != "localhost" ]]; then
        # Registry уже содержит полный путь включая repository name
        # Например: ghcr.io/alex-berezov/books
        full_image_tag="$REGISTRY:$IMAGE_TAG"
    fi
    
    if [[ "$PULL_IMAGE" == true ]]; then
        log "Pull Docker образа из registry..."
        
        # Pull образа из registry
        execute "docker pull $full_image_tag"
        
        # Тегируем для локального использования
        if [[ "$REGISTRY" != "localhost" ]]; then
            execute "docker tag $full_image_tag $image_tag"
            execute "docker tag $full_image_tag books-app:latest"
            # Ensure compose service 'app' uses the pulled image by tagging as books-app:prod (compose file image)
            execute "docker tag $full_image_tag books-app:prod"
        fi
        
        log_success "Образ получен: $full_image_tag"
    else
        log "Сборка Docker образа..."
        
        # Локальная сборка с многоступенчатым кэшированием
        execute "docker build \
            --target runner \
            --tag $image_tag \
            --tag books-app:latest \
            --build-arg BUILD_DATE=$(date -Iseconds) \
            --build-arg VCS_REF=$(git rev-parse HEAD) \
            --build-arg VERSION=$IMAGE_TAG \
            ."
        
        log_success "Образ собран: $image_tag"
    fi
}

# Выполнение миграций
run_migrations() {
    if [[ "$NO_MIGRATE" == true ]]; then
        log_info "Пропуск миграций (--no-migrate)"
        return 0
    fi
    
    log "Выполнение миграций базы данных..."
    
    cd "$DEPLOY_DIR"
    
    # Запуск временного контейнера для миграций
    # Запускаем миграции, обходя entrypoint, чтобы не запускать приложение
    execute "docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint '' app npx prisma migrate deploy"
    
    log_success "Миграции выполнены"
}

# Развертывание сервисов
deploy_services() {
    log "Развертывание сервисов..."
    
    cd "$DEPLOY_DIR"
    
    # Остановка текущих сервисов
    execute "docker compose -f docker-compose.prod.yml down --timeout 30"
    
    # Запуск новых сервисов
    execute "docker compose -f docker-compose.prod.yml up -d"
    
    # Ожидание готовности
    log "Ожидание готовности сервисов..."
    local max_attempts=30
    local attempt=0
    
    while [[ $attempt -lt $max_attempts ]]; do
        if [[ "$DRY_RUN" == true ]]; then
            log_info "[DRY-RUN] Проверка здоровья сервиса"
            break
        fi
        
        if curl -sf "http://localhost:5000/api/health/liveness" &> /dev/null; then
            log_success "Сервис готов к работе"
            return 0
        fi
        
        ((attempt++))
        log_info "Попытка $attempt/$max_attempts..."
        sleep 5
    done
    
    log_error "Сервис не готов после $max_attempts попыток"
    return 1
}

# Проверка деплоя
verify_deployment() {
    log "Проверка деплоя..."
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY-RUN] Проверки пропущены"
        return 0
    fi
    
    cd "$DEPLOY_DIR"
    
    local checks_passed=0
    local total_checks=5
    
    # 1. Проверка запущенных контейнеров
    if docker compose -f docker-compose.prod.yml ps --format json | jq -e '.State == "running"' &> /dev/null; then
        log_success "✓ Контейнеры запущены"
        ((checks_passed++))
    else
        log_error "✗ Контейнеры не запущены"
    fi
    
    # 2. Проверка healthcheck
    if curl -sf "http://localhost:5000/api/health/liveness" &> /dev/null; then
        log_success "✓ Health check прошел"
        ((checks_passed++))
    else
        log_error "✗ Health check не прошел"
    fi
    
    # 3. Проверка базы данных
    if curl -sf "http://localhost:5000/api/health/readiness" &> /dev/null; then
        log_success "✓ База данных подключена"
        ((checks_passed++))
    else
        log_error "✗ База данных недоступна"
    fi
    
    # 4. Проверка метрик
    if curl -sf "http://localhost:5000/api/metrics" &> /dev/null; then
        log_success "✓ Метрики доступны"
        ((checks_passed++))
    else
        log_error "✗ Метрики недоступны"
    fi
    
    # 5. Проверка версии API
    local api_version=$(curl -sf "http://localhost:5000/api/health/liveness" | jq -r '.version // "unknown"' 2>/dev/null || echo "unknown")
    if [[ "$api_version" != "unknown" ]]; then
        log_success "✓ API версия: $api_version"
        ((checks_passed++))
    else
        log_warning "? Версия API не определена"
    fi
    
    # Результат
    log_info "Пройдено проверок: $checks_passed/$total_checks"
    
    if [[ $checks_passed -eq $total_checks ]]; then
        return 0
    elif [[ $checks_passed -ge 3 ]]; then
        log_warning "Деплой выполнен с предупреждениями"
        return 0
    else
        log_error "Деплой не прошел критические проверки"
        return 1
    fi
}

# Сохранение состояния деплоя
save_deployment_state() {
    log "Сохранение состояния деплоя..."
    
    cd "$DEPLOY_DIR"
    
    local commit=$(git rev-parse HEAD)
    local tag=$(git describe --tags --exact-match 2>/dev/null || echo "no-tag")
    
    cat > "$STATE_FILE" << EOF
{
    "timestamp": "$(date -Iseconds)",
    "image_tag": "$IMAGE_TAG",
    "git_version": "$VERSION",
    "commit": "$commit",
    "tag": "$tag",
    "registry": "$REGISTRY", 
    "deployment_user": "$(whoami)",
    "deployment_host": "$(hostname)",
    "checks_passed": true
}
EOF
    
    log_success "Состояние деплоя сохранено"
}

# Откат к предыдущей версии
perform_rollback() {
    log "Выполнение отката..."
    
    if [[ ! -f "$ROLLBACK_FILE" ]]; then
        log_error "Файл отката не найден: $ROLLBACK_FILE"
        exit 1
    fi
    
    local rollback_version=$(jq -r '.commit // .tag' "$ROLLBACK_FILE" 2>/dev/null)
    if [[ -z "$rollback_version" || "$rollback_version" == "null" ]]; then
        log_error "Не удалось определить версию для отката"
        exit 1
    fi
    
    log_info "Откат к версии: $rollback_version"
    
    VERSION="$rollback_version"
    update_code
    build_image
    deploy_services
    
    if verify_deployment; then
        log_success "Откат выполнен успешно"
    else
        log_error "Откат не прошел проверки"
        exit 1
    fi
}

# Очистка старых образов
cleanup_old_images() {
    log "Очистка старых Docker образов..."
    
    # Оставляем последние 3 образа
    execute "docker images books-app --format 'table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}' | tail -n +2 | sort -k3 -r | tail -n +4 | awk '{print \$1\":\"\$2}' | xargs -r docker rmi || true"
    
    # Очистка неиспользуемых образов
    execute "docker image prune -f"
    
    log_success "Очистка завершена"
}

# Отправка уведомлений (заглушка для будущей интеграции)
send_notification() {
    local status=$1
    local message=$2
    
    log_info "Уведомление: $status - $message"
    
    # Здесь можно добавить интеграции:
    # - Slack webhook
    # - Email
    # - Telegram bot
    # - Discord webhook
}

# Основная функция
main() {
    echo -e "${PURPLE}"
    echo "========================================"
    echo "🚀 Books App Production Deployment"
    echo "========================================"
    echo -e "${NC}"
    
    if [[ "$ROLLBACK" == true ]]; then
        echo "Режим: ОТКАТ к предыдущей версии"
    else
        echo "Image Tag: $IMAGE_TAG"
        if [[ -n "$VERSION" && "$VERSION" != "$IMAGE_TAG" ]]; then
            echo "Git Version: $VERSION"
        fi
        echo "Registry: $REGISTRY"
    fi
    echo "Режим выполнения: $([ "$DRY_RUN" == true ] && echo "DRY RUN" || echo "РЕАЛЬНЫЙ ДЕПЛОЙ")"
    echo ""
    
    if [[ "$FORCE" == false && "$DRY_RUN" == false ]]; then
        if [[ "$ROLLBACK" == true ]]; then
            read -p "Выполнить откат? (y/N): " -n 1 -r
        else
            read -p "Выполнить деплой образа $IMAGE_TAG? (y/N): " -n 1 -r
        fi
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Деплой отменен пользователем"
            exit 0
        fi
    fi
    
    # Инициализация
    mkdir -p "$LOG_DIR"
    
    log "Начало деплоя образа $IMAGE_TAG"
    send_notification "START" "Начат деплой образа $IMAGE_TAG"
    
    # Проверки
    check_environment
    validate_env
    
    if [[ "$ROLLBACK" == true ]]; then
        perform_rollback
        send_notification "SUCCESS" "Откат выполнен успешно"
    else
        # Основной деплой
        create_backup
        save_current_state
        update_code
        build_image
        run_migrations
        deploy_services
        
        if verify_deployment; then
            save_deployment_state
            cleanup_old_images
            
            echo ""
            echo -e "${GREEN}"
            echo "========================================"
            echo "✅ Деплой выполнен успешно!"
            echo "========================================"
            echo -e "${NC}"
            echo "Image Tag: $IMAGE_TAG"
            if [[ -n "$VERSION" && "$VERSION" != "$IMAGE_TAG" ]]; then
                echo "Git Version: $VERSION"
            fi
            echo "Время: $(date)"
            echo "Логи: $LOG_DIR/deployment.log"
            
            send_notification "SUCCESS" "Деплой образа $IMAGE_TAG выполнен успешно"
        else
            log_error "Деплой не прошел проверки"
            send_notification "FAILURE" "Деплой образа $IMAGE_TAG не прошел проверки"
            
            if [[ "$FORCE" == false ]]; then
                read -p "Выполнить автоматический откат? (Y/n): " -n 1 -r
                echo
                if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
                    perform_rollback
                    send_notification "ROLLBACK" "Выполнен автоматический откат после неудачного деплоя"
                fi
            fi
            
            exit 1
        fi
    fi
}

# Обработка ошибок
trap 'log_error "Ошибка в строке $LINENO. Код выхода: $?"; send_notification "ERROR" "Ошибка деплоя в строке $LINENO"' ERR

# Запуск
main "$@"
