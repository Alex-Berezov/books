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
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Default configuration
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_SCRIPT="$SCRIPT_DIR/backup_database.sh"
TEST_SCRIPT="$SCRIPT_DIR/test_backup.sh"

# Default schedule settings
DAILY_TIME="${DAILY_TIME:-02:00}"      # Daily backups at 02:00
WEEKLY_DAY="${WEEKLY_DAY:-0}"          # Sunday (0-6, where 0=Sunday)
WEEKLY_TIME="${WEEKLY_TIME:-03:00}"    # Weekly backups at 03:00
MONTHLY_DAY="${MONTHLY_DAY:-1}"        # 1st day of month
MONTHLY_TIME="${MONTHLY_TIME:-04:00}"  # Monthly backups at 04:00
TEST_TIME="${TEST_TIME:-06:00}"        # Integrity test at 06:00

# Email for notifications
NOTIFICATION_EMAIL="${NOTIFICATION_EMAIL:-}"

# User performing backups
BACKUP_USER="${BACKUP_USER:-deploy}"

# Function to verify backup user exists
check_backup_user() {
    if ! id "$BACKUP_USER" &>/dev/null; then
    log_error "User $BACKUP_USER does not exist"
    log_info "Create the user or change BACKUP_USER"
        exit 1
    fi
    
    log_info "Backups will run as user: $BACKUP_USER"
}

# Function to verify backup scripts
check_backup_scripts() {
    log_info "Checking backup scripts..."
    
    if [[ ! -f "$BACKUP_SCRIPT" ]]; then
    log_error "Backup script not found: $BACKUP_SCRIPT"
        exit 1
    fi
    
    if [[ ! -x "$BACKUP_SCRIPT" ]]; then
    log_warning "Backup script not executable, fixing permissions..."
        chmod +x "$BACKUP_SCRIPT"
    fi
    
    log_success "Backup script found: $BACKUP_SCRIPT"
    
    if [[ -f "$TEST_SCRIPT" ]]; then
        if [[ ! -x "$TEST_SCRIPT" ]]; then
            chmod +x "$TEST_SCRIPT"
        fi
    log_success "Integrity test script found: $TEST_SCRIPT"
    else
    log_warning "Integrity test script not found: $TEST_SCRIPT"
    fi
}

# Function to check cron service
check_cron_service() {
    log_info "Checking cron service..."
    
    if systemctl is-active cron >/dev/null 2>&1; then
    log_success "cron service active"
    elif systemctl is-active crond >/dev/null 2>&1; then
    log_success "crond service active"
    else
    log_error "cron service inactive"
    log_info "Attempting to start cron service..."
        
        if command -v systemctl &>/dev/null; then
            systemctl enable cron 2>/dev/null || systemctl enable crond 2>/dev/null || true
            systemctl start cron 2>/dev/null || systemctl start crond 2>/dev/null || true
        fi
        
        sleep 2
        
        if systemctl is-active cron >/dev/null 2>&1 || systemctl is-active crond >/dev/null 2>&1; then
            log_success "cron service started successfully"
        else
            log_error "Failed to start cron service"
            exit 1
        fi
    fi
}

