#!/bin/bash
set -euo pipefail

# Colors for terminal output
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
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPRESS_BACKUPS="${COMPRESS_BACKUPS:-true}"
BACKUP_PREFIX="${BACKUP_PREFIX:-bibliaris-prod}"
LOG_FILE="${BACKUP_DIR}/backup.log"
UPLOADS_DIR="/opt/books/uploads"
INCLUDE_UPLOADS="${INCLUDE_UPLOADS:-true}"
BACKUP_TAG=""

# PostgreSQL settings (can be overridden via environment variables)
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-books}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# Docker environment settings
DOCKER_COMPOSE_FILE="${DOCKER_COMPOSE_FILE:-docker-compose.prod.yml}"
DOCKER_POSTGRES_SERVICE="${DOCKER_POSTGRES_SERVICE:-postgres}"
USE_DOCKER="${USE_DOCKER:-auto}"

# S3-compatible remote storage settings
BACKUP_REMOTE_ENABLED="${BACKUP_REMOTE_ENABLED:-0}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-prod/postgres}"
BACKUP_S3_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}"
BACKUP_S3_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-auto}"

# S3 retention defaults (overridable per type)
BACKUP_RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-30}"
BACKUP_RETENTION_WEEKLY="${BACKUP_RETENTION_WEEKLY:-56}"
BACKUP_RETENTION_MONTHLY="${BACKUP_RETENTION_MONTHLY:-365}"
BACKUP_RETENTION_BEFORE_DEPLOY="${BACKUP_RETENTION_BEFORE_DEPLOY:-30}"

# Function to detect how to connect to PostgreSQL
detect_postgres_connection() {
    if [[ "$USE_DOCKER" == "auto" ]]; then
        if docker ps --format "table {{.Names}}" | grep -q postgres; then
            USE_DOCKER="true"
            log_info "Detected PostgreSQL in Docker container"
        elif command -v psql &> /dev/null; then
            USE_DOCKER="false"
            log_info "Detected local PostgreSQL"
        else
            log_error "PostgreSQL not found locally or in Docker"
            exit 1
        fi
    fi
}

# Function to test PostgreSQL connection
test_postgres_connection() {
    log_info "Checking connection to PostgreSQL..."
    
    if [[ "$USE_DOCKER" == "true" ]]; then
    # Test via Docker
        if docker exec "$(docker ps -qf name=postgres)" pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
            log_success "Connection to PostgreSQL in Docker succeeded"
            return 0
        else
            log_error "Failed to connect to PostgreSQL in Docker"
            return 1
        fi
    else
    # Test local connection
        if PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" >/dev/null 2>&1; then
            log_success "Connection to local PostgreSQL succeeded"
            return 0
        else
            log_error "Failed to connect to local PostgreSQL"
            return 1
        fi
    fi
}

# Function to create backup directories
setup_backup_directories() {
    log_info "Creating backup directories..."
    
    # Create main backup directory
    mkdir -p "$BACKUP_DIR"
    
    # Create subdirectories by backup type (organization)
    mkdir -p "$BACKUP_DIR/daily"
    mkdir -p "$BACKUP_DIR/weekly"
    mkdir -p "$BACKUP_DIR/monthly"
    
    # Check write permissions
    if [[ ! -w "$BACKUP_DIR" ]]; then
    log_error "No write permissions for backup directory: $BACKUP_DIR"
        exit 1
    fi
    
    log_success "Backup directories ready"
}

