#!/bin/bash
# Script to apply api.bibliaris.com settings on production server
# 
# WARNING: This script must be executed on the production server!
# 
# Usage:
#   1. Copy this file to the server: scp scripts/apply-api-subdomain.sh deploy@209.74.88.183:~/
#   2. Connect to the server: ssh deploy@209.74.88.183
#   3. Run: bash apply-api-subdomain.sh --dry-run
#   4. Check the output, then run without --dry-run

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
  DRY_RUN=true
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Setting up api.bibliaris.com on production${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}🔍 DRY RUN MODE - commands will NOT be executed${NC}"
  echo ""
fi

# Function to execute commands
run_cmd() {
  local cmd="$1"
  local description="$2"
  
  echo -e "${BLUE}▶ ${description}${NC}"
  echo "  Command: $cmd"
  
  if [ "$DRY_RUN" = false ]; then
    eval "$cmd"
    if [ $? -eq 0 ]; then
      echo -e "  ${GREEN}✓ Success${NC}"
    else
      echo -e "  ${RED}✗ Error${NC}"
      exit 1
    fi
  else
    echo -e "  ${YELLOW}⊘ Skipped (dry-run)${NC}"
  fi
  echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: DNS Check
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Step 1: DNS Check ═══${NC}"
echo ""

echo "Checking DNS record for api.bibliaris.com..."
DNS_IP=$(dig +short api.bibliaris.com | head -n 1)

if [ -z "$DNS_IP" ]; then
  echo -e "${RED}✗ DNS record for api.bibliaris.com not found!${NC}"
  echo ""
  echo "Please add an A record in Namecheap:"
  echo "  Type: A Record"
  echo "  Host: api"
  echo "  Value: 209.74.88.183"
  echo "  TTL: Automatic"
  echo ""
  echo "After adding the record, wait a few minutes and run the script again."
  exit 1
elif [ "$DNS_IP" != "209.74.88.183" ]; then
  echo -e "${YELLOW}⚠ DNS record exists, but points to a different IP: $DNS_IP${NC}"
  echo "Expected IP: 209.74.88.183"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
else
  echo -e "${GREEN}✓ DNS record is correct: api.bibliaris.com → $DNS_IP${NC}"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Backup current Caddy configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Step 2: Backup Caddy configuration ═══${NC}"
echo ""

BACKUP_FILE="/etc/caddy/Caddyfile.backup.$(date +%Y%m%d_%H%M%S)"
run_cmd "sudo cp /etc/caddy/Caddyfile $BACKUP_FILE" "Creating Caddyfile backup"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Update Caddy configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Step 3: Update Caddyfile ═══${NC}"
echo ""

# Create new Caddyfile
CADDYFILE_CONTENT='# API Backend
api.bibliaris.com {
    reverse_proxy localhost:5000

    # Security headers
    header {
        # HSTS
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        
        # Prevent clickjacking
        X-Frame-Options "SAMEORIGIN"
        
        # Prevent MIME sniffing
        X-Content-Type-Options "nosniff"
        
        # XSS Protection
        X-XSS-Protection "1; mode=block"
        
        # Referrer Policy
        Referrer-Policy "strict-origin-when-cross-origin"
        
        # CORS (allow frontend domains)
        Access-Control-Allow-Origin "https://bibliaris.com"
        Access-Control-Allow-Credentials "true"
        Access-Control-Allow-Methods "GET, POST, PUT, DELETE, PATCH, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization, X-Admin-Language, Accept-Language"
    }

    # Logging
    log {
        output file /var/log/caddy/api.bibliaris.com.access.log
        format json
    }
}

# Frontend (temporary redirect to API docs)
bibliaris.com {
    redir https://api.bibliaris.com/docs permanent
    
    log {
        output file /var/log/caddy/bibliaris.com.access.log
        format json
    }
}

# WWW redirects
www.bibliaris.com {
    redir https://bibliaris.com{uri} permanent
}

www.api.bibliaris.com {
    redir https://api.bibliaris.com{uri} permanent
}'

if [ "$DRY_RUN" = false ]; then
  echo "$CADDYFILE_CONTENT" | sudo tee /etc/caddy/Caddyfile > /dev/null
  echo -e "${GREEN}✓ Caddyfile updated${NC}"
else
  echo -e "${YELLOW}⊘ Caddyfile update skipped (dry-run)${NC}"
  echo ""
  echo "New Caddyfile content:"
  echo "----------------------------------------"
  echo "$CADDYFILE_CONTENT"
  echo "----------------------------------------"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Validate and apply Caddy configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Step 4: Validate Caddy configuration ═══${NC}"
echo ""

run_cmd "sudo caddy validate --config /etc/caddy/Caddyfile" "Validating Caddyfile syntax"
run_cmd "sudo systemctl reload caddy" "Reloading Caddy"
run_cmd "sudo systemctl status caddy --no-pager -l" "Checking Caddy status"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Update .env.prod
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Step 5: Update .env.prod ═══${NC}"
echo ""

ENV_FILE="/opt/books/app/src/.env.prod"

if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}✗ File $ENV_FILE not found!${NC}"
  exit 1
fi

# Create .env.prod backup
run_cmd "cp $ENV_FILE ${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)" "Creating .env.prod backup"

