#!/bin/bash
# Simple script to apply settings for api.bibliaris.com
# Run: sudo bash apply-subdomain-simple.sh

set -e

echo "=== Applying settings for api.bibliaris.com ==="
echo ""

# 1. Create a backup of Caddyfile
echo "▶ Creating Caddyfile backup..."
BACKUP_FILE="/etc/caddy/Caddyfile.backup.$(date +%Y%m%d_%H%M%S)"
cp /etc/caddy/Caddyfile "$BACKUP_FILE"
echo "✓ Backup created: $BACKUP_FILE"
echo ""

# 2. Update Caddyfile
echo "▶ Updating Caddyfile..."
cp ~/Caddyfile.new /etc/caddy/Caddyfile
echo "✓ Caddyfile updated"
echo ""

# 3. Validate Caddy syntax
echo "▶ Validating Caddy syntax..."
caddy validate --config /etc/caddy/Caddyfile
echo "✓ Syntax is valid"
echo ""

# 4. Reload Caddy
echo "▶ Reloading Caddy..."
systemctl reload caddy
echo "✓ Caddy reloaded"
echo ""

# 5. Update .env.prod
echo "▶ Updating .env.prod..."
cd /opt/books/app/src

# Backup .env.prod
cp .env.prod .env.prod.backup.$(date +%Y%m%d_%H%M%S)

# Update environment variables
sed -i 's|LOCAL_PUBLIC_BASE_URL=.*|LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com|' .env.prod
sed -i 's|CORS_ORIGIN=.*|CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001|' .env.prod

echo "✓ .env.prod updated"
echo ""

# 6. Restart application
echo "▶ Restarting application..."
docker compose -f docker-compose.prod.yml restart app
echo "✓ Application restarted"
echo ""

# 7. Wait for readiness
echo "▶ Waiting for application to be ready (30 seconds)..."
sleep 30
echo ""

# 8. Check container status
echo "▶ Checking containers status..."
docker compose -f docker-compose.prod.yml ps
echo ""

echo "=== ✓ Setup completed successfully! ==="
echo ""
echo "Verify endpoints:"
echo "  curl https://api.bibliaris.com/api/health/liveness"
echo "  curl https://api.bibliaris.com/docs"
echo "  curl https://api.bibliaris.com/metrics"