# Function to create database backup
backup_database() {
    local backup_type="${1:-daily}"
    local timestamp=$(date '+%Y-%m-%d-%H-%M')
    local filename_suffix=""
    if [[ -n "$BACKUP_TAG" ]]; then
        filename_suffix="-${BACKUP_TAG}"
    fi
    local backup_file="${BACKUP_DIR}/${backup_type}/${BACKUP_PREFIX}-${backup_type}${filename_suffix}-${timestamp}.dump"
    
    log_info "Creating database backup (type: $backup_type)..."
    
    if [[ "$USE_DOCKER" == "true" ]]; then
    # Find PostgreSQL container
        local postgres_container=$(docker ps -qf name=postgres)
        
        if [[ -z "$postgres_container" ]]; then
            log_error "PostgreSQL container not found"
            return 1
        fi
        
    # Get environment variables from container
        local container_user=$(docker exec "$postgres_container" env | grep "^POSTGRES_USER=" | cut -d= -f2)
        local container_db=$(docker exec "$postgres_container" env | grep "^POSTGRES_DB=" | cut -d= -f2)
        
    # Use container variables if present
        local db_user="${container_user:-$POSTGRES_USER}"
        local db_name="${container_db:-$POSTGRES_DB}"
        
    log_info "Using database: $db_name, user: $db_user"
        
    # Backup via Docker (custom-format)
        docker exec "$postgres_container" pg_dump \
            -h localhost \
            -p 5432 \
            -U "$db_user" \
            -d "$db_name" \
            -Fc \
            --no-owner \
            --no-privileges \
            --verbose \
            -f - > "$backup_file" 2>>"$LOG_FILE"
    else
    # Local backup (custom-format)
        PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
            -h "$POSTGRES_HOST" \
            -p "$POSTGRES_PORT" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            -Fc \
            --no-owner \
            --no-privileges \
            --verbose \
            -f - > "$backup_file" 2>>"$LOG_FILE"
    fi
    
    if [[ $? -eq 0 && -f "$backup_file" && -s "$backup_file" ]]; then
    log_success "Database backup created: $(basename "$backup_file") (custom-format .dump)"
        
    # Check backup file size
        local file_size=$(du -h "$backup_file" | cut -f1)
    log_info "Backup size: $file_size"
        
        echo "$backup_file"
    else
    log_error "Error creating database backup"
        return 1
    fi
}

# Function to create uploads/media backup
backup_uploads() {
    local backup_type="${1:-daily}"
    local timestamp=$(date '+%Y-%m-%d-%H-%M')
    local filename_suffix=""
    if [[ -n "$BACKUP_TAG" ]]; then
        filename_suffix="-${BACKUP_TAG}"
    fi
    local backup_file="${BACKUP_DIR}/${backup_type}/bibliaris-prod-uploads${filename_suffix}-${timestamp}.tar.gz"
    
    if [[ "$INCLUDE_UPLOADS" != "true" ]]; then
    log_info "Uploads/media backup disabled"
        return 0
    fi
    
    if [[ ! -d "$UPLOADS_DIR" ]]; then
    log_warning "Uploads directory not found: $UPLOADS_DIR"
        return 0
    fi
    
    log_info "Creating uploads/media backup..."
    
    # Count files for backup
    local file_count=$(find "$UPLOADS_DIR" -type f | wc -l)
    log_info "Files found for backup: $file_count"
    
    if [[ $file_count -eq 0 ]]; then
    log_warning "No files to backup in $UPLOADS_DIR"
        return 0
    fi
    
    # Create archive
    tar -czf "$backup_file" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" 2>>"$LOG_FILE"
    
    if [[ $? -eq 0 && -f "$backup_file" ]]; then
        local file_size=$(du -h "$backup_file" | cut -f1)
    log_success "Uploads/media backup created: $(basename "$backup_file") (size: $file_size)"
        echo "$backup_file"
    else
    log_error "Error creating uploads/media backup"
        return 1
    fi
}

# Function to rotate (clean up) old backups
cleanup_old_backups() {
    local backup_type="${1:-daily}"
    local retention_days="$BACKUP_RETENTION_DAYS"
    
    log_info "Cleaning up old backups (older than $retention_days days)..."
    
    local cleanup_dir="${BACKUP_DIR}/${backup_type}"
    local deleted_count=0
    
    if [[ -d "$cleanup_dir" ]]; then
    # Delete files older than retention period
        while IFS= read -r -d '' file; do
            rm "$file"
            ((deleted_count++))
            log_info "Deleted old backup: $(basename "$file")"
        done < <(find "$cleanup_dir" -type f \( -name "*.sql" -o -name "*.sql.gz" -o -name "*.dump" -o -name "*.tar.gz" \) -mtime +$retention_days -print0 2>/dev/null)
    fi
    
    if [[ $deleted_count -gt 0 ]]; then
    log_success "Old backups deleted: $deleted_count"
    else
    log_info "No old backups found"
    fi
}