# Function to create user crontab entries
setup_user_cron() {
    log_info "Configuring cron jobs for user $BACKUP_USER..."
    
    # Fetch current crontab
    local current_cron=""
    if sudo -u "$BACKUP_USER" crontab -l 2>/dev/null; then
        current_cron=$(sudo -u "$BACKUP_USER" crontab -l 2>/dev/null)
    fi
    
    # Create temporary file with new jobs
    local temp_cron="/tmp/books_backup_cron_$$"
    
    {
    # Preserve existing jobs (excluding our managed entries)
        if [[ -n "$current_cron" ]]; then
            echo "$current_cron" | grep -v "backup_database.sh\|test_backup.sh\|# Books App Backup"
        fi
        
        echo ""
        echo "# Books App Backup Jobs - Created by setup_backup_cron.sh"
        echo "# Do not edit manually - use setup_backup_cron.sh to modify"
        echo ""
        
    # Daily backups
        local daily_hour=$(echo "$DAILY_TIME" | cut -d: -f1)
        local daily_minute=$(echo "$DAILY_TIME" | cut -d: -f2)
        echo "$daily_minute $daily_hour * * * $BACKUP_SCRIPT daily >/dev/null 2>&1"
        
    # Weekly backups
        local weekly_hour=$(echo "$WEEKLY_TIME" | cut -d: -f1)
        local weekly_minute=$(echo "$WEEKLY_TIME" | cut -d: -f2)
        echo "$weekly_minute $weekly_hour * * $WEEKLY_DAY $BACKUP_SCRIPT weekly >/dev/null 2>&1"
        
    # Monthly backups
        local monthly_hour=$(echo "$MONTHLY_TIME" | cut -d: -f1)
        local monthly_minute=$(echo "$MONTHLY_TIME" | cut -d: -f2)
        echo "$monthly_minute $monthly_hour $MONTHLY_DAY * * $BACKUP_SCRIPT monthly >/dev/null 2>&1"
        
    # Weekly integrity check (if script exists)
        if [[ -f "$TEST_SCRIPT" ]]; then
            local test_hour=$(echo "$TEST_TIME" | cut -d: -f1)
            local test_minute=$(echo "$TEST_TIME" | cut -d: -f2)
            echo "$test_minute $test_hour * * 1 $TEST_SCRIPT >/dev/null 2>&1  # Weekly integrity check"
        fi
        
        echo ""
        
    } > "$temp_cron"
    
    # Apply new crontab
    if sudo -u "$BACKUP_USER" crontab "$temp_cron"; then
    log_success "Cron jobs configured successfully for user $BACKUP_USER"
    else
    log_error "Failed to configure cron jobs"
        rm -f "$temp_cron"
        exit 1
    fi
    
    rm -f "$temp_cron"
}

# Function to create system-level cron file (alternative method)
setup_system_cron() {
    log_info "Configuring system cron file..."
    
    local system_cron="/etc/cron.d/books_backup"
    
    cat > "$system_cron" << EOF
# Books App Backup Schedule
# Created by setup_backup_cron.sh on $(date)

SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=${NOTIFICATION_EMAIL:-root}

# Daily backup at ${DAILY_TIME}
$(echo "$DAILY_TIME" | awk -F: '{print $2 " " $1}') * * * $BACKUP_USER $BACKUP_SCRIPT daily

# Weekly backup on $(case $WEEKLY_DAY in 0) echo "Sunday";; 1) echo "Monday";; 2) echo "Tuesday";; 3) echo "Wednesday";; 4) echo "Thursday";; 5) echo "Friday";; 6) echo "Saturday";; esac) at ${WEEKLY_TIME}
$(echo "$WEEKLY_TIME" | awk -F: '{print $2 " " $1}') * * $WEEKLY_DAY $BACKUP_USER $BACKUP_SCRIPT weekly

# Monthly backup on day ${MONTHLY_DAY} at ${MONTHLY_TIME}
$(echo "$MONTHLY_TIME" | awk -F: '{print $2 " " $1}') $MONTHLY_DAY * * $BACKUP_USER $BACKUP_SCRIPT monthly

EOF

    # Add integrity check if script exists
    if [[ -f "$TEST_SCRIPT" ]]; then
        cat >> "$system_cron" << EOF
# Weekly integrity check on Monday at ${TEST_TIME}
$(echo "$TEST_TIME" | awk -F: '{print $2 " " $1}') * * 1 $BACKUP_USER $TEST_SCRIPT

EOF
    fi
    
    # Set correct permissions
    chmod 644 "$system_cron"
    chown root:root "$system_cron"
    
    log_success "System cron file created: $system_cron"
}

