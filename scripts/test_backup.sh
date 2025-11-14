#!/bin/bash
set -euo pipefail

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging helpers
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

# Counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_WARNING=0

# Configuration
BACKUP_DIR="/opt/books/backups"
MIN_BACKUP_SIZE_MB="${MIN_BACKUP_SIZE_MB:-1}"
MAX_BACKUP_AGE_DAYS="${MAX_BACKUP_AGE_DAYS:-7}"

# Counter increment helpers
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

# Check existence of backup directories
check_backup_directories() {
    log_info "Checking backup directories..."
    
    if [[ -d "$BACKUP_DIR" ]]; then
    pass_test "Primary backup directory exists: $BACKUP_DIR"
    else
    fail_test "Primary backup directory not found: $BACKUP_DIR"
        return
    fi
    
    for subdir in daily weekly monthly; do
        local dir_path="$BACKUP_DIR/$subdir"
        if [[ -d "$dir_path" ]]; then
            pass_test "Subdirectory $subdir exists"
        else
            warn_test "Subdirectory $subdir not found (will be created at first backup)"
        fi
    done
    
    # Check write permissions
    if [[ -w "$BACKUP_DIR" ]]; then
    pass_test "Write permissions on backup directory OK"
    else
    fail_test "No write permission to backup directory"
    fi
}

# Check presence of backup files
check_backup_files() {
    log_info "Checking backup files..."
    
    local total_backups=0
    local total_size=0
    
    for backup_type in daily weekly monthly; do
        local dir_path="$BACKUP_DIR/$backup_type"
        local backup_count=0
        local dir_size=0
        
        if [[ -d "$dir_path" ]]; then
            # Counting database backups
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
            pass_test "Found $backup_count $backup_type backups (size: ${dir_size_mb}MB)"
        else
            warn_test "$backup_type backups not found"
        fi
    done
    
    if [[ $total_backups -gt 0 ]]; then
        local total_size_mb=$((total_size / 1024 / 1024))
    pass_test "Total backups: $total_backups (aggregate size: ${total_size_mb}MB)"
    else
    fail_test "No backups found"
    fi
}

# Check freshness of backups
check_backup_freshness() {
    log_info "Checking backup freshness..."
    
    local latest_backup=""
    local latest_timestamp=0
    
    # Find most recent backup
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
        
    pass_test "Latest backup: $(basename "$latest_backup")"
    log_info "Created at: $backup_date (age: $backup_age_days days)"
        
        if [[ $backup_age_days -le $MAX_BACKUP_AGE_DAYS ]]; then
            pass_test "Backup is fresh (age $backup_age_days days <= $MAX_BACKUP_AGE_DAYS days)"
        else
            fail_test "Backup outdated (age $backup_age_days days > $MAX_BACKUP_AGE_DAYS days)"
        fi
    else
    fail_test "No backups found for freshness check"
    fi
}

# Check backup sizes
check_backup_sizes() {
    log_info "Checking backup sizes..."
    
    local min_size_bytes=$((MIN_BACKUP_SIZE_MB * 1024 * 1024))
    local small_backups=0
    
    while IFS= read -r -d '' file; do
        local file_size=$(du -b "$file" | cut -f1)
        local file_size_mb=$((file_size / 1024 / 1024))
        
        if [[ $file_size -ge $min_size_bytes ]]; then
            pass_test "$(basename "$file"): size OK (${file_size_mb}MB)"
        else
            fail_test "$(basename "$file"): suspicious small size (${file_size_mb}MB < ${MIN_BACKUP_SIZE_MB}MB)"
            ((small_backups++))
        fi
    done < <(find "$BACKUP_DIR" -name "books-db_*.sql*" -type f -print0 2>/dev/null)
    
    if [[ $small_backups -eq 0 ]]; then
    pass_test "All backups have acceptable size"
    fi
}

# Check integrity of compressed backups
check_compressed_integrity() {
    log_info "Checking integrity of compressed backups..."
    
    local corrupted_backups=0
    
    while IFS= read -r -d '' file; do
        if gzip -t "$file" 2>/dev/null; then
            pass_test "$(basename "$file"): compression OK"
        else
            fail_test "$(basename "$file"): corrupted archive"
            ((corrupted_backups++))
        fi
    done < <(find "$BACKUP_DIR" -name "*.gz" -type f -print0 2>/dev/null)
    
    if [[ $corrupted_backups -eq 0 ]]; then
    pass_test "All compressed backups pass integrity test"
    fi
}

