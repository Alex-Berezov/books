#!/bin/bash

# Production Deployment Script
# ============================
# Automated deployment of Books App Backend to production
#
# Usage:
#   ./scripts/deploy_production.sh [OPTIONS]
#
# Options:
#   --version VERSION    Version to deploy (git tag, branch, commit)
#   --registry REGISTRY  Docker registry (default: localhost)
#   --no-backup          Skip creating backup before deployment
#   --no-migrate         Skip running database migrations
#   --force              Do not ask for confirmation
#   --rollback           Roll back to previous version
#   --dry-run            Show commands without executing
#   -h, --help           Show this help

set -euo pipefail

# Color scheme
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m'

# Default variables
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

# Paths
DEPLOY_DIR="/opt/books/app/src"
BACKUP_DIR="/opt/books/backups"
LOG_DIR="/opt/books/logs"

# State files
STATE_FILE="$DEPLOY_DIR/.deployment_state"
ROLLBACK_FILE="$DEPLOY_DIR/.rollback_info"

# Logging
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

# Show help / usage
show_help() {
    cat << EOF
Production Deployment Script
============================

Automated deployment of Books App Backend to production environment.

USAGE:
    ./scripts/deploy_production.sh --version v1.2.3 [OPTIONS]

PARAMETERS:
    --version VERSION    Version to deploy (git tag, branch, commit)
                         Examples: v1.2.3, main, abc1234
    --image-tag TAG      Docker image tag (if different from version)
    --registry REGISTRY  Docker registry (default: localhost)
    --skip-git-update    Skip Git repository update (already updated in CI)
    --pull               Pull image from registry instead of local build
    --no-backup          Skip creating a backup
    --no-migrate         Skip running migrations
    --force              Do not ask for confirmation
    --rollback           Roll back to previous version
    --dry-run            Show commands without executing
    -h, --help           Show this help

EXAMPLES:
    # Deploy new version (local build)
    ./scripts/deploy_production.sh --version v1.2.3
    
    # Deploy skipping backup
    ./scripts/deploy_production.sh --version main --no-backup
    
    # Deploy from CI (Git already updated, pull image)
    ./scripts/deploy_production.sh --image-tag main-abc1234 --skip-git-update --pull
    
    # Rollback to previous version
    ./scripts/deploy_production.sh --rollback
    
    # Dry run to verify
    ./scripts/deploy_production.sh --version v1.2.3 --dry-run

REQUIREMENTS:
    - Docker and Docker Compose
    - Git repository in $DEPLOY_DIR
    - deploy user permissions
    - Prepared environment (/opt/books directory structure)

EOF
}

# Argument parsing
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
            log_error "Unknown parameter: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Auto-detect IMAGE_TAG if not provided
if [[ -z "$IMAGE_TAG" && -n "$VERSION" ]]; then
    IMAGE_TAG="$VERSION"
fi

# Parameter validation
if [[ "$ROLLBACK" == false && -z "$IMAGE_TAG" ]]; then
    log_error "Image tag not specified. Use --image-tag, --version or --rollback"
    echo "Use --help for usage information"
    exit 1
fi

# Command execution helper
execute() {
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "${GRAY}[DRY-RUN] $1${NC}"
    else
    log "Executing: $1"
        eval "$1"
    fi
}

# Запись файла состояния на машине — через `execute`, а не голым перенаправлением.
#
# 🔴 `LEGACY-327`. Точка отката и запись состояния выката были единственными мутациями,
# шедшими мимо `execute`: обычный `cat > "$FILE" << EOF`. Значит `--dry-run`, запущенный
# на боевой машине «посмотреть, что будет», **действительно перезаписывал** боевой файл.
# Опасен не файл, а порядок: сухой прогон ПОСЛЕ неудачного выката, но ДО отката затирал
# точку возврата на сломанный образ, который в этот момент и работает.
#
# 🔴 Функция общая, а не приём, скопированный дважды. Мест таких два, и первый разбор
# нашёл только одно из них — ровно тот случай, ради которого заведено правило `LEGACY-329`:
# правка, снимающая приём в одном месте файла, обязана грепнуть файл целиком. Общая функция
# делает следующую правку приёма одноместной.
#
# ⚠️ Тело передаётся через base64. Прямая подстановка JSON в строку для `eval` ломается
# на кавычках внутри него, а `execute` именно `eval`-ит свой аргумент; base64 в одинарных
# кавычках безопасен при любом содержимом. `tr -d` вместо `-w0`: последний есть у GNU
# coreutils, но не у busybox.
write_state_file() {
    local target="$1"
    local payload="$2"
    local encoded

    # 🔴 «Не смог закодировать» — свой отказ, а не тихий успех. Подстановка команды
    # выбрасывает код возврата: не окажись `base64` или `tr` в `PATH` пользователя
    # `deploy` (`check_environment` их не проверяет), `encoded` вышел бы пустым,
    # `printf '%s' '' | base64 -d > "$target"` вернул бы 0, файл обнулился, а рядом
    # напечаталось бы «State saved for rollback». Это ровно тот инцидент 30.08.2026,
    # ради которого файл и чинили: точка отката, которая выглядит как точка отката.
    if ! encoded=$(printf '%s\n' "$payload" | base64 | tr -d '\n'); then
        log_error "Could not encode payload for $target - refusing to write it"
        return 1
    fi
    if [[ -z "$encoded" ]]; then
        log_error "Encoded payload for $target is empty - refusing to overwrite the file"
        return 1
    fi

    execute "printf '%s' '$encoded' | base64 -d > \"$target\""
}

