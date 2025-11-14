#!/bin/bash

# Main script for Iteration 6: Configure access to domain bibliaris.com
#
# This script coordinates all setup steps:
# 1. Prepare files for the server
# 2. DNS instructions
# 3. Install and configure Caddy on the server
# 4. Verify results

set -euo pipefail

# Configuration
DOMAIN="bibliaris.com"
SERVER_IP="209.74.88.183"
SERVER_USER="deploy"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Dependency check
check_dependencies() {
    log_info "Checking dependencies..."
    
    local missing=()
    
    for cmd in ssh scp dig curl; do
        if ! command -v $cmd &> /dev/null; then
            missing+=($cmd)
        fi
    done
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Required utilities not found: ${missing[*]}"
        log_info "Install them: sudo apt install openssh-client dnsutils curl"
        exit 1
    fi
    
    log_success "All dependencies found"
}

# Check SSH access to the server
check_ssh_access() {
    log_info "Checking SSH access to server $SERVER_IP..."
    
    # First try without password (with key)
    if ssh -o ConnectTimeout=10 -o BatchMode=yes $SERVER_USER@$SERVER_IP "echo 'SSH OK'" >/dev/null 2>&1; then
        log_success "SSH access works (key)"
        return 0
    fi
    
    # If that fails, try with password prompt
    log_info "SSH key not accepted, trying password..."
    if ssh -o ConnectTimeout=10 $SERVER_USER@$SERVER_IP "echo 'SSH OK'" >/dev/null 2>&1; then
        log_success "SSH access works (password)"
        return 0
    else
        log_error "No SSH access to server $SERVER_IP"
        log_info "Make sure:"
        log_info "  - SSH key is added on the server or password login is allowed"
        log_info "  - User $SERVER_USER exists"
        log_info "  - Server is reachable"
        exit 1
    fi
}

# Copy setup script to server
copy_setup_script() {
    log_info "Copying setup script to server..."
    
    if scp scripts/setup_bibliaris_caddy.sh $SERVER_USER@$SERVER_IP:/tmp/; then
        log_success "Script copied to server"
    else
        log_error "Failed to copy script to server"
        exit 1
    fi
}