# Check SQL backup structure
check_sql_structure() {
    log_info "Checking SQL backup structure..."
    
    # Find one of the latest backups for validation
    local test_backup=""
    test_backup=$(find "$BACKUP_DIR" -name "books-db_*.sql*" -type f -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
    
    if [[ -z "$test_backup" ]]; then
    warn_test "No backups available for structure check"
        return
    fi
    
    log_info "Structure check: $(basename "$test_backup")"
    
    # Prepare file sample for analysis
    local sql_content=""
    if [[ "$test_backup" == *.gz ]]; then
        sql_content=$(gunzip -c "$test_backup" | head -50)
    else
        sql_content=$(head -50 "$test_backup")
    fi
    
    # Check for key elements
    if echo "$sql_content" | grep -q "PostgreSQL database dump"; then
    pass_test "SQL backup contains PostgreSQL header"
    else
    warn_test "SQL backup may be damaged (missing PostgreSQL header)"
    fi
    
    if echo "$sql_content" | grep -q "CREATE TABLE\|DROP TABLE"; then
    pass_test "SQL backup contains DDL statements"
    else
    warn_test "SQL backup may lack table structure"
    fi
    
    # Verify presence of key project tables
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
    pass_test "SQL backup contains core project tables ($found_tables/${#expected_tables[@]})"
    else
    fail_test "SQL backup missing many project tables ($found_tables/${#expected_tables[@]})"
    fi
}

# Check media uploads backups
check_uploads_backups() {
    log_info "Checking media uploads backups..."
    
    local uploads_count=0
    
    while IFS= read -r -d '' file; do
        ((uploads_count++))
        
    # Archive integrity check
        if tar -tzf "$file" >/dev/null 2>&1; then
            pass_test "$(basename "$file"): uploads archive OK"
        else
            fail_test "$(basename "$file"): corrupted uploads archive"
        fi
        
    # Archive content check
        local files_in_archive=$(tar -tzf "$file" 2>/dev/null | wc -l)
        if [[ $files_in_archive -gt 0 ]]; then
            pass_test "$(basename "$file"): contains $files_in_archive files"
        else
            warn_test "$(basename "$file"): archive empty or damaged"
        fi
        
    done < <(find "$BACKUP_DIR" -name "uploads_*.tar.gz" -type f -print0 2>/dev/null)
    
    if [[ $uploads_count -eq 0 ]]; then
    warn_test "Uploads backups not found (may be disabled)"
    else
    pass_test "Found uploads backups: $uploads_count"
    fi
}

# Check backup logs
check_backup_logs() {
    log_info "Checking backup logs..."
    
    local log_file="$BACKUP_DIR/backup.log"
    
    if [[ -f "$log_file" ]]; then
    pass_test "Backup log file exists"
        
        local log_size=$(du -h "$log_file" | cut -f1)
    log_info "Backup log size: $log_size"
        
    # Check recent entries
        local recent_entries=$(tail -10 "$log_file" | grep -c "$(date '+%Y-%m-%d')" || true)
        if [[ $recent_entries -gt 0 ]]; then
            pass_test "Log contains today's entries: $recent_entries"
        else
            warn_test "No log entries for today"
        fi
        
    # Check for error entries
        local error_count=$(grep -c "ERROR\|FAIL" "$log_file" || true)
        if [[ $error_count -eq 0 ]]; then
            pass_test "No error entries found in log"
        else
            warn_test "Error entries found in log: $error_count"
        fi
    else
    warn_test "Backup log file not found: $log_file"
    fi
}

# Check disk space
check_disk_space() {
    log_info "Checking disk space..."
    
    local backup_fs=$(df "$BACKUP_DIR" | tail -1)
    local available_space=$(echo "$backup_fs" | awk '{print $4}')
    local available_gb=$((available_space / 1024 / 1024))
    local used_percent=$(echo "$backup_fs" | awk '{print $5}' | tr -d '%')
    
    log_info "Available space: ${available_gb}GB (used: ${used_percent}%)"
    
    if [[ $used_percent -lt 80 ]]; then
    pass_test "Sufficient free space (used ${used_percent}% < 80%)"
    elif [[ $used_percent -lt 90 ]]; then
    warn_test "Low free space (used ${used_percent}%)"
    else
    fail_test "Critical disk usage (used ${used_percent}% >= 90%)"
    fi
    
    if [[ $available_gb -gt 1 ]]; then
    pass_test "Enough space for new backups (${available_gb}GB)"
    else
    fail_test "Not enough space for new backups (${available_gb}GB < 1GB)"
    fi
}

# Check backup schedule (cron)
check_backup_schedule() {
    log_info "Checking backup schedule..."
    
    # Check cron jobs for current user
    if crontab -l 2>/dev/null | grep -q "backup_database.sh"; then
    pass_test "User cron job for backups found"
    else
    warn_test "User cron job for backups not found"
    fi
    
    # Check system-level cron jobs
    if [[ -f "/etc/cron.d/books_backup" ]] || ls /etc/cron.*/*books* >/dev/null 2>&1; then
    pass_test "System cron job for backups found"
    else
    warn_test "System cron job for backups not found"
    fi
    
    # Check cron service status
    if systemctl is-active cron >/dev/null 2>&1 || systemctl is-active crond >/dev/null 2>&1; then
    pass_test "Cron service active"
    else
    fail_test "Cron service inactive"
    fi
}

# Generate report
generate_report() {
    local report_file="$BACKUP_DIR/integrity_report_$(date '+%Y%m%d_%H%M%S').txt"
    
    {
    echo "=== Backup Integrity Report ==="
    echo "Check date: $(date)"
    echo "Server: $(hostname)"
        echo ""
    echo "=== Results ==="
    echo "Tests passed: $TESTS_PASSED"
    echo "Warnings: $TESTS_WARNING"
    echo "Failures: $TESTS_FAILED"
        echo ""
    echo "=== Backup Statistics ==="
        
    # Per-type statistics
        for backup_type in daily weekly monthly; do
            local dir_path="$BACKUP_DIR/$backup_type"
            if [[ -d "$dir_path" ]]; then
                local count=$(find "$dir_path" -name "books-db_*.sql*" -type f | wc -l)
                local size=$(du -sh "$dir_path" 2>/dev/null | cut -f1 || echo "0")
                echo "$backup_type: $count backups, size: $size"
            fi
        done
        
        echo ""
    echo "=== Recommendations ==="
        if [[ $TESTS_FAILED -gt 0 ]]; then
            echo "- Address critical failures immediately"
            echo "- Investigate any corrupted backups"
            echo "- Ensure sufficient free disk space"
        fi
        
        if [[ $TESTS_WARNING -gt 0 ]]; then
            echo "- Review warnings"
            echo "- Consider refining automated backup schedule"
            echo "- Verify backup freshness"
        fi
        
        if [[ $TESTS_FAILED -eq 0 && $TESTS_WARNING -eq 0 ]]; then
            echo "- Backup system operating correctly"
            echo "- Continue periodic integrity checks"
        fi
        
    } > "$report_file"
    
    log_info "Detailed report saved: $(basename "$report_file")"
}

# Main function
main() {
    echo "=== Books App Backup Integrity Check ==="
    echo "Check date: $(date)"
    echo "Backup directory: $BACKUP_DIR"
    echo

    # Execute all checks
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
    echo "=== Final Results ==="
    echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
    echo -e "${YELLOW}Warnings: $TESTS_WARNING${NC}" 
    echo -e "${RED}Failures: $TESTS_FAILED${NC}"
    
    # Generate report file
    generate_report
    
    echo
    if [[ $TESTS_FAILED -eq 0 ]]; then
        if [[ $TESTS_WARNING -eq 0 ]]; then
            echo -e "${GREEN}✓ All checks passed successfully${NC}"
            exit 0
        else
            echo -e "${YELLOW}! Checks passed with warnings${NC}"
            exit 0
        fi
    else
    echo -e "${RED}✗ Critical backup issues detected${NC}"
        exit 1
    fi
}

# Arguments & help
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: $0"
    echo
    echo "This script validates backup system health:"
    echo "- Directory presence & structure"
    echo "- Backup files and sizes"
    echo "- Backup freshness"
    echo "- Compressed archive integrity"
    echo "- SQL dump structure"
    echo "- Media uploads backups"
    echo "- Backup logs"
    echo "- Disk free space"
    echo "- Automated backup schedule"
    echo
    echo "Environment variables:"
    echo "  MIN_BACKUP_SIZE_MB     - minimum acceptable backup size in MB (default 1)"
    echo "  MAX_BACKUP_AGE_DAYS    - maximum backup age in days (default 7)"
    echo
    echo "Exit codes:"
    echo "  0 - All checks passed"
    echo "  1 - Critical issues detected"
    exit 0
fi

# Run main function
main "$@"
