#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging helpers
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

# Root privileges check
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root"
        log_info "Run: sudo $0"
        exit 1
    fi
}

# System update
update_system() {
    log_info "Updating system..."
    apt update -y
    apt upgrade -y
    apt autoremove -y
    log_success "System updated"
}

# SSH hardening
setup_ssh() {
    log_info "Configuring SSH security..."
    
    # Backup original config
    cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup.$(date +%Y%m%d_%H%M%S)
    
    # SSH settings
    sed -i 's/#PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
    sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config
    sed -i 's/#AuthorizedKeysFile/AuthorizedKeysFile/' /etc/ssh/sshd_config
    
    # Additional hardening
    grep -q "Protocol 2" /etc/ssh/sshd_config || echo "Protocol 2" >> /etc/ssh/sshd_config
    grep -q "X11Forwarding no" /etc/ssh/sshd_config || echo "X11Forwarding no" >> /etc/ssh/sshd_config
    grep -q "MaxAuthTries 3" /etc/ssh/sshd_config || echo "MaxAuthTries 3" >> /etc/ssh/sshd_config
    grep -q "ClientAliveInterval 300" /etc/ssh/sshd_config || echo "ClientAliveInterval 300" >> /etc/ssh/sshd_config
    grep -q "ClientAliveCountMax 2" /etc/ssh/sshd_config || echo "ClientAliveCountMax 2" >> /etc/ssh/sshd_config
    
    # Reload SSH
    systemctl reload sshd
    log_success "SSH configured (passwords disabled, keys only)"
}

# UFW setup (Uncomplicated Firewall)
setup_ufw() {
    log_info "Configuring UFW firewall..."
    
    # Install UFW if not present
    if ! command -v ufw &> /dev/null; then
        apt install -y ufw
    fi
    
    # Reset rules
    ufw --force reset
    
    # Default policies
    ufw default deny incoming
    ufw default allow outgoing
    
    # Allowed ports
    ufw allow 22/tcp    # SSH
    ufw allow 80/tcp    # HTTP
    ufw allow 443/tcp   # HTTPS
    
    # Enable UFW
    ufw --force enable
    
    log_success "UFW configured (allowed ports: 22, 80, 443)"
}

# Install and configure fail2ban
setup_fail2ban() {
    log_info "Installing and configuring fail2ban..."
    
    # Install fail2ban
    apt install -y fail2ban
    
    # Create local config
    cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
# Ban for 1 hour after 5 failed attempts within 10 minutes
bantime = 3600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
logpath = /var/log/nginx/error.log

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
logpath = /var/log/nginx/error.log
maxretry = 10

[nginx-botsearch]
enabled = true
filter = nginx-botsearch
logpath = /var/log/nginx/access.log
EOF
    
    # Enable and restart fail2ban
    systemctl enable fail2ban
    systemctl restart fail2ban
    
    log_success "fail2ban installed and configured"
}

# Configure unattended security upgrades
setup_unattended_upgrades() {
    log_info "Configuring unattended security upgrades..."
    
    # Install packages
    apt install -y unattended-upgrades apt-listchanges
    
    # Create configuration
    cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

Unattended-Upgrade::Package-Blacklist {
};

Unattended-Upgrade::DevRelease "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "02:00";
EOF
    
    # Enable auto updates
    echo 'APT::Periodic::Update-Package-Lists "1";' > /etc/apt/apt.conf.d/20auto-upgrades
    echo 'APT::Periodic::Unattended-Upgrade "1";' >> /etc/apt/apt.conf.d/20auto-upgrades
    echo 'APT::Periodic::AutocleanInterval "7";' >> /etc/apt/apt.conf.d/20auto-upgrades
    
    # Enable and restart service
    systemctl enable unattended-upgrades
    systemctl restart unattended-upgrades
    
    log_success "Unattended security upgrades configured"
}

# Create deploy user
create_deploy_user() {
    log_info "Creating user 'deploy'..."
    
    if id "deploy" &>/dev/null; then
        log_warning "User 'deploy' already exists"
    else
        # Create user
        useradd -m -s /bin/bash deploy
        usermod -aG sudo deploy
        
        # Create SSH keys directory
        mkdir -p /home/deploy/.ssh
        chmod 700 /home/deploy/.ssh
        touch /home/deploy/.ssh/authorized_keys
        chmod 600 /home/deploy/.ssh/authorized_keys
        chown -R deploy:deploy /home/deploy/.ssh
        
        log_success "User 'deploy' created"
        log_warning "Don't forget to add your SSH public key to /home/deploy/.ssh/authorized_keys"
    fi
}

# Create project directories
setup_project_directories() {
    log_info "Creating project directories..."
    
    # Create base directories
    mkdir -p /opt/books/{app,uploads,backups,logs}
    
    # Ownership and permissions
    chown -R deploy:deploy /opt/books
    chmod 755 /opt/books
    chmod 775 /opt/books/{uploads,backups,logs}
    
    log_success "Project directories created at /opt/books"
}

# Install base security/ops packages
install_security_packages() {
    log_info "Installing base security/ops packages..."
    
    apt install -y \
        curl \
        wget \
        git \
        htop \
        iotop \
        net-tools \
        lsof \
        tcpdump \
        nmap \
        logrotate \
        rsync \
        cron \
        acl
    
    log_success "Base packages installed"
}

# Configure system limits
setup_system_limits() {
    log_info "Configuring system limits..."
    
    # limits.conf for user 'deploy'
    cat >> /etc/security/limits.conf << 'EOF'
# Limits for user deploy
deploy soft nofile 65536
deploy hard nofile 65536
deploy soft nproc 32768
deploy hard nproc 32768
EOF
    
    # sysctl settings
    cat >> /etc/sysctl.conf << 'EOF'
# Network security settings
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1

# Protection against SYN flood attacks
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_syn_retries = 5

# Memory tuning for production
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
EOF
    
    # Apply sysctl
    sysctl -p
    
    log_success "System limits configured"
}

# Main
main() {
    log_info "=== Production server security hardening ==="
    log_info "Starting security components setup..."
    
    check_root
    
    # Execute all steps
    update_system
    install_security_packages
    create_deploy_user
    setup_ssh
    setup_ufw
    setup_fail2ban
    setup_unattended_upgrades
    setup_project_directories
    setup_system_limits
    
    log_success "=== Security hardening completed! ==="
    echo
    log_info "Next steps:"
    echo "1. Add your SSH public key to /home/deploy/.ssh/authorized_keys"
    echo "2. Re-login and verify access as user 'deploy'"
    echo "3. Run ./test_security.sh to validate the configuration"
    echo "4. Set up Docker and deploy the application"
    echo
    log_warning "WARNING: Make sure you have SSH key-based access before disconnecting from the server!"
}

# Arguments
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: $0"
    echo
    echo "This script sets up baseline security for a production server:"
    echo "- Disable SSH passwords (keys only)"
    echo "- Configure UFW firewall (ports 22, 80, 443)"
    echo "- Install and configure fail2ban"
    echo "- Enable unattended security updates"
    echo "- Create 'deploy' user"
    echo "- Apply system-level security settings"
    echo
    echo "Run: sudo $0"
    exit 0
fi

# Run main function
main "$@"