# Update variables
if [ "$DRY_RUN" = false ]; then
  # Update LOCAL_PUBLIC_BASE_URL
  if grep -q "^LOCAL_PUBLIC_BASE_URL=" "$ENV_FILE"; then
    sudo sed -i 's|^LOCAL_PUBLIC_BASE_URL=.*|LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com|' "$ENV_FILE"
    echo -e "${GREEN}✓ LOCAL_PUBLIC_BASE_URL updated${NC}"
  else
    echo "LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com" | sudo tee -a "$ENV_FILE" > /dev/null
    echo -e "${GREEN}✓ LOCAL_PUBLIC_BASE_URL added${NC}"
  fi
  
  # Update CORS_ORIGIN
  if grep -q "^CORS_ORIGIN=" "$ENV_FILE"; then
    sudo sed -i 's|^CORS_ORIGIN=.*|CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001|' "$ENV_FILE"
    echo -e "${GREEN}✓ CORS_ORIGIN updated${NC}"
  else
    echo "CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001" | sudo tee -a "$ENV_FILE" > /dev/null
    echo -e "${GREEN}✓ CORS_ORIGIN added${NC}"
  fi
else
  echo -e "${YELLOW}⊘ .env.prod update skipped (dry-run)${NC}"
  echo ""
  echo "The following variables will be updated:"
  echo "  LOCAL_PUBLIC_BASE_URL=https://api.bibliaris.com"
  echo "  CORS_ORIGIN=https://bibliaris.com,http://localhost:3000,http://localhost:3001"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: Restart application
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Step 6: Restart application ═══${NC}"
echo ""

APP_DIR="/opt/books/app/src"
cd "$APP_DIR" || exit 1

run_cmd "docker compose -f docker-compose.prod.yml restart app" "Restarting Docker container"

echo "Waiting for container to be ready (30 seconds)..."
if [ "$DRY_RUN" = false ]; then
  sleep 30
fi
echo ""

run_cmd "docker compose -f docker-compose.prod.yml ps" "Checking container status"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 7: Health checks
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${GREEN}═══ Step 7: Health checks ═══${NC}"
echo ""

if [ "$DRY_RUN" = false ]; then
  echo "Checking SSL and API endpoints..."
  echo ""
  
  # Check liveness
  echo "1. Checking Liveness endpoint..."
  if curl -f -s -o /dev/null -w "HTTP %{http_code}" https://api.bibliaris.com/api/health/liveness; then
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${RED}✗${NC}"
  fi
  echo ""
  
  # Check readiness
  echo "2. Checking Readiness endpoint..."
  if curl -f -s -o /dev/null -w "HTTP %{http_code}" https://api.bibliaris.com/api/health/readiness; then
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${RED}✗${NC}"
  fi
  echo ""
  
  # Check Swagger
  echo "3. Checking Swagger UI..."
  if curl -f -s -o /dev/null -w "HTTP %{http_code}" https://api.bibliaris.com/docs; then
    echo -e " ${GREEN}✓${NC}"
  else
    echo -e " ${RED}✗${NC}"
  fi
  echo ""
  
  # Check CORS headers
  echo "4. Checking CORS headers..."
  CORS_HEADER=$(curl -s -I https://api.bibliaris.com/api/health/liveness -H "Origin: https://bibliaris.com" | grep -i "access-control-allow-origin")
  if [ -n "$CORS_HEADER" ]; then
    echo -e " ${GREEN}✓ $CORS_HEADER${NC}"
  else
    echo -e " ${YELLOW}⚠ CORS headers not found${NC}"
  fi
  echo ""
  
  # Check SSL certificate
  echo "5. Checking SSL certificate..."
  SSL_INFO=$(echo | openssl s_client -servername api.bibliaris.com -connect api.bibliaris.com:443 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null)
  if [ -n "$SSL_INFO" ]; then
    echo -e " ${GREEN}✓${NC}"
    echo "$SSL_INFO" | sed 's/^/   /'
  else
    echo -e " ${RED}✗ Failed to get certificate information${NC}"
  fi
else
  echo -e "${YELLOW}⊘ Checks skipped (dry-run)${NC}"
  echo ""
  echo "After applying settings, perform the following checks:"
  echo "  1. curl https://api.bibliaris.com/api/health/liveness"
  echo "  2. curl https://api.bibliaris.com/api/health/readiness"
  echo "  3. Open in browser: https://api.bibliaris.com/docs"
  echo "  4. Check CORS: curl -I https://api.bibliaris.com/api/health/liveness -H 'Origin: https://bibliaris.com'"
fi
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Completion
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}🔍 DRY RUN completed!${NC}"
  echo ""
  echo "To apply settings, run without --dry-run flag:"
  echo "  bash apply-api-subdomain.sh"
else
  echo -e "${GREEN}✅ api.bibliaris.com setup completed successfully!${NC}"
  echo ""
  echo "Check API operation:"
  echo "  • https://api.bibliaris.com/api/health/liveness"
  echo "  • https://api.bibliaris.com/api/health/readiness"
  echo "  • https://api.bibliaris.com/docs"
  echo "  • https://api.bibliaris.com/metrics"
  echo ""
  echo "Next step: Update GitHub Secret ENV_PROD with new values"
fi
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
