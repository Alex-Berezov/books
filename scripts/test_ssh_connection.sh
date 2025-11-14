#!/bin/bash

# 🔐 Script to verify SSH connectivity to the production server
# Usage: ./test_ssh_connection.sh [server_ip_or_domain]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_KEY="${SCRIPT_DIR}/../.github-secrets/deploy_key"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔐 Checking SSH connectivity to the production server${NC}"
echo ""

# Check key presence
if [[ ! -f "$DEPLOY_KEY" ]]; then
    echo -e "${RED}❌ Error: Deploy key not found: $DEPLOY_KEY${NC}"
    echo -e "${YELLOW}💡 Generate one with: ssh-keygen -t ed25519 -f .github-secrets/deploy_key -N '' -C 'github-actions-deploy@books-app'${NC}"
    exit 1
fi

# Get server address
if [[ -n "$1" ]]; then
    SERVER="$1"
else
    echo -e "${YELLOW}📝 Enter production server address (IP or domain):${NC}"
    read -r SERVER
fi

if [[ -z "$SERVER" ]]; then
    echo -e "${RED}❌ Error: Server address not provided${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}📋 Connection parameters:${NC}"
echo -e "  Server: ${GREEN}$SERVER${NC}"
echo -e "  User: ${GREEN}deploy${NC}"
echo -e "  Key: ${GREEN}$DEPLOY_KEY${NC}"
echo ""

# Check key permissions
PERMS=$(stat -c %a "$DEPLOY_KEY" 2>/dev/null || stat -f %A "$DEPLOY_KEY" 2>/dev/null)
if [[ "$PERMS" != "600" ]]; then
    echo -e "${YELLOW}⚠️  Incorrect key permissions: $PERMS (expected 600)${NC}"
    echo -e "${YELLOW}🔧 Fixing permissions...${NC}"
    chmod 600 "$DEPLOY_KEY"
    echo -e "${GREEN}✅ Permissions fixed${NC}"
    echo ""
fi

# Try to connect
echo -e "${BLUE}🔌 Attempting to connect to the server...${NC}"
echo ""

if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "deploy@$SERVER" "echo '✅ SSH connection successful!'" 2>/dev/null; then
    echo ""
    echo -e "${GREEN}✅ Successfully connected to the server!${NC}"
    echo ""
    
    # Additional checks
    echo -e "${BLUE}🔍 Additional checks:${NC}"
    echo ""
    
    # Docker check
    if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no "deploy@$SERVER" "docker --version" 2>/dev/null; then
        echo -e "${GREEN}✅ Docker available${NC}"
    else
        echo -e "${YELLOW}⚠️  Docker not available for user 'deploy'${NC}"
    fi
    
    # Directory check
    if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no "deploy@$SERVER" "test -d /opt/books/app && echo 'exists'" 2>/dev/null | grep -q "exists"; then
        echo -e "${GREEN}✅ Directory /opt/books/app exists${NC}"
    else
        echo -e "${YELLOW}⚠️  Directory /opt/books/app not found${NC}"
        echo -e "${YELLOW}💡 Create it: sudo mkdir -p /opt/books/app && sudo chown -R deploy:deploy /opt/books${NC}"
    fi
    
    # Write permission check
    if ssh -i "$DEPLOY_KEY" -o StrictHostKeyChecking=no "deploy@$SERVER" "test -w /opt/books/app && echo 'writable'" 2>/dev/null | grep -q "writable"; then
        echo -e "${GREEN}✅ User 'deploy' has write permissions to /opt/books/app${NC}"
    else
        echo -e "${YELLOW}⚠️  User 'deploy' lacks write permissions to /opt/books/app${NC}"
    fi
    
    echo ""
    echo -e "${GREEN}🎉 SSH is configured correctly!${NC}"
    echo -e "${BLUE}📝 Next steps:${NC}"
    echo -e "  1. Add the private key to GitHub Secrets (DEPLOY_SSH_KEY)"
    echo -e "  2. Add variable PRODUCTION_SERVER=$SERVER to GitHub Variables"
    echo -e "  3. Run the GitHub Actions workflow"
    echo ""
    
else
    echo ""
    echo -e "${RED}❌ Failed to connect to the server${NC}"
    echo ""
    echo -e "${YELLOW}🔍 Possible reasons:${NC}"
    echo -e "  1. Public key not added on the server"
    echo -e "  2. Wrong server address"
    echo -e "  3. User 'deploy' not created"
    echo -e "  4. Incorrect permissions on ~/.ssh/authorized_keys"
    echo ""
    echo -e "${BLUE}📝 For detailed diagnostics, use:${NC}"
    echo -e "  ssh -vvv -i $DEPLOY_KEY deploy@$SERVER"
    echo ""
    echo -e "${BLUE}📖 Setup instructions:${NC}"
    echo -e "  cat .github-secrets/SETUP_INSTRUCTIONS.md"
    echo ""
    exit 1
fi
