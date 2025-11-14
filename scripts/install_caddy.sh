#!/bin/bash

# Script to install and configure Caddy for production
# Run with sudo on the production server

echo "🚀 Installing and configuring Caddy reverse proxy"
echo "============================================="

# Ensure running as root/sudo
if [[ $EUID -ne 0 ]]; then
    echo "❌ This script must be run with sudo"
   exit 1
fi

# Step 1: Install Caddy
echo "📦 Installing Caddy..."

# Add Caddy keys and repository
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list

# Update packages and install Caddy
apt update
apt install -y caddy

# Step 2: Create directories
echo "📁 Creating directories..."
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# Step 3: Copy configuration
echo "⚙️ Configuring..."

# Ensure configuration file exists
if [ ! -f "/opt/books/app/src/configs/Caddyfile.prod" ]; then
    echo "❌ Configuration file not found: /opt/books/app/src/configs/Caddyfile.prod"
    echo "   Copy the file from the repository to configs/Caddyfile.prod"
    exit 1
fi

# Copy configuration
cp /opt/books/app/src/configs/Caddyfile.prod /etc/caddy/Caddyfile

# Step 4: Configure firewall
echo "🔥 Configuring firewall..."

# Install ufw if not present
if ! command -v ufw &> /dev/null; then
    apt install -y ufw
fi

# Open HTTP and HTTPS ports
ufw allow 80/tcp
ufw allow 443/tcp

# Show firewall status
echo "📋 Current firewall rules:"
ufw status

# Step 5: Validate configuration
echo "✅ Validating Caddy configuration..."
caddy validate --config /etc/caddy/Caddyfile

if [ $? -ne 0 ]; then
    echo "❌ Caddy configuration error!"
    exit 1
fi

# Step 6: Start services
echo "🚀 Starting Caddy..."

# Enable autostart
systemctl enable caddy

# Restart with new configuration
systemctl restart caddy

# Check status
sleep 2
systemctl status caddy --no-pager -l

echo ""
echo "✅ Caddy installation completed!"
echo ""
echo "🔍 For verification:"
echo "   systemctl status caddy"
echo "   journalctl -u caddy -f"
echo "   curl -I https://api.example.com/api/health/liveness"
echo ""
echo "📋 Caddy logs:"
echo "   /var/log/caddy/api.log"
echo ""
echo "⚠️ Don't forget:"
echo "   1. Set DNS A-record api.example.com → server IP"
echo "   2. Update CORS_ORIGIN in .env.prod"
echo "   3. Update LOCAL_PUBLIC_BASE_URL in .env.prod"