# Function to generate backup report
generate_backup_report() {
    local db_backup_file="$1"
    local uploads_backup_file="$2"
    local backup_type="${3:-daily}"
    
    log_info "Generating backup report..."
    
    local report_file="${BACKUP_DIR}/backup_report_$(date '+%Y%m%d_%H%M%S').txt"
    
    {
    echo "=== Backup Creation Report ==="
    echo "Date & Time: $(date)"
    echo "Backup type: $backup_type"
    echo "Host: $(hostname)"
        echo ""
        
    echo "=== Database ==="
        if [[ -n "$db_backup_file" && -f "$db_backup_file" ]]; then
            echo "File: $(basename "$db_backup_file")"
            echo "Size: $(du -h "$db_backup_file" | cut -f1)"
            echo "Path: $db_backup_file"
            echo "Status: Success"
        else
            echo "Status: Error"
        fi
        echo ""
        
    echo "=== Media Uploads ==="
        if [[ "$INCLUDE_UPLOADS" == "true" ]]; then
            if [[ -n "$uploads_backup_file" && -f "$uploads_backup_file" ]]; then
                echo "File: $(basename "$uploads_backup_file")"
                echo "Size: $(du -h "$uploads_backup_file" | cut -f1)"
                echo "Path: $uploads_backup_file"
                echo "Status: Success"
            else
                echo "Status: Error or no files"
            fi
        else
            echo "Status: Disabled"
        fi
        echo ""
        
    echo "=== Configuration ==="
    echo "Retention: $BACKUP_RETENTION_DAYS days"
    echo "Compression: $COMPRESS_BACKUPS"
    echo "PostgreSQL: $POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
    echo "Connection method: $([ "$USE_DOCKER" == "true" ] && echo "Docker" || echo "Local")"
    } > "$report_file"
    
    log_success "Report created: $(basename "$report_file")"
    
    # Print concise summary to console
    echo ""
    echo "=== FINAL SUMMARY ==="
    if [[ -n "$db_backup_file" && -f "$db_backup_file" ]]; then
    echo -e "${GREEN}✓${NC} Database: $(basename "$db_backup_file") ($(du -h "$db_backup_file" | cut -f1))"
    else
    echo -e "${RED}✗${NC} Database: Error"
    fi
    
    if [[ "$INCLUDE_UPLOADS" == "true" ]]; then
        if [[ -n "$uploads_backup_file" && -f "$uploads_backup_file" ]]; then
            echo -e "${GREEN}✓${NC} Media uploads: $(basename "$uploads_backup_file") ($(du -h "$uploads_backup_file" | cut -f1))"
        else
            echo -e "${YELLOW}!${NC} Media uploads: Skipped or error"
        fi
    fi
}

# Function to upload backup file to S3-compatible remote storage
upload_to_remote() {
    local backup_file="$1"
    local backup_type="${2:-daily}"
    
    if [[ "$BACKUP_REMOTE_ENABLED" != "1" ]]; then
        log_info "Remote backup upload disabled (BACKUP_REMOTE_ENABLED != 1)"
        return 0
    fi
    
    if [[ -z "$BACKUP_S3_BUCKET" || -z "$BACKUP_S3_ENDPOINT" ]]; then
        log_warning "Remote backup enabled but S3 bucket or endpoint not configured"
        return 0
    fi
    
    if ! command -v aws &> /dev/null; then
        log_error "aws CLI not found. Install it for remote backup upload."
        log_error "See: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
        return 1
    fi
    
    local remote_path="${BACKUP_S3_PREFIX}/${backup_type}/$(basename "$backup_file")"
    local s3_uri="s3://${BACKUP_S3_BUCKET}/${remote_path}"
    
    log_info "Uploading backup to remote storage: ${s3_uri}"
    
    # Configure AWS env vars for S3-compatible storage
    export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
    export AWS_DEFAULT_REGION="$BACKUP_S3_REGION"
    
    local aws_args=("--endpoint-url" "$BACKUP_S3_ENDPOINT")
    
    if aws s3 cp "$backup_file" "$s3_uri" "${aws_args[@]}" 2>>"$LOG_FILE"; then
        log_success "Remote upload completed: $(basename "$backup_file")"
        echo "$s3_uri"
        return 0
    else
        log_error "Remote upload failed for: $(basename "$backup_file")"
        return 1
    fi
}

