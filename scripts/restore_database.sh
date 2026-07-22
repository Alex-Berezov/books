#!/bin/bash
set -euo pipefail

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions (all output to stderr so stdout is clean for variable capture)
log_info() {
    echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

# Source backup-specific environment (e.g., S3/R2 credentials)
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/opt/books/app/.env.backup}"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
    set -a
    source "$BACKUP_ENV_FILE"
    set +a
fi

# Default configuration
BACKUP_DIR="/opt/books/backups"
UPLOADS_DIR="/opt/books/uploads"

# PostgreSQL settings
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-books}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# Docker environment settings
USE_DOCKER="${USE_DOCKER:-auto}"

# Function to detect Docker volume name for uploads
detect_uploads_volume() {
    if [[ -n "${UPLOADS_DOCKER_VOLUME:-}" ]]; then
        echo "$UPLOADS_DOCKER_VOLUME"
        return
    fi
    
    local detected=""
    
    # Try docker compose config
    local compose_file="${DOCKER_COMPOSE_FILE:-docker-compose.prod.yml}"
    if [[ -f "$compose_file" ]]; then
        detected=$(docker compose -f "$compose_file" config --volumes 2>/dev/null | grep uploads_data_prod | head -1 || true)
        if [[ -n "$detected" ]] && ! docker volume inspect "$detected" &>/dev/null; then
            detected=""
        fi
    fi
    
    # Fallback: list Docker volumes by name suffix (handles project-name prefixing)
    if [[ -z "$detected" ]]; then
        detected=$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(^|_)uploads_data_prod$' | head -1 || true)
    fi
    
    # Final fallback
    if [[ -z "$detected" ]]; then
        detected="uploads_data_prod"
    fi
    
    echo "$detected"
}

# Function to determine connection method to PostgreSQL
detect_postgres_connection() {
    if [[ "$USE_DOCKER" == "auto" ]]; then
        if docker ps --format "table {{.Names}}" | grep -q postgres; then
            USE_DOCKER="true"
            log_info "Detected PostgreSQL in Docker container"
        elif command -v psql &> /dev/null; then
            USE_DOCKER="false"
            log_info "Detected local PostgreSQL installation"
        else
            log_error "PostgreSQL not found locally or in Docker"
            exit 1
        fi
    fi
}

# Function to test database connectivity
test_postgres_connection() {
    log_info "Testing PostgreSQL connectivity..."
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        if docker exec "$(docker ps -qf name=postgres)" pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
            log_success "Docker PostgreSQL connection successful"
            return 0
        else
            log_error "Unable to connect to PostgreSQL in Docker"
            return 1
        fi
    else
        if PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" >/dev/null 2>&1; then
            log_success "Local PostgreSQL connection successful"
            return 0
        else
            log_error "Unable to connect to local PostgreSQL"
            return 1
        fi
    fi
}