# Show DNS instructions
show_dns_instructions() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${YELLOW}📋 DNS SETUP INSTRUCTIONS${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "${BLUE}🌐 Domain:${NC} $DOMAIN"
    echo -e "${BLUE}🖥️ Server:${NC} $SERVER_IP"
    echo ""
    echo -e "${YELLOW}📝 Perform the following steps in Namecheap:${NC}"
    echo ""
    echo "1. Log in to Namecheap panel"
    echo "2. Go to Domain List → $DOMAIN → Manage"
    echo "3. ⚠️  CRITICAL: Remove URL Forward in the 'Redirects' section"
    echo "4. Go to 'Advanced DNS'"
    echo "5. Add an A-record:"
    echo "   Type: A Record"
    echo "   Host: @"
    echo "   Value: $SERVER_IP"
    echo "   TTL: Automatic"
    echo "6. Save changes"
    echo ""
    echo -e "${YELLOW}⏱️  DNS changes may take up to 48 hours${NC}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# Install Caddy on the server
install_caddy_on_server() {
    log_info "Installing and configuring Caddy on the server..."
    
    echo ""
    log_warning "Caddy installation will start on server $SERVER_IP"
    log_warning "Sudo privileges are required on the server"
    echo ""
    
    # Run setup script on the server
    if ssh -t $SERVER_USER@$SERVER_IP "sudo bash /tmp/setup_bibliaris_caddy.sh"; then
        log_success "Caddy installed and configured successfully!"
    else
        log_error "Error during Caddy installation"
        return 1
    fi
}

# Check current DNS state
check_current_dns() {
    log_info "Checking current DNS state..."
    
    dns_result=$(dig +short $DOMAIN A 2>/dev/null || echo "")
    
    if [[ "$dns_result" == "$SERVER_IP" ]]; then
        log_success "DNS is already correct: $DOMAIN → $SERVER_IP"
        return 0
    elif [[ -n "$dns_result" ]]; then
        log_warning "DNS points to a different IP: $DOMAIN → $dns_result"
        log_warning "Expected: $SERVER_IP"
        return 1
    else
        log_warning "DNS records not found for $DOMAIN"
        return 1
    fi
}

# Wait for DNS propagation
wait_for_dns() {
    local max_attempts=20
    local attempt=1
    
    log_info "Waiting for DNS propagation..."
    
    while [[ $attempt -le $max_attempts ]]; do
        log_info "Attempt $attempt/$max_attempts..."
        
        if check_current_dns >/dev/null 2>&1; then
            log_success "DNS propagation completed!"
            return 0
        fi
        
        if [[ $attempt -lt $max_attempts ]]; then
            log_info "DNS not updated yet, waiting 30 seconds..."
            sleep 30
        fi
        
        ((attempt++))
    done
    
    log_warning "DNS propagation will take longer"
    log_info "Check later with: ./scripts/check_bibliaris.sh"
    return 1
}

# Final check
final_check() {
    log_info "Running final verification..."
    
    if ./check_bibliaris.sh; then
        log_success "All checks passed! 🎉"
        echo ""
        echo "✅ bibliaris.com is fully configured and working"
        echo "🔗 API available: https://bibliaris.com/"
    else
        log_warning "Some checks failed"
        log_info "Possible reasons:"
        log_info "  - DNS has not fully propagated"
        log_info "  - SSL certificate issuance requires more time"
        log_info "Re-run the check in 10-15 minutes: ./scripts/check_bibliaris.sh"
    fi
}

# Cleanup temporary files
cleanup() {
    log_info "Cleaning up temporary files..."
    
    # Remove script from server
    ssh $SERVER_USER@$SERVER_IP "rm -f /tmp/setup_bibliaris_caddy.sh" 2>/dev/null || true
    
    log_success "Cleanup complete"
}

# Main menu
show_menu() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}🌐 Iteration 6: Configure access to domain bibliaris.com${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Choose an action:"
    echo ""
    echo "1) 📋 Show DNS setup instructions"
    echo "2) 🚀 Install Caddy on the server (requires SSH access)"
    echo "3) 🔍 Check current DNS state"
    echo "4) 🧪 Run full availability check"
    echo "5) ⚡ Run all steps automatically"
    echo "6) 🧹 Clean up temporary files"
    echo "0) 🚪 Exit"
    echo ""
    read -p "Enter selection: " choice
    
    case $choice in
        1) show_dns_instructions; show_menu ;;
        2) copy_setup_script && install_caddy_on_server; show_menu ;;
        3) check_current_dns; show_menu ;;
        4) final_check; show_menu ;;
        5) run_full_setup ;;
        6) cleanup; show_menu ;;
        0) log_info "Exit"; exit 0 ;;
        *) log_error "Invalid choice"; show_menu ;;
    esac
}

# Full automatic setup
run_full_setup() {
    log_info "Starting full automatic setup..."
    echo ""
    
    # Stage 1: Preparation
    check_dependencies
    check_ssh_access
    
    # Stage 2: DNS instructions
    show_dns_instructions
    echo ""
    read -p "Have you configured DNS in Namecheap? (y/N): " dns_done
    
    if [[ ! "$dns_done" =~ ^[Yy]$ ]]; then
        log_warning "Please configure DNS first, then re-run the script"
        exit 1
    fi
    
    # Stage 3: Install Caddy
    copy_setup_script
    install_caddy_on_server
    
    # Stage 4: DNS check
    if check_current_dns; then
        log_success "DNS is ready!"
    else
        log_info "Waiting for DNS propagation..."
        wait_for_dns
    fi
    
    # Stage 5: Final verification
    sleep 10  # Give time for SSL to initialize
    final_check
    
    # Stage 6: Cleanup
    cleanup
    
    echo ""
    log_success "Iteration 6 completed! 🎉"
}

# Command line arguments
if [[ $# -gt 0 ]]; then
    case $1 in
        --auto) run_full_setup ;;
        --dns) show_dns_instructions ;;
        --check) final_check ;;
        --help) 
            echo "Usage: $0 [OPTION]"
            echo "  --auto    Run all stages automatically"
            echo "  --dns     Show DNS instructions"
            echo "  --check   Check site availability"
            echo "  --help    Show this help"
            ;;
        *) log_error "Unknown option: $1"; exit 1 ;;
    esac
else
    show_menu
fi