# Function to apply retention policy to remote storage
cleanup_remote_old_backups() {
    local backup_type="${1:-daily}"
    
    if [[ "$BACKUP_REMOTE_ENABLED" != "1" || -z "$BACKUP_S3_BUCKET" ]]; then
        return 0
    fi
    
    # Determine retention days based on backup type
    local retention_days
    case "$backup_type" in
        daily) retention_days="$BACKUP_RETENTION_DAILY" ;;
        weekly) retention_days="$BACKUP_RETENTION_WEEKLY" ;;
        monthly) retention_days="$BACKUP_RETENTION_MONTHLY" ;;
        before-deploy) retention_days="$BACKUP_RETENTION_BEFORE_DEPLOY" ;;
        *) retention_days="$BACKUP_RETENTION_DAYS" ;;
    esac
    
    log_info "Applying remote retention for ${backup_type} backups (older than ${retention_days} days)..."
    
    local remote_prefix="${BACKUP_S3_PREFIX}/${backup_type}/"
    local s3_uri="s3://${BACKUP_S3_BUCKET}/${remote_prefix}"
    
    export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
    export AWS_DEFAULT_REGION="$BACKUP_S3_REGION"
    local aws_args=("--endpoint-url" "$BACKUP_S3_ENDPOINT")
    
    # List remote objects
    local objects
    objects=$(aws s3 ls "$s3_uri" "${aws_args[@]}" 2>/dev/null) || {
        log_warning "Could not list remote objects (bucket or prefix may be empty)"
        return 0
    }
    
    if [[ -z "$objects" ]]; then
        log_info "No remote objects found for retention check"
        return 0
    fi
    
    local cutoff_date=$(date -d "-${retention_days} days" '+%Y-%m-%d')
    local deleted_count=0
    local kept_count=0
    
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        local obj_date=$(echo "$line" | awk '{print $1}')
        local obj_name=$(echo "$line" | awk '{print $4}')
        
        if [[ "$obj_date" < "$cutoff_date" ]]; then
            # Keep at least one backup (the most recent one in the old batch)
            if [[ $kept_count -eq 0 ]]; then
                kept_count=1
                log_info "Keeping oldest backup (safety): ${obj_name}"
                continue
            fi
            
            if aws s3 rm "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/${backup_type}/${obj_name}" "${aws_args[@]}" 2>>"$LOG_FILE"; then
                log_info "Deleted remote backup: ${obj_name}"
                ((deleted_count++))
            else
                log_warning "Failed to delete remote backup: ${obj_name}"
            fi
        else
            ((kept_count++))
        fi
    done <<< "$objects"
    
    if [[ $deleted_count -gt 0 ]]; then
        log_success "Remote retention: deleted ${deleted_count} old backups"
    else
        log_info "No old remote backups to delete"
    fi
}

# Main function
main() {
    local backup_type="${1:-daily}"
    
    # Initialize logging
    mkdir -p "$(dirname "$LOG_FILE")"
    
    {
    echo "=== Backup creation started ==="
    echo "Date: $(date)"
    echo "Type: $backup_type"
        echo "PID: $$"
    } >> "$LOG_FILE"
    
    log_info "=== Creating Books App backup (type: $backup_type) ==="
    
    # Checks and preparation
    detect_postgres_connection
    
    if ! test_postgres_connection; then
    log_error "Cannot connect to PostgreSQL"
        exit 1
    fi
    
    setup_backup_directories
    
    # Creating backups
    local db_backup_file=""
    local uploads_backup_file=""
    
    # Database backup
    if db_backup_file=$(backup_database "$backup_type"); then
    log_success "Database backup completed"
    else
    log_error "Error creating database backup"
        exit 1
    fi
    
    # Media (uploads) backup
    if uploads_backup_file=$(backup_uploads "$backup_type"); then
    log_success "Uploads/media backup completed"
    fi
    
    # Upload to remote storage
    local remote_upload_failed=false
    
    if [[ -n "$db_backup_file" && -f "$db_backup_file" ]]; then
        if ! upload_to_remote "$db_backup_file" "$backup_type"; then
            remote_upload_failed=true
            log_error "Database backup remote upload FAILED"
        fi
    fi
    
    if [[ -n "$uploads_backup_file" && -f "$uploads_backup_file" ]]; then
        if ! upload_to_remote "$uploads_backup_file" "$backup_type"; then
            remote_upload_failed=true
            log_error "Uploads backup remote upload FAILED"
        fi
    fi
    
    # Fail if remote upload is enabled and failed
    if [[ "$remote_upload_failed" == "true" && "$BACKUP_REMOTE_ENABLED" == "1" ]]; then
        log_error "Remote backup upload failed — aborting (BACKUP_REMOTE_ENABLED=1)"
        exit 1
    fi
    
    # Apply remote retention
    cleanup_remote_old_backups "$backup_type"
    
    # Cleanup old local backups
    cleanup_old_backups "$backup_type"
    
    # Generate report
    generate_backup_report "$db_backup_file" "$uploads_backup_file" "$backup_type"
    
    log_success "=== Backup creation completed successfully ==="
    
    {
    echo "=== Backup creation finished ==="
    echo "Status: Success"
    echo "End time: $(date)"
        echo ""
    } >> "$LOG_FILE"
}

