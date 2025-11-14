#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_WARNING=0

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((CHECKS_PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((CHECKS_FAILED++))
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    ((CHECKS_WARNING++))
}

# SSH configuration check
check_ssh_security() {
    log_info "Checking SSH settings..."
    
    # Root login disabled?
    if grep -q "^PermitRootLogin no" /etc/ssh/sshd_config; then
        log_pass "Root login disabled"
    else
        log_fail "Root login not disabled"
    fi
    
    # Password authentication disabled?
    if grep -q "^PasswordAuthentication no" /etc/ssh/sshd_config; then
        log_pass "Password authentication disabled"
    else
        log_fail "Password authentication enabled"
    fi
    
    # Public key authentication enabled?
    if grep -q "^PubkeyAuthentication yes" /etc/ssh/sshd_config; then
        log_pass "Public key authentication enabled"
    else
        log_fail "Public key authentication disabled"
    fi
    
    # Max authentication attempts limited?
    if grep -q "MaxAuthTries 3" /etc/ssh/sshd_config; then
        log_pass "Max authentication attempts limited"
    else
        log_warning "Max authentication attempts not limited"
    fi
}

# UFW check
check_ufw() {
    log_info "Checking UFW firewall..."
    
    if command -v ufw &> /dev/null; then
        if ufw status | grep -q "Status: active"; then
            log_pass "UFW active"
            
            # Check allowed ports
            if ufw status | grep -q "22/tcp"; then
                log_pass "SSH (port 22) allowed"
            else
                log_fail "SSH (port 22) not allowed"
            fi
            
            if ufw status | grep -q "80/tcp"; then
                log_pass "HTTP (port 80) allowed"
            else
                log_warning "HTTP (port 80) not allowed"
            fi
            
            if ufw status | grep -q "443/tcp"; then
                log_pass "HTTPS (port 443) allowed"
            else
                log_warning "HTTPS (port 443) not allowed"
            fi
        else
            log_fail "UFW not active"
        fi
    else
        log_fail "UFW not installed"
    fi
}

# fail2ban check
check_fail2ban() {
    log_info "Checking fail2ban..."
    
    if command -v fail2ban-client &> /dev/null; then
        if systemctl is-active fail2ban &> /dev/null; then
            log_pass "fail2ban active"
            
            # Check SSH jail configured
            if fail2ban-client status | grep -q "sshd"; then
                log_pass "SSH jail configured"
            else
                log_warning "SSH jail not found"
            fi
        else
            log_fail "fail2ban not running"
        fi
    else
        log_fail "fail2ban not installed"
    fi
}

# Automatic updates check
check_unattended_upgrades() {
    log_info "Checking automatic updates..."
    
    if command -v unattended-upgrades &> /dev/null; then
        log_pass "unattended-upgrades installed"
        
        if systemctl is-active unattended-upgrades &> /dev/null; then
            log_pass "unattended-upgrades active"
        else
            log_warning "unattended-upgrades not running"
        fi
        
        if [[ -f "/etc/apt/apt.conf.d/50unattended-upgrades" ]]; then
            log_pass "unattended-upgrades configuration found"
        else
            log_fail "unattended-upgrades configuration not found"
        fi
    else
        log_fail "unattended-upgrades not installed"
    fi
}

# Deploy user check
check_deploy_user() {
    log_info "Checking deploy user..."
    
    if id "deploy" &>/dev/null; then
        log_pass "User deploy exists"
        
    # Check home directory
        if [[ -d "/home/deploy" ]]; then
            log_pass "Home directory for deploy exists"
        else
            log_fail "Home directory for deploy not found"
        fi
        
    # Check SSH directory
        if [[ -d "/home/deploy/.ssh" ]]; then
            log_pass "SSH directory for deploy exists"
            
            # Check authorized_keys
            if [[ -f "/home/deploy/.ssh/authorized_keys" ]]; then
                if [[ -s "/home/deploy/.ssh/authorized_keys" ]]; then
                    log_pass "SSH keys for deploy configured"
                else
                    log_warning "authorized_keys file is empty - add SSH keys"
                fi
            else
                log_warning "authorized_keys file not found"
            fi
        else
            log_fail "SSH directory for deploy not found"
        fi
        
    # Check sudo privileges
        if groups deploy | grep -q sudo; then
            log_pass "User deploy has sudo privileges"
        else
            log_fail "User deploy lacks sudo privileges"
        fi
    else
        log_fail "User deploy does not exist"
    fi
}

# Project directories check
check_project_directories() {
    log_info "Checking project directories..."
    
    if [[ -d "/opt/books" ]]; then
        log_pass "Base directory /opt/books exists"
        
        for dir in app uploads backups logs; do
            if [[ -d "/opt/books/$dir" ]]; then
                log_pass "Directory /opt/books/$dir exists"
            else
                log_fail "Directory /opt/books/$dir not found"
            fi
        done
        
    # Check directory owner
        if [[ "$(stat -c %U /opt/books)" == "deploy" ]]; then
            log_pass "Owner of /opt/books is deploy"
        else
            log_warning "Owner of /opt/books is not deploy"
        fi
    else
        log_fail "Base directory /opt/books not found"
    fi
}

# System settings check
check_system_settings() {
    log_info "Checking system settings..."
    
    # Check sysctl settings
    if sysctl net.ipv4.tcp_syncookies | grep -q "= 1"; then
        log_pass "SYN cookies enabled"
    else
        log_warning "SYN cookies not enabled"
    fi
    
    if sysctl net.ipv4.conf.all.accept_redirects | grep -q "= 0"; then
        log_pass "ICMP redirects disabled"
    else
        log_warning "ICMP redirects enabled"
    fi
    
    # Check resource limits
    if grep -q "deploy.*nofile.*65536" /etc/security/limits.conf; then
        log_pass "File descriptor limits for deploy configured"
    else
        log_warning "File descriptor limits for deploy not configured"
    fi
}

# Network ports check
check_network_ports() {
    log_info "Checking open ports..."
    
    # Get list of open ports
    OPEN_PORTS=$(netstat -tuln | grep LISTEN | awk '{print $4}' | cut -d: -f2 | sort -nu)
    
    log_info "Open ports: $(echo $OPEN_PORTS | tr '\n' ' ')"
    
    # Check critical ports
    if echo "$OPEN_PORTS" | grep -q "^22$"; then
        log_pass "SSH port (22) open"
    else
        log_fail "SSH port (22) not open"
    fi
    
    # Warnings for potentially unsafe database ports
    for port in 3306 5432 6379 27017; do
        if echo "$OPEN_PORTS" | grep -q "^$port$"; then
            log_warning "Open database port detected ($port) - ensure it's secured"
        fi
    done
}

# System updates check
check_system_updates() {
    log_info "Checking update status..."
    
    # Refresh package lists
    apt update -qq 2>/dev/null || true
    
    # Check available updates
    UPDATES=$(apt list --upgradable 2>/dev/null | grep -c upgradable || echo "0")
    SECURITY_UPDATES=$(apt list --upgradable 2>/dev/null | grep -c security || echo "0")
    
    if [[ "$UPDATES" -eq 0 ]]; then
        log_pass "System up to date"
    else
        if [[ "$SECURITY_UPDATES" -gt 0 ]]; then
            log_fail "$SECURITY_UPDATES critical security updates available"
        else
            log_warning "$UPDATES updates available"
        fi
    fi
}

# Security logs check
check_security_logs() {
    log_info "Checking recent security events..."
    
    # Check recent failed SSH logins
    SSH_FAILURES=$(grep "Failed password" /var/log/auth.log 2>/dev/null | tail -5 | wc -l || echo "0")
    if [[ "$SSH_FAILURES" -gt 0 ]]; then
        log_warning "$SSH_FAILURES failed SSH login attempts found in recent entries"
    else
        log_pass "No failed SSH login attempts detected"
    fi
    
    # Check fail2ban bans
    if command -v fail2ban-client &> /dev/null; then
        BANNED_IPS=$(fail2ban-client status sshd 2>/dev/null | grep "Banned IP list" | wc -w || echo "0")
        if [[ "$BANNED_IPS" -gt 2 ]]; then # More than header words means IPs listed
            log_warning "fail2ban blocked multiple IP addresses"
        else
            log_pass "No blocked IP addresses"
        fi
    fi
}

# Main audit function
main() {
    echo "=== Production server security audit ==="
    echo "Audit date: $(date)"
    echo "Host: $(hostname)"
    echo "OS: $(lsb_release -d 2>/dev/null | cut -f2 || echo 'Unknown')"
    echo

    # Execute all checks
    check_ssh_security
    echo
    check_ufw
    echo
    check_fail2ban
    echo
    check_unattended_upgrades
    echo
    check_deploy_user
    echo
    check_project_directories
    echo
    check_system_settings
    echo
    check_network_ports
    echo
    check_system_updates
    echo
    check_security_logs
    
    echo
    echo "=== Audit results ==="
    echo -e "${GREEN}Passed: $CHECKS_PASSED${NC}"
    echo -e "${YELLOW}Warnings: $CHECKS_WARNING${NC}"
    echo -e "${RED}Failures: $CHECKS_FAILED${NC}"
    
    if [[ $CHECKS_FAILED -eq 0 ]]; then
        echo -e "\n${GREEN}✓ Overall: Security configuration is sound${NC}"
        if [[ $CHECKS_WARNING -gt 0 ]]; then
            echo -e "${YELLOW}! Recommended to address warnings${NC}"
        fi
        exit 0
    else
        echo -e "\n${RED}✗ Overall: Critical security issues detected${NC}"
        echo -e "${RED}Resolve errors before production deployment${NC}"
        exit 1
    fi
}

# Arguments check
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: $0"
    echo
    echo "This script audits production server security configuration:"
    echo "- SSH configuration"
    echo "- UFW firewall"
    echo "- fail2ban"
    echo "- Automatic updates"
    echo "- Deploy user"
    echo "- Project directories"
    echo "- System settings"
    echo "- Open ports"
    echo "- Update status"
    echo "- Security logs"
    echo
    echo "Exit codes:"
    echo "  0 - All checks passed"
    echo "  1 - Critical issues found"
    exit 0
fi

# Run main function
main "$@"
