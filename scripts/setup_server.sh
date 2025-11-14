#!/bin/bash

# Production Server Setup Script
# ===============================
# Automated VPS setup for deploying the Books App Backend
# 
# Usage:
#   ./scripts/setup_server.sh [OPTIONS]
#
# Options:
#   --domain DOMAIN    Primary API domain (e.g. api.example.com)
#   --user USER        Deployment user (default: deploy)
#   --skip-security    Skip security hardening
#   --skip-monitoring  Skip monitoring setup
#   --skip-caddy       Skip Caddy installation
#   --dry-run          Show commands without executing
#   -h, --help         Show help

set -euo pipefail

# Color scheme for logs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

# Default variables
DOMAIN=""
DEPLOY_USER="deploy"
SKIP_SECURITY=false
SKIP_MONITORING=false
SKIP_CADDY=false
DRY_RUN=false

# Logging helpers
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_info() {
    echo -e "${CYAN}ℹ️  $1${NC}"
}

# Show help
show_help() {
    cat << EOF
Production Server Setup Script
===============================

Automated VPS setup for the Books App Backend.

USAGE:
    ./scripts/setup_server.sh --domain api.example.com [OPTIONS]

REQUIRED:
    --domain DOMAIN    Primary API domain (e.g. api.example.com)

OPTIONAL:
    --user USER        Deployment user (default: deploy)
    --skip-security    Skip security hardening
    --skip-monitoring  Skip monitoring setup  
    --skip-caddy       Skip Caddy installation
    --dry-run          Show commands without executing
    -h, --help         Show this help

EXAMPLES:
    # Full server setup
    ./scripts/setup_server.sh --domain api.mybooks.com
    
    # Setup without monitoring
    ./scripts/setup_server.sh --domain api.mybooks.com --skip-monitoring
    
    # Dry run to preview commands
    ./scripts/setup_server.sh --domain api.mybooks.com --dry-run

REQUIREMENTS:
    - Ubuntu 22.04+ or Debian 12+
    - Root access or passwordless sudo
    - Internet connectivity
    - Open ports: 22, 80, 443

EOF
}

# Argument parsing
while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)
            DOMAIN="$2"
            shift 2
            ;;
        --user)
            DEPLOY_USER="$2"
            shift 2
            ;;
        --skip-security)
            SKIP_SECURITY=true
            shift
            ;;
        --skip-monitoring)
            SKIP_MONITORING=true
            shift
            ;;
        --skip-caddy)
            SKIP_CADDY=true
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
            echo "Use --help for usage"
            exit 1
            ;;
    esac
done

# Required parameter validation
if [[ -z "$DOMAIN" ]]; then
    log_error "Domain not specified. Use --domain api.example.com"
    echo "Use --help for usage"
    exit 1
fi

# Command execution helper (supports dry-run)
execute() {
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "${GRAY}[DRY-RUN] $1${NC}"
    else
    log "Running: $1"
        eval "$1"
    fi
}

# Root privilege check
check_root() {
    if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
    log_error "Root privileges or passwordless sudo required"
        exit 1
    fi
}

# Operating system check
check_os() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case $ID in
            ubuntu)
                if [[ $(echo "$VERSION_ID >= 22.04" | bc -l) -eq 0 ]]; then
                    log_warning "Recommended Ubuntu 22.04+, current: $VERSION_ID"
                fi
                ;;
            debian)
                if [[ $(echo "$VERSION_ID >= 12" | bc -l) -eq 0 ]]; then
                    log_warning "Recommended Debian 12+, current: $VERSION_ID"
                fi
                ;;
            *)
                log_warning "Unsupported OS: $PRETTY_NAME"
                ;;
        esac
    else
    log_warning "Unable to determine operating system"
    fi
}

# System update
update_system() {
    log "Updating system..."
    execute "apt-get update -y"
    execute "apt-get upgrade -y"
    execute "apt-get autoremove -y"
    execute "apt-get autoclean"
    log_success "System updated"
}

# Install base packages
install_base_packages() {
    log "Installing base packages..."
    
    local packages=(
        "curl"
        "wget" 
        "git"
        "unzip"
        "htop"
        "tree"
        "jq"
        "bc"
        "cron"
        "logrotate"
        "ca-certificates"
        "gnupg"
        "lsb-release"
    )
    
    execute "apt-get install -y ${packages[*]}"
    log_success "Base packages installed"
}

# Install Docker
install_docker() {
    log "Installing Docker..."
    
    if command -v docker &> /dev/null; then
    log_info "Docker already installed: $(docker --version)"
        return 0
    fi
    
    # Install Docker from official repository
    execute "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg"
    execute "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \$(lsb_release -cs) stable\" | tee /etc/apt/sources.list.d/docker.list > /dev/null"
    execute "apt-get update -y"
    execute "apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin"
    
    # Enable and start Docker service
    execute "systemctl enable docker"
    execute "systemctl start docker"
    
    log_success "Docker installed: $(docker --version)"
}