# Argument parsing and help section
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: $0 [backup_type] [--tag LABEL]"
    echo
    echo "Backup types:"
    echo "  daily         - daily backup (default)"
    echo "  weekly        - weekly backup"  
    echo "  monthly       - monthly backup"
    echo "  before-deploy - pre-deployment backup"
    echo
    echo "Options:"
    echo "  --tag LABEL   - add label to backup filename (e.g. --tag pre-deploy-20260722)"
    echo
    echo "Environment variables:"
    echo "  BACKUP_DIR              - backup directory (/opt/books/backups)"
    echo "  BACKUP_RETENTION_DAYS   - retention period in days (14)"
    echo "  COMPRESS_BACKUPS        - compress backups (true/false)"
    echo "  INCLUDE_UPLOADS         - include uploads/media files (true/false)"
    echo "  USE_DOCKER              - use Docker (true/false/auto)"
    echo "  POSTGRES_HOST           - PostgreSQL host (localhost)"
    echo "  POSTGRES_PORT           - PostgreSQL port (5432)"
    echo "  POSTGRES_DB             - database name (books)"
    echo "  POSTGRES_USER           - PostgreSQL user (postgres)"
    echo "  POSTGRES_PASSWORD       - PostgreSQL password"
    echo ""
    echo "Remote storage (S3-compatible):"
    echo "  BACKUP_REMOTE_ENABLED   - enable remote upload (0/1, default 0)"
    echo "  BACKUP_S3_ENDPOINT      - S3 endpoint URL"
    echo "  BACKUP_S3_BUCKET        - S3 bucket name"
    echo "  BACKUP_S3_PREFIX        - path prefix in bucket (prod/postgres)"
    echo "  BACKUP_S3_ACCESS_KEY_ID - S3 access key"
    echo "  BACKUP_S3_SECRET_ACCESS_KEY - S3 secret key"
    echo "  BACKUP_S3_REGION        - S3 region (auto)"
    echo ""
    echo "Retention (remote):"
    echo "  BACKUP_RETENTION_DAILY  - daily backup retention days (30)"
    echo "  BACKUP_RETENTION_WEEKLY - weekly backup retention days (56)"
    echo "  BACKUP_RETENTION_MONTHLY - monthly backup retention days (365)"
    echo "  BACKUP_RETENTION_BEFORE_DEPLOY - before-deploy retention days (30)"
    echo
    echo "Examples:"
    echo "  $0                      # daily backup"
    echo "  $0 weekly               # weekly backup"
    echo "  $0 daily --tag pre-deploy-20260722  # tagged daily backup"
    echo "  $0 before-deploy        # pre-deployment backup"
    echo "  INCLUDE_UPLOADS=false $0  # without media uploads"
    exit 0
fi

# Parse arguments
BACKUP_TYPE="daily"
BACKUP_TAG=""

while [[ $# -gt 0 ]]; do
    case $1 in
        daily|weekly|monthly|before-deploy)
            BACKUP_TYPE="$1"
            shift
            ;;
        --tag)
            if [[ -n "${2:-}" ]]; then
                BACKUP_TAG="$2"
                shift 2
            else
                log_error "--tag requires a value"
                exit 1
            fi
            ;;
        *)
            log_error "Unknown argument: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Run main function
main "$BACKUP_TYPE"
