#!/bin/bash

# Script to configure Caddy for domain bibliaris.com
# Run on the production server 209.74.88.183

set -euo pipefail

echo "🌐 Setting up Caddy for bibliaris.com"
echo "===================================="

# Root/sudo check
if [[ $EUID -ne 0 ]]; then
    echo "❌ This script must be run with sudo"
   exit 1
fi

# Logging functions
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] $*"
}

log_error() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [ERROR] $*" >&2
}

# Ensure the application is running
check_app() {
    log "Checking application status..."
    
    if curl -sf http://localhost:5000/api/health/liveness > /dev/null; then
        log "✅ Application is running on port 5000"
    else
        log_error "❌ Application is not responding on localhost:5000"
        log_error "Start the application before installing Caddy"
        exit 1
    fi
}

# Install Caddy
install_caddy() {
    log "Checking Caddy installation..."
    
    if command -v caddy &> /dev/null; then
        log "✅ Caddy already installed ($(caddy version))"
        return 0
    fi
    
    log "📦 Installing Caddy..."
    
    # Install dependencies
    apt update
    apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    
    # Add Caddy repository
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    
    # Install Caddy
    apt update
    apt install -y caddy
    
    log "✅ Caddy installed: $(caddy version)"
}

# Configure Caddyfile
setup_caddyfile() {
    log "⚙️ Configuring Caddyfile..."
    
    # Create logs directory
    mkdir -p /var/log/caddy
    chown caddy:caddy /var/log/caddy
    
    # Create Caddyfile
    cat > /etc/caddy/Caddyfile << 'EOF'
bibliaris.com {
    reverse_proxy localhost:5000

    # Security headers
    header {
        # Hide server information
        -Server

        # Security headers
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # Logging
    log {
        output file /var/log/caddy/bibliaris.com.log
        format json
    }
}

# Redirect from www
www.bibliaris.com {
    redir https://bibliaris.com{uri} permanent
}
EOF
    
    log "✅ Caddyfile created"
}

# Configure firewall
setup_firewall() {
    log "🔥 Configuring firewall..."
    
    # Install UFW if missing
    if ! command -v ufw &> /dev/null; then
        apt install -y ufw
    fi
    
    # Open HTTP/HTTPS ports
    ufw allow 80/tcp
    ufw allow 443/tcp
    
    log "✅ Ports 80/443 opened"
}

# Validate configuration and start
start_caddy() {
    log "🔧 Validating Caddy configuration..."
    
    if caddy validate --config /etc/caddy/Caddyfile; then
        log "✅ Configuration valid"
    else
        log_error "❌ Caddy configuration error"
        exit 1
    fi
    
    log "🚀 Starting Caddy..."
    
    # Enable and start service
    systemctl enable caddy
    systemctl restart caddy
    
    # Check status
    if systemctl is-active --quiet caddy; then
        log "✅ Caddy started successfully"
    else
        log_error "❌ Caddy failed to start"
        systemctl status caddy
        exit 1
    fi
}

# Final check
final_check() {
    log "🧪 Final verification..."
    
    sleep 5  # Give time to start
    
    # Check ports
    if ss -tlnp | grep -q ":80 "; then
        log "✅ Caddy is listening on port 80"
    else
        log_error "❌ Port 80 not listening"
    fi
    
    if ss -tlnp | grep -q ":443 "; then
        log "✅ Caddy is listening on port 443"
    else
        log_error "❌ Port 443 not listening"
    fi
    
    # Show logs
    log "📋 Latest Caddy logs:"
    journalctl -u caddy --no-pager -n 5
}

# Main logic
main() {
    log "Starting Caddy setup for bibliaris.com"
    
    check_app
    install_caddy
    setup_caddyfile
    setup_firewall
    start_caddy
    final_check
    
    echo ""
    echo "🎉 Caddy successfully configured for bibliaris.com!"
    echo ""
    echo "📋 Next steps:"
    echo "1. Configure DNS A-record: bibliaris.com → 209.74.88.183"
    echo "2. Remove URL Forward in Namecheap"
    echo "3. Wait for DNS propagation (up to 48 hours)"
    echo "4. Verify availability: https://bibliaris.com"
    echo ""
    echo "🔍 For status checks:"
    echo "  systemctl status caddy"
    echo "  journalctl -u caddy -f"
    echo "  curl -I https://bibliaris.com/api/health/liveness"
}

# Run
main "$@"