# Create deployment user
create_deploy_user() {
    log "Creating user $DEPLOY_USER..."
    
    if id "$DEPLOY_USER" &>/dev/null; then
    log_info "User $DEPLOY_USER already exists"
    else
        execute "useradd -m -s /bin/bash $DEPLOY_USER"
    log_success "User $DEPLOY_USER created"
    fi
    
    # Add user to docker and sudo groups
    execute "usermod -aG docker $DEPLOY_USER"
    execute "usermod -aG sudo $DEPLOY_USER"
    
    # Create application directory structure
    execute "mkdir -p /opt/books/{app,uploads,backups,logs}"
    execute "chown -R $DEPLOY_USER:$DEPLOY_USER /opt/books"
    execute "chmod 755 /opt/books"
    execute "chmod 700 /opt/books/backups"
    
    log_success "User $DEPLOY_USER configured"
}

# SSH key setup (interactive)
setup_ssh_keys() {
    log "Configuring SSH keys for user $DEPLOY_USER..."
    
    local user_home="/home/$DEPLOY_USER"
    execute "mkdir -p $user_home/.ssh"
    execute "chmod 700 $user_home/.ssh"
    
    if [[ "$DRY_RUN" == false ]]; then
        echo -e "${YELLOW}"
        echo "=========================================="
    echo "SSH KEY SETUP"
        echo "=========================================="
    echo "Add your public SSH key for user $DEPLOY_USER:"
    echo "1. Copy contents of your ~/.ssh/id_rsa.pub"
    echo "2. Paste it below and press Enter"
    echo "3. Submit an empty line to finish"
        echo -e "${NC}"
        
        > "$user_home/.ssh/authorized_keys"
        while IFS= read -r line; do
            [[ -z "$line" ]] && break
            echo "$line" >> "$user_home/.ssh/authorized_keys"
        done
        
        execute "chmod 600 $user_home/.ssh/authorized_keys"
        execute "chown -R $DEPLOY_USER:$DEPLOY_USER $user_home/.ssh"
        
    log_success "SSH keys configured for user $DEPLOY_USER"
    else
    log_info "[DRY-RUN] SSH key input would be requested"
    fi
}

# Production environment setup
setup_production_environment() {
    log "Configuring production environment..."
    
    # Environment variables for Docker Compose
    cat > /opt/books/.env << EOF
# Production Environment Settings
DOMAIN=$DOMAIN
DEPLOY_USER=$DEPLOY_USER
COMPOSE_PROJECT_NAME=books-prod
COMPOSE_FILE=docker-compose.prod.yml
EOF
    
    execute "chown $DEPLOY_USER:$DEPLOY_USER /opt/books/.env"
    execute "chmod 600 /opt/books/.env"
    
    log_success "Production environment configured"
}

# System limits setup
setup_system_limits() {
    log "Configuring system limits..."
    
    # Limits for deploy user
    cat > /etc/security/limits.d/books-app.conf << EOF
# Books App Production Limits
$DEPLOY_USER soft nofile 65536
$DEPLOY_USER hard nofile 65536
$DEPLOY_USER soft nproc 32768
$DEPLOY_USER hard nproc 32768

# Docker containers
* soft nofile 65536
* hard nofile 65536
EOF
    
    # System tuning for performance
    cat > /etc/sysctl.d/99-books-app.conf << EOF
# Books App Production System Settings

# Network
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 5000
net.core.rmem_default = 262144
net.core.rmem_max = 16777216
net.core.wmem_default = 262144
net.core.wmem_max = 16777216
net.ipv4.tcp_keepalive_time = 120
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3

# File system
fs.file-max = 1000000

# Virtual memory
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
EOF
    
    execute "sysctl -p /etc/sysctl.d/99-books-app.conf"
    
    log_success "System limits configured"
}

# Logging setup
setup_logging() {
    log "Configuring logging..."
    
    # Log rotation configuration for app
    cat > /etc/logrotate.d/books-app << EOF
/opt/books/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 $DEPLOY_USER $DEPLOY_USER
    su $DEPLOY_USER $DEPLOY_USER
    postrotate
    # Restart containers to reopen log files
        /usr/bin/docker compose -f /opt/books/app/docker-compose.prod.yml restart app 2>/dev/null || true
    endscript
}