# Function to create manual test wrapper script
create_test_wrapper() {
    local test_wrapper="/opt/books/app/run_backup_test.sh"
    
    cat > "$test_wrapper" << 'EOF'
#!/bin/bash
# Manual backup test script
# Created by setup_backup_cron.sh

set -e

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Manual Backup Test ==="
echo "Date: $(date)"
echo

# Test backup script
if [[ -f "$PROJECT_DIR/scripts/backup_database.sh" ]]; then
    echo "Running backup test..."
    "$PROJECT_DIR/scripts/backup_database.sh" daily
    echo
fi

# Test integrity
if [[ -f "$PROJECT_DIR/scripts/test_backup.sh" ]]; then
    echo "Running integrity check..."
    "$PROJECT_DIR/scripts/test_backup.sh"
fi

echo "=== Test Complete ==="
EOF
    
    chmod +x "$test_wrapper"
    chown "$BACKUP_USER:$BACKUP_USER" "$test_wrapper" 2>/dev/null || true
    
    log_success "Manual backup test script created: $test_wrapper"
}

# Function to configure backup environment variables
setup_environment() {
    log_info "Configuring environment variables for backups..."
    
    local env_file="/opt/books/app/.env.backup"
    
    cat > "$env_file" << EOF
# Backup Environment Variables
# Created by setup_backup_cron.sh on $(date)

# Backup Configuration
BACKUP_DIR="/opt/books/backups"
BACKUP_RETENTION_DAYS=14
COMPRESS_BACKUPS=true
INCLUDE_UPLOADS=true
MIN_BACKUP_SIZE_MB=1

# PostgreSQL Configuration (adjust as needed)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=books
POSTGRES_USER=postgres
# POSTGRES_PASSWORD=your_password_here

# Docker Configuration
USE_DOCKER=auto

# Logging
LOG_LEVEL=INFO
EOF
    
    chmod 600 "$env_file"
    chown "$BACKUP_USER:$BACKUP_USER" "$env_file" 2>/dev/null || true
    
    log_success "Environment variable file created: $env_file"
    log_warning "Don't forget to set POSTGRES_PASSWORD in $env_file"
}

# Function to configure backup logging
setup_logging() {
    log_info "Configuring backup logging (logrotate)..."
    
    local logrotate_config="/etc/logrotate.d/books_backup"
    
    cat > "$logrotate_config" << EOF
/opt/books/backups/backup.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 $BACKUP_USER $BACKUP_USER
    postrotate
        # Signal processes if needed
    endscript
}

