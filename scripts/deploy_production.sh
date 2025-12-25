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
        execute "./scripts/backup_database.sh daily --tag pre-deploy-$(date +%Y%m%d-%H%M%S)"
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
    
    local current_commit=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    local current_tag=$(git describe --tags --exact-match 2>/dev/null || echo "no-tag")
    # docker compose images --format json outputs an array; prefer the 'app' service image
    local current_image=$(docker compose -f docker-compose.prod.yml images --format json \
        | jq -r 'map(select(.Service == "app")) | if length>0 then (.[0].Repository + ":" + .[0].Tag) else (.[0].Repository + ":" + .[0].Tag) end' 2>/dev/null || echo "unknown")
    
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
    
    # Create a temporary .env file for migration
    echo "DATABASE_URL=\"$dburl\"" > .env.migration
    
    # Use --env-file if supported (docker compose v2), otherwise fallback to -e
    if docker compose version | grep -q "v2"; then
         # Try to use --env-file, but some older v2 versions might not support it for 'run' command
         # So we will use the safe -e method but with the value from the file to avoid shell expansion issues
         # Actually, let's stick to the most compatible way: export the variable and pass it
         export DATABASE_URL="$dburl"
         # Note: When using -e VAR without value, docker compose looks up the value in the shell environment
         # However, sudo or other context switches might clear it.
         # Let's try passing it explicitly but quoted properly to avoid shell expansion of special chars
         execute "docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint '' -e DATABASE_URL=\"$dburl\" app npx prisma migrate deploy"
    else
         # Fallback for older versions
         execute "docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint '' -e DATABASE_URL=\"$dburl\" app npx prisma migrate deploy"
    fi
    
    rm -f .env.migration
    
    log_success "Migrations applied"
}

# Service deployment
deploy_services() {
    log "Deploying services..."
    
    cd "$DEPLOY_DIR"
    
    # Stopping current services
    execute "docker compose -f docker-compose.prod.yml down --timeout 30"
    
    # Starting new services
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
        
    # Checking Docker healthcheck status of the 'app' container
        local health_status
        health_status=$(docker compose -f docker-compose.prod.yml ps --format json app 2>/dev/null | jq -r '.Health // "none"')
        
        if [[ "$health_status" == "healthy" ]]; then
            log_success "Service is healthy"
            return 0
        fi
        
        ((attempt++))
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
        ((checks_passed++))
    else
    log_error "✗ Containers not running"
    fi
    
    # 2. Health check via Node (wget may be missing in the image)
    if [[ -n "$app_container" ]] && docker exec "$app_container" node -e "require('http').get('http://localhost:5000/api/health/liveness',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" &> /dev/null; then
    log_success "✓ Health check passed"
        ((checks_passed++))
    else
    log_error "✗ Health check failed"
    fi
    
    # 3. Database readiness check
    if [[ -n "$app_container" ]] && docker exec "$app_container" node -e "require('http').get('http://localhost:5000/api/health/readiness',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" &> /dev/null; then
    log_success "✓ Database connected"
        ((checks_passed++))
    else
    log_error "✗ Database not reachable"
    fi
    
    # 4. Metrics endpoint check
    if [[ -n "$app_container" ]] && docker exec "$app_container" node -e "require('http').get('http://localhost:5000/api/metrics',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" &> /dev/null; then
    log_success "✓ Metrics accessible"
        ((checks_passed++))
    else
    log_error "✗ Metrics not accessible"
    fi
    
    # 5. API version / container health via Docker healthcheck status
    local health_status
    health_status=$(docker compose -f docker-compose.prod.yml ps --format json app 2>/dev/null | jq -r '.Health // "none"')
    if [[ "$health_status" == "healthy" ]]; then
    log_success "✓ Docker healthcheck: $health_status"
        ((checks_passed++))
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
    
    log_success "Deployment state saved"
}

# Rollback to previous version
perform_rollback() {
    log "Performing rollback..."
    
    if [[ ! -f "$ROLLBACK_FILE" ]]; then
    log_error "Rollback file not found: $ROLLBACK_FILE"
        exit 1
    fi
    
    local rollback_version=$(jq -r '.commit // .tag' "$ROLLBACK_FILE" 2>/dev/null)
    if [[ -z "$rollback_version" || "$rollback_version" == "null" ]]; then
    log_error "Could not determine version for rollback"
        exit 1
    fi
    
    log_info "Rolling back to version: $rollback_version"
    
    VERSION="$rollback_version"
    update_code
    build_image
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
    
    # Keep only the latest 3 images
    execute "docker images books-app --format 'table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}' | tail -n +2 | sort -k3 -r | tail -n +4 | awk '{print \$1\":\"\$2}' | xargs -r docker rmi || true"
    
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

# Error handling
trap 'log_error "Error at line $LINENO. Exit code: $?"; send_notification "ERROR" "Deployment error at line $LINENO"' ERR

# Execute script
main "$@"