/opt/books/backups/*.log {
    weekly
    missingok
    rotate 12
    compress
    delaycompress
    notifempty
    create 644 $DEPLOY_USER $DEPLOY_USER
    su $DEPLOY_USER $DEPLOY_USER
}
EOF
    
    # Configure journald to control log size
    mkdir -p /etc/systemd/journald.conf.d
    cat > /etc/systemd/journald.conf.d/books-app.conf << EOF
[Journal]
SystemMaxUse=1G
SystemMaxFileSize=100M
RuntimeMaxUse=1G
RuntimeMaxFileSize=100M
EOF
    
    execute "systemctl restart systemd-journald"
    
    log_success "Logging configured"
}

# Check status of all services
check_services_status() {
    log "Checking service status..."
    
    services=("docker" "cron" "ssh")
    
    for service in "${services[@]}"; do
        if systemctl is-active --quiet "$service"; then
            log_success "$service: active"
        else
            log_error "$service: inactive"
        fi
    done
    
    # Docker status check
    if [[ "$DRY_RUN" == false ]] && command -v docker &> /dev/null; then
        if docker ps &> /dev/null; then
            log_success "Docker: ready"
        else
            log_error "Docker: connection error"
        fi
    fi
}

# Create info file (markdown summary)
create_info_file() {
    log "Creating info file..."
    
    cat > /opt/books/SERVER_INFO.md << EOF
# Books App Production Server
============================

**Setup Date:** $(date)
**Domain:** $DOMAIN
**Deployment User:** $DEPLOY_USER
**OS Version:** $(lsb_release -d | cut -f2)
**Docker Version:** $(docker --version 2>/dev/null || echo "Not installed")

## Directory Structure

\`\`\`
/opt/books/
├── app/                    # Application code & configuration
│   ├── .env.prod          # Environment variables (chmod 600)
│   └── docker-compose.prod.yml
├── uploads/               # User media uploads
├── backups/              # Database backups (chmod 700)
└── logs/                 # Application logs
\`\`\`

## Next Steps

1. **Copy application code:**
   \`\`\`bash
   su $DEPLOY_USER
   cd /opt/books/app
   git clone <repository-url> .
   \`\`\`

2. **Configure environment variables:**
   \`\`\`bash
   cp .env.example .env.prod
    vim .env.prod  # Update for production
   chmod 600 .env.prod
   \`\`\`

3. **Start application:**
   \`\`\`bash
   docker compose -f docker-compose.prod.yml up -d
   \`\`\`

## Useful Commands

\`\`\`bash
# Container status
docker compose -f docker-compose.prod.yml ps

# Application logs
docker compose -f docker-compose.prod.yml logs -f app

# Enter container
docker compose -f docker-compose.prod.yml exec app sh

# Database backup
./scripts/backup_database.sh daily

# Security test
./scripts/test_security.sh
\`\`\`

## Monitoring

- **System logs:** `journalctl -u docker -f`
- **Processes:** `htop`
- **Disk:** `df -h`
- **Network:** `netstat -tuln`

EOF
    
    execute "chown $DEPLOY_USER:$DEPLOY_USER /opt/books/SERVER_INFO.md"
    
    log_success "Info file created: /opt/books/SERVER_INFO.md"
}

# Main function
main() {
    echo -e "${PURPLE}"
    echo "========================================"
    echo "🚀 Books App Production Server Setup"
    echo "========================================"
    echo -e "${NC}"
    echo "Domain: $DOMAIN"
    echo "User: $DEPLOY_USER"
    echo "Mode: $([ "$DRY_RUN" == true ] && echo "DRY RUN" || echo "EXECUTION")"
    echo ""
    
    if [[ "$DRY_RUN" == false ]]; then
    read -p "Proceed with setup? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Setup cancelled by user"
            exit 0
        fi
    fi
    
    # Checks
    check_root
    check_os
    
    # Core setup steps
    update_system
    install_base_packages
    install_docker
    create_deploy_user
    setup_ssh_keys
    setup_production_environment
    setup_system_limits
    setup_logging
    
    # Optional components
    if [[ "$SKIP_SECURITY" == false ]]; then
    log "Running security setup..."
        if [[ -f "./scripts/setup_security.sh" ]]; then
            execute "./scripts/setup_security.sh --production"
        else
            log_warning "setup_security.sh script not found, skipping"
        fi
    fi
    
    if [[ "$SKIP_CADDY" == false ]]; then
    log "Installing Caddy reverse proxy..."
        if [[ -f "./scripts/install_caddy.sh" ]]; then
            execute "./scripts/install_caddy.sh --domain $DOMAIN"
        else
            log_warning "install_caddy.sh script not found, skipping"
        fi
    fi
    
    if [[ "$SKIP_MONITORING" == false ]]; then
    log "Setting up monitoring..."
        if [[ -f "./scripts/setup_monitoring.sh" ]]; then
            execute "./scripts/setup_monitoring.sh --production"
        else
            log_warning "setup_monitoring.sh script not found, skipping"
        fi
    fi
    
    # Final checks
    check_services_status
    create_info_file
    
    echo ""
    echo -e "${GREEN}"
    echo "========================================"
    echo "✅ Server configured successfully!"
    echo "========================================"
    echo -e "${NC}"
    echo "Domain: $DOMAIN"
    echo "User: $DEPLOY_USER"
    echo "Directory: /opt/books"
    echo ""
    echo "Next steps:"
    echo "1. Switch to user: su $DEPLOY_USER"
    echo "2. Go to directory: cd /opt/books/app"
    echo "3. Clone the application repository"
    echo "4. Configure .env.prod file"
    echo "5. Start: docker compose -f docker-compose.prod.yml up -d"
    echo ""
    echo "Documentation: /opt/books/SERVER_INFO.md"
}

# Error handling
trap 'log_error "Error at line $LINENO. Exit code: $?"' ERR

# Run
main "$@"