/opt/books/backups/*.txt {
    weekly
    missingok
    rotate 4
    compress
    delaycompress
    notifempty
    create 644 $BACKUP_USER $BACKUP_USER
}
EOF
    
    log_success "logrotate configuration created: $logrotate_config"
}

# Function to verify backup setup
verify_setup() {
    log_info "Verifying backup configuration..."
    
    # Check user cron jobs
    if sudo -u "$BACKUP_USER" crontab -l 2>/dev/null | grep -q "backup_database.sh"; then
    log_success "Cron jobs detected"
        
    echo "Backup schedule:"
        sudo -u "$BACKUP_USER" crontab -l 2>/dev/null | grep -E "backup_database.sh|test_backup.sh" | while read -r line; do
            log_info "  $line"
        done
    else
    log_warning "No backup cron jobs found in user crontab"
    fi
    
    # Check system cron file
    if [[ -f "/etc/cron.d/books_backup" ]]; then
    log_success "System cron file present"
    fi
    
    # Check directory permissions
    if [[ -d "/opt/books/backups" ]]; then
        local backup_owner=$(stat -c %U "/opt/books/backups")
        if [[ "$backup_owner" == "$BACKUP_USER" ]]; then
            log_success "Backup directory ownership correct"
        else
            log_warning "Backup directory owner: $backup_owner (expected: $BACKUP_USER)"
        fi
    else
    log_warning "Backup directory does not exist (will be created on first run)"
    fi
}

# Function to show backup system status
show_status() {
    echo
    echo "=== Backup System Status ==="
    
    echo "Schedule:"
    echo "  Daily backups: every day at $DAILY_TIME"
    echo "  Weekly backups: every $(case $WEEKLY_DAY in 0) echo Sunday;; 1) echo Monday;; 2) echo Tuesday;; 3) echo Wednesday;; 4) echo Thursday;; 5) echo Friday;; 6) echo Saturday;; esac) at $WEEKLY_TIME"
    echo "  Monthly backups: on day ${MONTHLY_DAY} at $MONTHLY_TIME"
    if [[ -f "$TEST_SCRIPT" ]]; then
    echo "  Integrity check: every Monday at $TEST_TIME"
    fi
    
    echo
    echo "Configuration files:"
    echo "  Backup script: $BACKUP_SCRIPT"
    if [[ -f "$TEST_SCRIPT" ]]; then
    echo "  Integrity script: $TEST_SCRIPT"
    fi
    echo "  Environment file: /opt/books/app/.env.backup"
    
    echo
    echo "Management commands:"
    echo "  Manual backup: sudo -u $BACKUP_USER $BACKUP_SCRIPT"
    echo "  Integrity check: sudo -u $BACKUP_USER $TEST_SCRIPT"
    echo "  View cron jobs: sudo -u $BACKUP_USER crontab -l"
    echo "  Backup logs: tail -f /opt/books/backups/backup.log"
}

# Main function
main() {
    local setup_type="${1:-user}"
    
    log_info "=== Configuring automatic backups for Books App ==="
    
    # Root permission check for system setup
    if [[ "$setup_type" == "system" && $EUID -ne 0 ]]; then
    log_error "Root privileges required for system setup"
    log_info "Run: sudo $0 system"
        exit 1
    fi
    
    # Primary checks
    check_backup_user
    check_backup_scripts
    check_cron_service
    
    # Setup based on selected type
    if [[ "$setup_type" == "system" ]]; then
        setup_system_cron
        setup_logging
    else
        setup_user_cron
    fi
    
    # Additional setup
    setup_environment
    create_test_wrapper
    
    # Verify result
    verify_setup
    
    log_success "=== Automatic backup configuration complete ==="
    
    show_status
    
    echo
    log_info "Next steps:"
    echo "1. Review and edit /opt/books/app/.env.backup"
    echo "2. Run a test backup: sudo -u $BACKUP_USER $BACKUP_SCRIPT"
    echo "3. Run integrity check: sudo -u $BACKUP_USER $TEST_SCRIPT"
    
    if [[ -n "$NOTIFICATION_EMAIL" ]]; then
    echo "4. Configure email notifications for $NOTIFICATION_EMAIL"
    else
    echo "4. Consider enabling email notifications (NOTIFICATION_EMAIL)"
    fi
}

# Arguments & help
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: $0 [user|system]"
    echo
    echo "Installation types:"
    echo "  user   - user crontab setup (default)"
    echo "  system - system cron setup (requires root)"
    echo
    echo "Environment variables (schedule configuration):"
    echo "  DAILY_TIME         - daily backup time (default 02:00)"
    echo "  WEEKLY_DAY         - weekday for weekly backup (0=Sun .. 6=Sat)"
    echo "  WEEKLY_TIME        - weekly backup time (default 03:00)" 
    echo "  MONTHLY_DAY        - day of month for monthly backup (default 1)"
    echo "  MONTHLY_TIME       - monthly backup time (default 04:00)"
    echo "  TEST_TIME          - integrity check time (default 06:00)"
    echo "  BACKUP_USER        - user executing backups (default deploy)"
    echo "  NOTIFICATION_EMAIL - email for notifications (optional)"
    echo
    echo "Examples:"
    echo "  $0                                    # user setup"
    echo "  sudo $0 system                       # system setup"
    echo "  DAILY_TIME=01:30 $0                  # daily backups at 01:30"
    echo "  NOTIFICATION_EMAIL=admin@example.com sudo $0 system"
    exit 0
fi

# Run main function
main "${1:-user}"