# Environment checks
check_environment() {
    log "Checking environment..."
    
    # User check
    if [[ $(whoami) != "deploy" ]] && [[ $(whoami) != "root" ]]; then
    log_warning "Recommended to run as user 'deploy'"
    fi
    
    # Directory checks
    local required_dirs=("$DEPLOY_DIR" "$BACKUP_DIR" "$LOG_DIR")
    for dir in "${required_dirs[@]}"; do
        if [[ ! -d "$dir" ]]; then
            log_error "Directory not found: $dir"
            exit 1
        fi
    done
    
    # Docker checks
    if ! command -v docker &> /dev/null; then
    log_error "Docker not installed"
        exit 1
    fi
    
    if ! docker compose version &> /dev/null; then
    log_error "Docker Compose not available"
        exit 1
    fi
    
    # Git repository check
    if [[ ! -d "$DEPLOY_DIR/.git" ]]; then
    log_error "Git repository not found in $DEPLOY_DIR"
        exit 1
    fi
    
    log_success "Environment validated"
}

# Validation of .env.prod and DATABASE_URL
validate_env() {
    log "Validating .env.prod and DATABASE_URL..."
    local envfile="$DEPLOY_DIR/.env.prod"
    if [[ ! -f "$envfile" ]]; then
    log_error ".env.prod not found in $DEPLOY_DIR"
    log_info "Create .env.prod based on .env.prod.template"
        exit 1
    fi
    # Extract DATABASE_URL (strip quotes if present)
    local raw_db_url
    raw_db_url=$(grep -E '^DATABASE_URL=' "$envfile" | sed 's/^DATABASE_URL=//' | sed 's/^\"\|\"$//g' | sed "s/^'\|'$//g") || true
    if [[ -z "$raw_db_url" ]]; then
    log_error "DATABASE_URL not set in .env.prod"
        exit 1
    fi
    
    # Check password for problematic characters
    if [[ "$raw_db_url" =~ postgresql://[^:]+:([^@]+)@ ]]; then
        local password="${BASH_REMATCH[1]}"
    # If password contains / or = WITHOUT URL encoding - that's an error
        if [[ "$password" == *"/"* || "$password" == *"="* ]] && [[ "$password" != *"%"* ]]; then
            log_error "❌ ERROR: Database password contains / or = without URL encoding!"
            log_error "Prisma cannot parse such URL."
            log_info "Solutions:"
            log_info "  1. Use password without special symbols (recommended)"
            log_info "  2. URL encode password: / → %2F, = → %3D"
            log_info "Current password has problematic characters: $password"
            exit 1
        fi
    fi
    
    # If there are placeholders like ${VAR}, attempt to expand them using .env.prod
    local db_url_to_check="$raw_db_url"
    if [[ "$raw_db_url" == *'${'* ]]; then
        db_url_to_check=$(bash -c "set -a; source '$envfile'; set +a; eval echo \"$raw_db_url\"")
    fi
    # Basic scheme validation
    case "$db_url_to_check" in
      postgres://*|postgresql://*) : ;; 
      *)
    log_error "DATABASE_URL must start with postgres:// or postgresql://"
        exit 1
        ;;
    esac
    # Extract host:port
    local without_scheme="${db_url_to_check#*://}"
    local after_at="${without_scheme##*@}"        # remove credentials if present
    local hostport="${after_at%%/*}"              # up to first '/'
    local port=""
    if [[ "$hostport" == *:* ]]; then
        port="${hostport##*:}"
    fi
    if [[ -n "$port" && ! "$port" =~ ^[0-9]+$ ]]; then
    log_error "DATABASE_URL has invalid port. Check host:port format and password URL encoding."
    log_info "Example valid URL: postgresql://user:pass@postgres:5432/db?schema=public"
        exit 1
    fi
    # Store expanded URL for subsequent steps (migrations)
    export DEPLOY_EXPANDED_DATABASE_URL="$db_url_to_check"
    # Log masked URL (hide credentials)
    local safe_url="$db_url_to_check"
    if [[ "$safe_url" == *"@"* ]]; then
        safe_url="***@${after_at}"
    # Add scheme back
        safe_url="${db_url_to_check%%://*}://$safe_url"
    fi
    log_success "DATABASE_URL valid: $safe_url"
}

# Service state check
check_services() {
    log "Checking services state..."
    
    cd "$DEPLOY_DIR"
    
    # Check running containers
    if docker compose -f docker-compose.prod.yml ps --format json | jq -e '.State == "running"' &> /dev/null; then
    log_info "Application is running"
        return 0
    else
    log_warning "Application not running or partially unavailable"
        return 1
    fi
}

# Backup creation
create_backup() {
    if [[ "$NO_BACKUP" == true ]]; then
        log_info "Skipping backup creation (--no-backup)"
        return 0
    fi
    
    log "Creating backup before deployment..."
    
    if [[ -f "./scripts/backup_database.sh" ]]; then
        execute "./scripts/backup_database.sh before-deploy --tag pre-deploy-$(date +%Y%m%d-%H%M%S)"
    log_success "Backup created"
    else
    log_error "backup_database.sh script not found"
        exit 1
    fi
}

# Save current state for rollback
save_current_state() {
    log "Saving current state..."
    
    cd "$DEPLOY_DIR"
    
    # 🔴 Ревизия берётся из DEPLOY_PREVIOUS_SHA, если она задана вызывающим.
    # `git rev-parse HEAD` здесь врёт на пути CI: шаг `🚀 Deploy to Server` переводит
    # рабочее дерево на выкатываемый `github.sha` ДО вызова скрипта и зовёт его с
    # `--skip-git-update`. То есть к моменту `save_current_state` в дереве уже новая
    # ревизия, и записанный «откат» указывал на неё же — откатываться было некуда.
    # Тот же приём, что у DEPLOY_EXPANDED_DATABASE_URL: значение готовит вызывающий.
    local current_commit="${DEPLOY_PREVIOUS_SHA:-}"
    if [[ -z "$current_commit" ]]; then
        current_commit=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    fi
    local current_tag=$(git describe --tags --exact-match 2>/dev/null || echo "no-tag")
    # 🔴 Идентификатор образа, а не его тег. Теги переставляются каждым выкатом
    # (`books-app:prod` — тот самый, который поднимает docker-compose.prod.yml), поэтому
    # откат «на books-app:prod» был бы откатом в никуда. ID неизменен, и именно он —
    # единственная надёжная ручка на то, что работало до этого выката.
    #
    # 🔴 `LEGACY-325`. Раньше и образ, и его ID доставались разбором
    # `docker compose images --format json` через `jq 'map(select(.Service == "app"))'`.
    # На Docker, установленном на боевой машине, объекты этого вывода поля `Service`
    # не имеют вовсе — там `ContainerName`. Выборка схлопывалась в пустой массив, `.[0].ID`
    # давал `null`, и `// ""` записывал пустую строку; `image` тем же путём получал `":"`
    # из `null + ":" + null`. Файл писался молча — перенаправление ошибки и хвост гасили
    # и разбор, и настоящий отказ, — и обнаружилось это только 30.08.2026, когда откат
    # понадобился и оказалось, что откатываться не к чему.
    #
    # ⚠️ Поэтому источник сменён: идентификатор берётся у самого контейнера службы `app`,
    # а не из формата вывода, который меняется от версии Docker к версии. `ps -q` понимает
    # имя службы сам, а `docker inspect --format '{{.Image}}'` отдаёт ровно тот `sha256:...`,
    # который ниже принимает `docker tag` в откате. Формат `inspect` стабилен и от раскладки
    # `compose images` не зависит.
    # ⚠️ `ps -aq`, а не `ps -q`. Остановленный контейнер — не то же самое, что отсутствующий:
    # упавший после миграции `app` при `-q` выглядел бы как чистая машина, и точка отката
    # была бы переписана пустой поверх годной. То есть ровно та поломка, ради которой всё
    # это и чинится, вернулась бы с другой стороны. `docker inspect` у вышедшего контейнера
    # `.Image` отдаёт, так что брать его есть откуда.
    #
    # ⚠️ Присваивание стоит в условии `if !` и объявлено `local` отдельной строкой.
    # `local x=$(...)` вернул бы статус `local`, а не подстановки, и отказ демона стал бы
    # неотличим от «контейнера нет» — третий исход снова свернулся бы во второй.
    local app_container=""
    local app_containers=""
    if ! app_containers=$(docker compose -f docker-compose.prod.yml ps -aq app); then
        log_error "Could not list containers of service 'app' - refusing to overwrite the rollback point"
        return 1
    fi
    app_containers=$(printf '%s\n' "$app_containers" | sed '/^$/d')

    # ⚠️ Строк должно быть не больше одной. `run_migrations` поднимает контейнер той же
    # службы через `docker compose run --rm`, и переживший прерванный выкат `*-app-run-*`
    # попадёт в эту же выборку. Порядок строк не определён, поэтому «взять первую» тихо
    # записало бы образ позапрошлого выката — откат вернул бы не ту версию и промолчал.
    local app_count=$(printf '%s\n' "$app_containers" | sed '/^$/d' | wc -l | tr -d ' ')
    if [[ "$app_count" -gt 1 ]]; then
        log_error "Service 'app' has $app_count containers - cannot tell which one is the rollback point"
        log_error "Leftover 'docker compose run' container? Remove it and retry: docker compose -f docker-compose.prod.yml ps -a"
        return 1
    fi
    app_container=$(printf '%s\n' "$app_containers" | head -n1)

    local current_image=""
    local current_image_id=""
    if [[ -n "$app_container" ]]; then
        current_image=$(docker inspect --format '{{.Config.Image}}' "$app_container" 2>/dev/null) || current_image=""
        current_image_id=$(docker inspect --format '{{.Image}}' "$app_container" 2>/dev/null) || current_image_id=""
    fi
    [[ -n "$current_image" ]] || current_image="unknown"

    # ⚠️ Тишина здесь и была настоящим дефектом: файл без `image_id` выглядит как файл.
    # Отсутствие контейнера — законный случай (первый выкат на чистую машину), и валить
    # его нельзя. А вот контейнер, который есть, но чей образ не читается, — это отказ,
    # и он обязан быть слышен: следующий откат на таком файле не состоится.
    if [[ -z "$app_container" ]]; then
        log_warning "No 'app' container at all - rollback point will be empty (first deploy?)"
    elif [[ -z "$current_image_id" ]]; then
        log_error "Could not read image id of container $app_container - rollback will not be possible"
        return 1
    fi

    # 🔴 `LEGACY-327`. Запись идёт через `execute`, а не голым `cat >`. Весь остальной
    # скрипт мутирует машину только так, и запись точки отката была единственным
    # исключением: `./deploy_production.sh --dry-run`, запущенный на боевой машине
    # «посмотреть, что будет», **действительно перезаписывал** `.rollback_info`.
    # Опасен не файл, а порядок: сухой прогон ПОСЛЕ неудачного выката, но ДО отката
    # затирал точку возврата на сломанный образ, который в этот момент и работает.
    #
    # ⚠️ Тело собирается в переменную и передаётся через base64. Прямая подстановка
    # JSON в строку для `eval` ломается на кавычках внутри него, а `execute` именно
    # `eval`-ит свой аргумент. base64 в одинарных кавычках безопасен при любом теле.
    # `tr -d` вместо `-w0`: последний есть у GNU coreutils, но не у busybox.
    local rollback_payload
    rollback_payload=$(cat << EOF
{
    "timestamp": "$(date -Iseconds)",
    "commit": "$current_commit",
    "tag": "$current_tag",
    "image": "$current_image",
    "image_id": "$current_image_id",
    "image_tag": "$IMAGE_TAG",
    "deployment_user": "$(whoami)"
}
EOF
)
    write_state_file "$ROLLBACK_FILE" "$rollback_payload"

    log_success "State saved for rollback"
}

# Code update
update_code() {
    if [[ "$SKIP_GIT_UPDATE" == true ]]; then
        log_info "Skipping Git update (--skip-git-update)"
        cd "$DEPLOY_DIR"
        local current_commit=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
        local current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    log_info "Current Git version: $current_branch @ $current_commit"
        return 0
    fi
    
    log "Updating code to version: $VERSION"
    
    cd "$DEPLOY_DIR"
    
    # Fetch latest changes
    execute "git fetch --all --tags"
    
    # Switch to desired version
    if git rev-parse --verify "refs/tags/$VERSION" &>/dev/null; then
    log_info "Switching to tag: $VERSION"
        execute "git checkout tags/$VERSION"
    elif git rev-parse --verify "origin/$VERSION" &>/dev/null; then
    log_info "Switching to branch: $VERSION"
        execute "git checkout origin/$VERSION"
    elif git rev-parse --verify "$VERSION" &>/dev/null; then
    log_info "Switching to commit: $VERSION"
        execute "git checkout $VERSION"
    else
    log_error "Version not found: $VERSION"
        exit 1
    fi
    
    local new_commit=$(git rev-parse HEAD)
    log_success "Code updated to commit: $new_commit"
}

# Build or pull image
build_image() {
    cd "$DEPLOY_DIR"
    
    local image_tag="books-app:$IMAGE_TAG"
    local full_image_tag="$image_tag"
    
    if [[ "$REGISTRY" != "localhost" ]]; then
    # Registry already contains full path including repository name
    # For example: ghcr.io/alex-berezov/books
        full_image_tag="$REGISTRY:$IMAGE_TAG"
    fi
    
    if [[ "$PULL_IMAGE" == true ]]; then
    log "Pulling Docker image from registry..."
        
    # Pull image from registry
        execute "docker pull $full_image_tag"
        
    # Tag for local use
        if [[ "$REGISTRY" != "localhost" ]]; then
            execute "docker tag $full_image_tag $image_tag"
            execute "docker tag $full_image_tag books-app:latest"
            # Ensure compose service 'app' uses the pulled image by tagging as books-app:prod (compose file image)
            execute "docker tag $full_image_tag books-app:prod"
        fi
        
    log_success "Image pulled: $full_image_tag"
    else
    log "Building Docker image..."
        
    # Local build with multi-stage caching
        execute "docker build \
            --target runner \
            --tag $image_tag \
            --tag books-app:latest \
            --build-arg BUILD_DATE=$(date -Iseconds) \
            --build-arg VCS_REF=$(git rev-parse HEAD) \
            --build-arg VERSION=$IMAGE_TAG \
            ."
        
    log_success "Image built: $image_tag"
    fi
}

# Running migrations
run_migrations() {
    if [[ "$NO_MIGRATE" == true ]]; then
        log_info "Skipping migrations (--no-migrate)"
        return 0
    fi
    
    log "Running database migrations..."
    
    cd "$DEPLOY_DIR"
    
    # Start temporary container for migrations
    # Run migrations bypassing entrypoint to avoid starting the full application
    # Pass expanded DATABASE_URL explicitly so Prisma doesn't misinterpret a non-numeric port
    local dburl="${DEPLOY_EXPANDED_DATABASE_URL:-}"
    if [[ -z "$dburl" ]]; then
    # fallback safeguard
        dburl=$(grep -E '^DATABASE_URL=' "$DEPLOY_DIR/.env.prod" | sed 's/^DATABASE_URL=//' | sed 's/^\"\|\"$//g' | sed "s/^'\|'$//g" || true)
    fi
    
    # URL-encode password for Prisma if it contains special symbols
    # Extract URL parts: protocol://user:password@host:port/db?params
    if [[ "$dburl" =~ ^([^:]+)://([^:]+):([^@]+)@(.+)$ ]]; then
        local protocol="${BASH_REMATCH[1]}"
        local user="${BASH_REMATCH[2]}"
        local password="${BASH_REMATCH[3]}"
        local rest="${BASH_REMATCH[4]}"
        
    # URL-encode password only if it contains /, = or other special symbols
        if [[ "$password" == *[/=]* ]]; then
            # Use Python for accurate URL encoding
            local encoded_password
            encoded_password=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$password', safe=''))")
            dburl="${protocol}://${user}:${encoded_password}@${rest}"
            log_info "Database password contains special symbols - URL encoded"
        fi
    fi
    
    # We need to pass DATABASE_URL to the container.
    # Using -e DATABASE_URL="..." can be problematic with special characters.
    # Using --env-file is not supported in all docker compose versions.
    # Best approach: Write to a temporary env file and tell docker compose to use it as the MAIN env file for this run.
    # But we can't easily replace .env.prod.
    
    # Alternative: Use the fact that we are running 'sh -c' inside the container?
    # No, we are running 'npx prisma migrate deploy'.
    
    # Let's try to use the environment variable from the shell, but ensure it is exported and available.
    # And use -e DATABASE_URL (without value) to pass it through.
    # To make this work, we must ensure the variable is in the environment of the 'docker compose' command.
    
    export DATABASE_URL="$dburl"
    execute "docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint '' -e DATABASE_URL app npx prisma migrate deploy"
    
    log_success "Migrations applied"
}

# Service deployment
deploy_services() {
    log "Deploying services..."
    
    cd "$DEPLOY_DIR"
    
    # The tag the container is started with, so `GET /api/health/liveness` can report which image
    # actually answers and the pipeline can tell "deployed" from "the old container still serves".
    export APP_VERSION="$IMAGE_TAG"

    # Starting new services / updating existing ones (avoids downtime and container conflicts)
    execute "docker compose -f docker-compose.prod.yml up -d"
    
    # Waiting for readiness
    log "Waiting for services to become ready..."
    
    # Initial delay for application startup and first health check
    log_info "Waiting 15 seconds for application startup..."
    sleep 15
    
    local max_attempts=60  # Increased from 30 to 60 attempts (maximum 5 minutes)
    local attempt=0
    
    while [[ $attempt -lt $max_attempts ]]; do
        if [[ "$DRY_RUN" == true ]]; then
            log_info "[DRY-RUN] Service health check"
            break
        fi
        
    # Checking Docker healthcheck status of the 'app' container.
    # The status read must never abort the deployment: under `set -o pipefail` a hiccup in
    # `docker compose ps` or `jq` would otherwise kill the wait instead of retrying it.
        local health_status="unknown"
        health_status=$(docker compose -f docker-compose.prod.yml ps --format json app 2>/dev/null \
            | jq -r '.Health // "none"' 2>/dev/null) || health_status="unknown"

        if [[ "$health_status" == "healthy" ]]; then
            log_success "Service is healthy"
            return 0
        fi

    # `$(( ))` in an assignment, not `(( ))` as a statement: `((attempt++))` returns the *old*
    # value, so on the first iteration it exits with 1 and `set -e` aborts the whole deployment
    # before this loop ever retries or prints the container logs below.
        attempt=$((attempt + 1))
    log_info "Attempt $attempt/$max_attempts (status: $health_status)..."
        sleep 5
    done
    
    log_error "Service not healthy after $max_attempts attempts"
    # Show logs for diagnostics
    log_info "Last container logs:"
    docker compose -f docker-compose.prod.yml logs --tail=20 app || true
    return 1
}

# Deployment verification
verify_deployment() {
    log "Verifying deployment..."
    
    if [[ "$DRY_RUN" == true ]]; then
    log_info "[DRY-RUN] Checks skipped"
        return 0
    fi
    
    cd "$DEPLOY_DIR"
    
    local checks_passed=0
    local total_checks=5
    local app_container
    app_container=$(docker compose -f docker-compose.prod.yml ps -q app)
    
    # 1. Check that containers are running
    if docker compose -f docker-compose.prod.yml ps --format json | jq -e '.State == "running"' &> /dev/null; then
    log_success "✓ Containers running"
        checks_passed=$((checks_passed + 1))
    else
    log_error "✗ Containers not running"
    fi
    
    # 2. Health check via Node (wget may be missing in the image)
    if [[ -n "$app_container" ]] && docker exec "$app_container" node -e "require('http').get('http://localhost:5000/api/health/liveness',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" &> /dev/null; then
    log_success "✓ Health check passed"
        checks_passed=$((checks_passed + 1))
    else
    log_error "✗ Health check failed"
    fi
    
    # 3. Database readiness check
    if [[ -n "$app_container" ]] && docker exec "$app_container" node -e "require('http').get('http://localhost:5000/api/health/readiness',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" &> /dev/null; then
    log_success "✓ Database connected"
        checks_passed=$((checks_passed + 1))
    else
    log_error "✗ Database not reachable"
    fi
    
    # 4. Metrics endpoint check.
    #
    # LEGACY-072: проверка перевёрнута. Раньше здесь ждали 200 — то есть успехом
    # деплоя считалось, что реестр prom-client отдаётся без токена. С 08.08.2026 на
    # `/api/metrics` висит `JwtAuthGuard + RolesGuard(admin)`, и правильный ответ
    # без заголовка Authorization — 401. Проба, ждущая 200, после закрытия дыры
    # роняла бы каждый выкат; проба на 401 краснеет, если гвард снимут.
    if [[ -n "$app_container" ]] && docker exec "$app_container" node -e "require('http').get('http://localhost:5000/api/metrics',r=>process.exit(r.statusCode===401?0:1)).on('error',()=>process.exit(1))" &> /dev/null; then
    log_success "✓ Metrics require authentication"
        checks_passed=$((checks_passed + 1))
    else
    log_error "✗ Metrics did not answer 401 — the admin guard is missing or the route changed"
    fi
    
    # 5. API version / container health via Docker healthcheck status
    local health_status
    health_status=$(docker compose -f docker-compose.prod.yml ps --format json app 2>/dev/null | jq -r '.Health // "none"')
    if [[ "$health_status" == "healthy" ]]; then
    log_success "✓ Docker healthcheck: $health_status"
        checks_passed=$((checks_passed + 1))
    else
    log_warning "? Docker healthcheck: $health_status"
    fi
    
    # Result summary
    log_info "Checks passed: $checks_passed/$total_checks"
    
    if [[ $checks_passed -eq $total_checks ]]; then
        return 0
    elif [[ $checks_passed -ge 3 ]]; then
    log_warning "Deployment completed with warnings"
        return 0
    else
    log_error "Deployment failed critical checks"
        return 1
    fi
}

# Saving deployment state
save_deployment_state() {
    log "Saving deployment state..."
    
    cd "$DEPLOY_DIR"
    
    local commit=$(git rev-parse HEAD)
    local tag=$(git describe --tags --exact-match 2>/dev/null || echo "no-tag")
    
    # 🔴 `LEGACY-327`, второе место. Ревью 02.09.2026 показало, что запись точки отката
    # была не единственной мутацией мимо `execute`: этот файл писался тем же приёмом
    # и на сухом прогоне тоже — `save_deployment_state` зовётся из `main` после
    # `verify_deployment`. Приём тот же, что выше.
    local state_payload
    state_payload=$(cat << EOF
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
)
    write_state_file "$STATE_FILE" "$state_payload"

    log_success "Deployment state saved"
}

# Rollback to previous version
# Rollback to previous version.
#
# 🔴 ADR-018: откат в этом проекте — это откат ОБРАЗА, а не схемы. Отсюда и способ:
# образ, работавший до выката, переставляется обратно на тег `books-app:prod`, который
# поднимает `docker-compose.prod.yml`, и сервисы перезапускаются. Пересборки здесь нет
# и быть не должно.
#
# До 18.08.2026 функция делала `update_code` + `build_image` и была мертва трижды:
#   - `.commit` указывал на выкатываемую (сломанную) ревизию, см. `save_current_state`;
#   - `--rollback` идёт без `--image-tag`, поэтому `IMAGE_TAG` пуст и `build_image`
#     выполнял `docker build --tag books-app:` — `invalid reference format`;
#   - ветка локальной сборки не переставляет `books-app:prod`, то есть даже успешная
#     сборка не меняла того, что поднимет compose.
# Найдено ревью 18.08.2026 при закрытии `LEGACY-243`.
perform_rollback() {
    log "Performing rollback..."

    if [[ ! -f "$ROLLBACK_FILE" ]]; then
    log_error "Rollback file not found: $ROLLBACK_FILE"
        exit 1
    fi

    local rollback_image_id=$(jq -r '.image_id // ""' "$ROLLBACK_FILE" 2>/dev/null)
    if [[ -z "$rollback_image_id" || "$rollback_image_id" == "null" ]]; then
    log_error "No image_id in $ROLLBACK_FILE - nothing to roll back to."
    log_error "This file predates the image-based rollback, or the previous deploy never ran."
    log_error "Do not improvise: see books-app-docs/backend/guides/migration-failure-runbook.md"
        exit 1
    fi

    log_info "Rolling back to image: $rollback_image_id"

    # 🔴 `LEGACY-328`. Наличие образа проверяется ЗДЕСЬ, до `update_code`, а не перед
    # `docker tag` ниже. Порядок и есть содержание правки: `update_code` переводит рабочее
    # дерево на предыдущую ревизию, и отказ, случившийся после него, оставляет машину
    # с деревом от одной ревизии и контейнером от другой — состояние, которое никто
    # не откатывает обратно. Отсутствующий образ дороже не сам по себе, а этим следом.
    #
    # ⚠️ Образ может исчезнуть штатно: `cleanup_old_images` держит только последние
    # (см. `keep_images` в `cleanup_old_images`), плюс ручной `docker image prune`
    # никто не запрещает.
    # То есть ветка живая, а не теоретическая.
    if ! docker image inspect "$rollback_image_id" > /dev/null 2>&1; then
        log_error "Image $rollback_image_id from $ROLLBACK_FILE is not on this machine anymore."
        log_error "Nothing was changed: the working tree is still on the current revision."
        log_error "Do not improvise: see books-app-docs/backend/guides/migration-failure-runbook.md"
        exit 1
    fi

    # Рабочее дерево переводится на предыдущую ревизию только чтобы `docker-compose.prod.yml`
    # и `configs/**` соответствовали поднимаемому образу. Если ревизия неизвестна, откат
    # всё равно делается: образ важнее, а расхождение конфигов лечится следующим выкатом.
    local rollback_version=$(jq -r '.commit // ""' "$ROLLBACK_FILE" 2>/dev/null)
    if [[ -n "$rollback_version" && "$rollback_version" != "null" && "$rollback_version" != "unknown" ]]; then
    log_info "Restoring working tree to: $rollback_version"
        VERSION="$rollback_version"
        SKIP_GIT_UPDATE=false
        update_code
    else
    log_warning "Previous revision unknown - rolling back the image only"
    fi

    execute "docker tag $rollback_image_id books-app:prod"
    execute "docker tag $rollback_image_id books-app:latest"

    deploy_services

    if verify_deployment; then
    log_success "Rollback successful"
    else
    log_error "Rollback failed checks"
        exit 1
    fi
}

# Cleaning up old images
cleanup_old_images() {
    log "Cleaning up old Docker images..."

    # 🔴 `LEGACY-328`. Было три. Три покрывают сценарий «откатиться сразу» и не покрывают
    # откат через несколько выкатов: точка отката в `.rollback_info` живёт до следующего
    # выката, а образ, на который она показывает, уборка успевает снести. Пять — тот же
    # запас, только на день работы, а не на час; место на диске за это платится один раз.
    # Проверку существования образа это не заменяет, она стоит в `perform_rollback`.
    local keep_images=5
    # ⚠️ Отказ уборки выкат не валит — образ может быть занят работающим контейнером,
    # и это законно. Но глушить код возврата хвостом нельзя: тогда «занят» неотличимо
    # от «команда сломалась». Отказ разбирается веткой и попадает в лог.
    if ! execute "docker images books-app --format 'table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}' | tail -n +2 | sort -k3 -r | tail -n +$((keep_images + 1)) | awk '{print \$1\":\"\$2}' | xargs -r docker rmi"; then
        log_warning "Some old images could not be removed (still in use?) - continuing"
    fi
    
    # Remove dangling/unused images
    execute "docker image prune -f"
    
    log_success "Cleanup completed"
}

# Sending notifications (stub for future integration)
send_notification() {
    local status=$1
    local message=$2
    
    log_info "Notification: $status - $message"
    
    # Possible future integrations:
    # - Slack webhook
    # - Email
    # - Telegram bot
    # - Discord webhook
}

# Main entrypoint
main() {
    echo -e "${PURPLE}"
    echo "========================================"
    echo "🚀 Books App Production Deployment"
    echo "========================================"
    echo -e "${NC}"
    
    if [[ "$ROLLBACK" == true ]]; then
    echo "Mode: ROLLBACK to previous version"
    else
        echo "Image Tag: $IMAGE_TAG"
        if [[ -n "$VERSION" && "$VERSION" != "$IMAGE_TAG" ]]; then
            echo "Git Version: $VERSION"
        fi
        echo "Registry: $REGISTRY"
    fi
    echo "Execution mode: $([ "$DRY_RUN" == true ] && echo "DRY RUN" || echo "LIVE DEPLOY")"
    echo ""
    
    if [[ "$FORCE" == false && "$DRY_RUN" == false ]]; then
        if [[ "$ROLLBACK" == true ]]; then
            read -p "Perform rollback? (y/N): " -n 1 -r
        else
            read -p "Deploy image $IMAGE_TAG? (y/N): " -n 1 -r
        fi
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Deployment cancelled by user"
            exit 0
        fi
    fi
    
    # Initialization
    mkdir -p "$LOG_DIR"
    
    log "Starting deployment of image $IMAGE_TAG"
    send_notification "START" "Deployment of image $IMAGE_TAG started"
    
    # Pre-deployment checks
    check_environment
    validate_env
    
    if [[ "$ROLLBACK" == true ]]; then
        perform_rollback
    send_notification "SUCCESS" "Rollback completed successfully"
    else
    # Main deployment sequence
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
            echo "✅ Deployment successful!"
            echo "========================================"
            echo -e "${NC}"
            echo "Image Tag: $IMAGE_TAG"
            if [[ -n "$VERSION" && "$VERSION" != "$IMAGE_TAG" ]]; then
                echo "Git Version: $VERSION"
            fi
            echo "Time: $(date)"
            echo "Logs: $LOG_DIR/deployment.log"
            
            send_notification "SUCCESS" "Image $IMAGE_TAG deployed successfully"
        else
            log_error "Deployment did not pass verification checks"
            send_notification "FAILURE" "Image $IMAGE_TAG failed verification checks"
            
            if [[ "$FORCE" == false ]]; then
                read -p "Perform automatic rollback? (Y/n): " -n 1 -r
                echo
                if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
                    perform_rollback
                    send_notification "ROLLBACK" "Automatic rollback performed after failed deployment"
                fi
            fi
            
            exit 1
        fi
    fi
}

# Error handling.
# `set -E` (errtrace) is required for the ERR trap to fire inside shell functions — the whole
# deployment runs in functions, so without it a `set -e` abort produced no message at all.
set -E
trap 'log_error "Error at line $LINENO. Exit code: $?"; send_notification "ERROR" "Deployment error at line $LINENO"' ERR

# Execute script
main "$@"
