#!/bin/bash
set -euo pipefail

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
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
            done < <(find "$dir" -name "books-db_*.sql*" -type f -print0 | sort -z)
        fi
    done
    
    if [[ ${#backups[@]} -eq 0 ]]; then
        log_warning "No backups found"
        return 1
    fi
    
    echo "Available backups:"
    for i in "${!backups[@]}"; do
        local backup_file="${backups[$i]}"
        local backup_date=$(basename "$backup_file" | sed 's/books-db_//' | sed 's/.sql.*//' | sed 's/_/ /')
        local backup_size=$(du -h "$backup_file" | cut -f1)
        local backup_age=$(find "$backup_file" -mtime +0 -printf "%Cr\n" 2>/dev/null || stat -c %y "$backup_file")
        
        echo "$((i+1)). $(basename "$backup_file") (size: $backup_size, created: $backup_age)"
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
    
    echo
    read -p "Select backup number to restore (1-${#available_backups[@]}): " selection
    
    if [[ ! "$selection" =~ ^[0-9]+$ ]] || [[ $selection -lt 1 ]] || [[ $selection -gt ${#available_backups[@]} ]]; then
        log_error "Invalid selection"
        return 1
    fi
    
    echo "${available_backups[$((selection-1))]}"
}

# Function to prepare backup file (decompress if needed)
prepare_backup_file() {
    local backup_file="$1"
    
    if [[ ! -f "$backup_file" ]]; then
        log_error "Backup file not found: $backup_file"
        return 1
    fi
    
    # Decompress if needed
    if [[ "$backup_file" == *.gz ]]; then
        log_info "Decompressing backup file..."
        local temp_file="/tmp/restore_$(basename "$backup_file" .gz)"
        
        if ! gunzip -c "$backup_file" > "$temp_file"; then
            log_error "Backup decompression failed"
            return 1
        fi
        
        echo "$temp_file"
    else
        echo "$backup_file"
    fi
}

# Function to create a backup of the current database
backup_current_database() {
    log_info "Creating pre-restore database backup..."
    
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
        log_success "Backup created: $backup_file"
        echo "$backup_file"
    else
        log_warning "Backup creation failed (database may be empty)"
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
        echo
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
    local restore_file
    if ! restore_file=$(prepare_backup_file "$backup_file"); then
        log_error "Failed to prepare backup file"
        exit 1
    fi
    
    log_info "Starting database restore..."
    
    local restore_success=false
    
    if [[ "$USE_DOCKER" == "true" ]]; then
        # Docker restore
        if docker exec -i "$(docker ps -qf name=postgres)" psql \
            -h localhost \
            -p 5432 \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            < "$restore_file" >/dev/null 2>&1; then
            restore_success=true
        fi
    else
        # Local restore
        if PGPASSWORD="$POSTGRES_PASSWORD" psql \
            -h "$POSTGRES_HOST" \
            -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            < "$restore_file" >/dev/null 2>&1; then
            restore_success=true
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
    
    # Backup current uploads directory
    if [[ -d "$UPLOADS_DIR" && "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
        local timestamp=$(date '+%Y%m%d_%H%M%S')
        local backup_current_uploads="/tmp/uploads_backup_${timestamp}.tar.gz"
        
        tar -czf "$backup_current_uploads" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" 2>/dev/null
        log_info "Current uploads saved to: $backup_current_uploads"
    fi
    
    # Restore uploads
    if tar -xzf "$uploads_backup" -C "$(dirname "$UPLOADS_DIR")" 2>/dev/null; then
        log_success "Uploads restored successfully"
        
        # Fix permissions
        chown -R deploy:deploy "$UPLOADS_DIR" 2>/dev/null || true
        chmod -R 755 "$UPLOADS_DIR" 2>/dev/null || true
        
        return 0
    else
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
    local backup_basename=$(basename "$backup_file" | sed 's/books-db_/uploads_/' | sed 's/.sql.*/.tar.gz/')
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