# Function to list available backups
list_available_backups() {
    local backup_type="${1:-all}"
    
    log_info "Searching for available backups..."
    
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
            done < <(find "$dir" \( -name "bibliaris-prod-*.sql*" -o -name "bibliaris-prod-*.dump" \) -type f -print0 | sort -z 2>/dev/null)
        fi
    done
    
    if [[ ${#backups[@]} -eq 0 ]]; then
        log_warning "No backups found"
        return 1
    fi
    
    # User-facing output to stderr; paths to stdout for capture
    echo "Available backups:" >&2
    for i in "${!backups[@]}"; do
        local backup_file="${backups[$i]}"
        local backup_date=$(basename "$backup_file" | sed 's/bibliaris-prod-[^-]*-//' | sed 's/\.[^.]*$//' | sed 's/-/ /g')
        local backup_size=$(du -h "$backup_file" | cut -f1)
        local backup_age=$(stat -c %y "$backup_file" 2>/dev/null | cut -d. -f1)
        
        echo "$((i+1)). $(basename "$backup_file") (size: $backup_size, created: $backup_age)" >&2
    done
    
    printf '%s\n' "${backups[@]}"
}

# Function to select a backup
select_backup() {
    local backup_type="${1:-all}"
    
    readarray -t available_backups < <(list_available_backups "$backup_type")
    
    if [[ ${#available_backups[@]} -eq 0 ]]; then
        return 1
    fi
    
    echo >&2
    read -p "Select backup number to restore (1-${#available_backups[@]}): " selection
    
    if [[ ! "$selection" =~ ^[0-9]+$ ]] || [[ $selection -lt 1 ]] || [[ $selection -gt ${#available_backups[@]} ]]; then
        log_error "Invalid selection"
        return 1
    fi
    
    echo "${available_backups[$((selection-1))]}"
}

# Function to prepare backup file (returns format and decompressed path if needed)
prepare_backup_file() {
    local backup_file="$1"
    
    if [[ ! -f "$backup_file" ]]; then
        log_error "Backup file not found: $backup_file"
        return 1
    fi
    
    local format="sql"
    local restore_file="$backup_file"
    
    # Detect format: .dump = custom-format (pg_restore), .sql / .sql.gz = plain (psql)
    if [[ "$backup_file" == *.dump ]]; then
        format="dump"
    elif [[ "$backup_file" == *.sql.gz ]]; then
        format="sql"
        log_info "Decompressing legacy backup file..."
        local temp_file="/tmp/restore_$(basename "$backup_file" .gz)"
        if ! gunzip -c "$backup_file" > "$temp_file"; then
            log_error "Backup decompression failed"
            return 1
        fi
        restore_file="$temp_file"
    elif [[ "$backup_file" == *.sql ]]; then
        format="sql"
    else
        log_warning "Unknown backup format, assuming plain SQL"
        format="sql"
    fi
    
    echo "$format|$restore_file"
}

# Function to create a backup of the current database
backup_current_database() {
    log_info "Creating pre-restore database backup..."
    
    local timestamp=$(date '+%Y-%m-%d-%H-%M')
    local backup_file="/tmp/pre_restore_backup_${timestamp}.dump"
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        local container_name
        container_name=$(docker ps -qf name=postgres)
        local container_dump_path="/tmp/$(basename "$backup_file")"
        docker exec "$container_name" pg_dump \
            -h localhost \
            -p 5432 \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            -Fc \
            --no-owner \
            --no-privileges \
            -f "$container_dump_path" 2>>"$LOG_FILE" \
            && docker cp "$container_name:$container_dump_path" "$backup_file" \
            && docker exec "$container_name" rm -f "$container_dump_path"
    else
        PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
            -h "$POSTGRES_HOST" \
            -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            -Fc \
            --no-owner \
            --no-privileges \
            -f - > "$backup_file" 2>>"$LOG_FILE"
    fi
    
    local dump_rc=$?
    if [[ $dump_rc -eq 0 && -f "$backup_file" && -s "$backup_file" ]]; then
        log_success "Backup created: $backup_file"
        echo "$backup_file"
    else
        log_warning "Pre-restore backup failed (exit: $dump_rc) — continuing anyway"
        if [[ -f "$LOG_FILE" ]]; then
            tail -3 "$LOG_FILE" | while IFS= read -r line; do log_warning "pg_dump: $line"; done
        fi
        log_warning "  Target: $backup_file"
        log_warning "  File exists: $(test -f "$backup_file" && echo yes || echo no)"
        log_warning "  Disk space: $(df -h "$(dirname "$backup_file")" 2>&1 | tail -1)"
        echo ""
    fi
}

# Function to restore the database
restore_database() {
    local backup_file="$1"
    local confirm_restore="${2:-false}"
    
    log_info "Restoring database from: $(basename "$backup_file")"
    
    # Confirm restore (destructive)
    if [[ "$confirm_restore" != "true" ]]; then
        echo >&2
        log_warning "WARNING: Restore will completely REPLACE the current database!"
        read -p "Are you sure you want to continue? (yes/no): " confirmation
        
        if [[ "$confirmation" != "yes" ]]; then
            log_info "Restore cancelled by user"
            exit 0
        fi
    fi
    
    # Backup current DB
    local current_backup
    current_backup=$(backup_current_database)
    
    # Stop application (if running)
    if docker ps --format "table {{.Names}}" | grep -q books-app; then
        log_info "Stopping application for restore..."
        docker stop books-app 2>/dev/null || true
    fi
    
    # Prepare backup file
    local prepare_result
    if ! prepare_result=$(prepare_backup_file "$backup_file"); then
        log_error "Failed to prepare backup file"
        exit 1
    fi
    
    local format="${prepare_result%%|*}"
    local restore_file="${prepare_result#*|}"
    
    log_info "Starting database restore (format: $format)..."
    
    local restore_success=false
    
    if [[ "$format" == "dump" ]]; then
        # Custom-format restore via pg_restore
        if [[ "$USE_DOCKER" == "true" ]]; then
            # Copy dump into container first, then pg_restore
            local container_name
            container_name=$(docker ps -qf name=postgres)
            docker cp "$restore_file" "${container_name}:/tmp/restore.dump" >/dev/null 2>&1
            if docker exec "$container_name" pg_restore \
                -h localhost \
                -p 5432 \
                -U "$POSTGRES_USER" \
                -d "$POSTGRES_DB" \
                --clean \
                --if-exists \
                --no-owner \
                --no-privileges \
                /tmp/restore.dump >/dev/null 2>&1; then
                restore_success=true
            fi
            docker exec "$container_name" rm -f /tmp/restore.dump >/dev/null 2>&1 || true
        else
            if PGPASSWORD="$POSTGRES_PASSWORD" pg_restore \
                -h "$POSTGRES_HOST" \
                -p "$POSTGRES_PORT" \
                -U "$POSTGRES_USER" \
                -d "$POSTGRES_DB" \
                --clean \
                --if-exists \
                --no-owner \
                --no-privileges \
                "$restore_file" >/dev/null 2>&1; then
                restore_success=true
            fi
        fi
    else
        # Legacy plain SQL restore via psql
        if [[ "$USE_DOCKER" == "true" ]]; then
            if docker exec -i "$(docker ps -qf name=postgres)" psql \
                -h localhost \
                -p 5432 \
                -U "$POSTGRES_USER" \
                -d "$POSTGRES_DB" \
                < "$restore_file" >/dev/null 2>&1; then
                restore_success=true
            fi
        else
            if PGPASSWORD="$POSTGRES_PASSWORD" psql \
                -h "$POSTGRES_HOST" \
                -p "$POSTGRES_PORT" \
                -U "$POSTGRES_USER" \
                -d "$POSTGRES_DB" \
                < "$restore_file" >/dev/null 2>&1; then
                restore_success=true
            fi
        fi
    fi
    
    # Cleanup temp file
    if [[ "$restore_file" == /tmp/* ]]; then
        rm -f "$restore_file"
    fi
    
    if [[ "$restore_success" == "true" ]]; then
        log_success "Database restored successfully"
        
        # Restart application
        if docker ps -a --format "table {{.Names}}" | grep -q books-app; then
            log_info "Starting application..."
            docker start books-app 2>/dev/null || true
        fi
        
        if [[ -n "$current_backup" ]]; then
            log_info "Pre-restore backup saved at: $current_backup"
        fi
        
        return 0
    else
        log_error "Database restore failed"
        
        # Attempt rollback
        if [[ -n "$current_backup" && -f "$current_backup" ]]; then
            log_info "Attempting to restore previous state..."
            if [[ "$current_backup" == *.dump ]]; then
                # Custom-format rollback via pg_restore
                if [[ "$USE_DOCKER" == "true" ]]; then
                    local container_name
                    container_name=$(docker ps -qf name=postgres)
                    docker cp "$current_backup" "${container_name}:/tmp/rollback.dump" >/dev/null 2>&1
                    docker exec "$container_name" pg_restore \
                        -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
                        --clean --if-exists --no-owner --no-privileges \
                        /tmp/rollback.dump >/dev/null 2>&1
                    docker exec "$container_name" rm -f /tmp/rollback.dump >/dev/null 2>&1 || true
                else
                    PGPASSWORD="$POSTGRES_PASSWORD" pg_restore \
                        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
                        -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
                        --clean --if-exists --no-owner --no-privileges \
                        "$current_backup" >/dev/null 2>&1
                fi
            else
                # Legacy plain SQL rollback
                if [[ "$USE_DOCKER" == "true" ]]; then
                    docker exec -i "$(docker ps -qf name=postgres)" psql \
                        -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
                        < "$current_backup" >/dev/null 2>&1
                else
                    PGPASSWORD="$POSTGRES_PASSWORD" psql \
                        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
                        -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
                        < "$current_backup" >/dev/null 2>&1
                fi
            fi
            log_warning "Previous state restored"
        fi
        
        return 1
    fi
}

# Function to restore media uploads
restore_uploads() {
    local uploads_backup="$1"
    
    if [[ ! -f "$uploads_backup" ]]; then
        log_warning "Uploads backup not found: $uploads_backup"
        return 0
    fi
    
    log_info "Restoring uploads from: $(basename "$uploads_backup")"
    
    local restore_ok=false
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        # Docker mode: restore to named volume
        local volume_name
        volume_name=$(detect_uploads_volume)
        if docker volume inspect "$volume_name" &>/dev/null; then
            log_info "Restoring to Docker volume: $volume_name"
            
            # Backup current state in volume
            local timestamp=$(date '+%Y%m%d_%H%M%S')
            local backup_current_uploads="/tmp/uploads_backup_${timestamp}.tar.gz"
            docker run --rm -v "${volume_name}:/data" -v "/tmp:/backup" alpine \
                tar -czf "/backup/uploads_backup_${timestamp}.tar.gz" -C /data . 2>/dev/null && \
                log_info "Current uploads saved to: $backup_current_uploads" || true
            
            # Restore from backup file into volume
            if docker run --rm -v "${volume_name}:/data" -v "$(dirname "$uploads_backup"):/backup" alpine \
                tar -xzf "/backup/$(basename "$uploads_backup")" -C /data 2>/dev/null; then
                restore_ok=true
                log_success "Uploads restored to Docker volume $volume_name"
            fi
        else
            log_warning "Docker volume $volume_name not found, falling back to host path"
        fi
    fi
    
    if [[ "$restore_ok" != "true" ]]; then
        # Fallback or local mode: restore to host directory
        # Backup current uploads
        if [[ -d "$UPLOADS_DIR" && "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
            local timestamp=$(date '+%Y%m%d_%H%M%S')
            local backup_current_uploads="/tmp/uploads_backup_${timestamp}.tar.gz"
            tar -czf "$backup_current_uploads" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" 2>/dev/null
            log_info "Current uploads saved to: $backup_current_uploads"
        fi
        
        # Restore
        if tar -xzf "$uploads_backup" -C "$(dirname "$UPLOADS_DIR")" 2>/dev/null; then
            restore_ok=true
            log_success "Uploads restored to host path $UPLOADS_DIR"
            
            # Fix permissions
            chown -R deploy:deploy "$UPLOADS_DIR" 2>/dev/null || true
            chmod -R 755 "$UPLOADS_DIR" 2>/dev/null || true
        fi
    fi
    
    if [[ "$restore_ok" != "true" ]]; then
        log_error "Uploads restore failed"
        return 1
    fi
}

# Function to verify integrity after restore
verify_restore() {
    log_info "Verifying integrity of restored database..."
    
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
        log_success "Integrity check passed (tables found: $table_count)"
        return 0
    else
        log_error "Integrity check failed"
        return 1
    fi
}

# Main function
main() {
    local backup_file="${1:-}"
    local backup_type="${2:-all}"
    local auto_confirm="${3:-false}"
    
    log_info "=== Restoring Books App from backup ==="
    
    # Detection & preparation
    detect_postgres_connection
    
    if ! test_postgres_connection; then
        log_error "Cannot connect to PostgreSQL"
        exit 1
    fi
    
    # Select backup file if not provided
    if [[ -z "$backup_file" ]]; then
        if ! backup_file=$(select_backup "$backup_type"); then
            log_error "Failed to select backup file"
            exit 1
        fi
    elif [[ ! -f "$backup_file" ]]; then
        log_error "Specified backup file not found: $backup_file"
        exit 1
    fi
    
    log_info "Selected backup: $(basename "$backup_file")"
    
    # Restore database
    if ! restore_database "$backup_file" "$auto_confirm"; then
        log_error "Database restore unsuccessful"
        exit 1
    fi
    
    # Locate and restore uploads archive if present
    local uploads_backup_file
    local backup_basename=$(basename "$backup_file" | sed 's/bibliaris-prod-[^-]*-/bibliaris-prod-uploads-/' | sed 's/\.sql.*/.tar.gz/' | sed 's/\.dump/.tar.gz/')
    local backup_dir=$(dirname "$backup_file")
    uploads_backup_file="${backup_dir}/${backup_basename}"
    
    restore_uploads "$uploads_backup_file"
    
    # Integrity verification
    if verify_restore; then
        log_success "=== Restore completed successfully ==="
    else
        log_error "=== Restore completed with errors ==="
        exit 1
    fi
}

# Arguments parsing and help
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: $0 [backup_file] [backup_type] [auto_confirm]"
    echo
    echo "Parameters:"
    echo "  backup_file   - path to backup file (if omitted, interactive selection)"
    echo "  backup_type   - backup type to search (daily/weekly/monthly/all)"
    echo "  auto_confirm  - automatic confirmation (true/false)"
    echo
    echo "Environment Variables:"
    echo "  USE_DOCKER        - use Docker (true/false/auto)"
    echo "  POSTGRES_HOST     - PostgreSQL host (localhost)"
    echo "  POSTGRES_PORT     - PostgreSQL port (5432)"
    echo "  POSTGRES_DB       - database name (books)"
    echo "  POSTGRES_USER     - PostgreSQL user (postgres)"
    echo "  POSTGRES_PASSWORD - PostgreSQL password"
    echo
    echo "Examples:"
    echo "  $0                                    # interactive selection"
    echo "  $0 /path/to/backup.sql.gz            # restore specific file"
    echo "  $0 '' daily                          # choose from daily backups"
    echo "  $0 /path/to/backup.sql.gz '' true    # auto confirmation"
    echo
    echo "WARNING: Restore will completely replace the current database!"
    exit 0
fi

# Run main function
main "$@"
