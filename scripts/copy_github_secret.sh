#!/bin/bash

# 🔑 Helper for setting up GitHub Secrets
# Usage: ./copy_github_secret.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_FILE="${SCRIPT_DIR}/../.github-secrets/deploy_key"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🔑 GitHub Secrets Setup Helper${NC}"
echo ""

# Check key presence
if [[ ! -f "$KEY_FILE" ]]; then
    echo -e "${RED}❌ Error: Key not found: $KEY_FILE${NC}"
    exit 1
fi

# Copy to clipboard
if command -v xclip &> /dev/null; then
    cat "$KEY_FILE" | xclip -selection clipboard
    CLIPBOARD_CMD="xclip"
elif command -v xsel &> /dev/null; then
    cat "$KEY_FILE" | xsel --clipboard
    CLIPBOARD_CMD="xsel"
elif command -v wl-copy &> /dev/null; then
    cat "$KEY_FILE" | wl-copy
    CLIPBOARD_CMD="wl-copy"
else
    echo -e "${YELLOW}⚠️  Clipboard utility not found${NC}"
    echo -e "${YELLOW}📦 Install: sudo apt install xclip${NC}"
    echo ""
    echo -e "${BLUE}📋 Private key:${NC}"
    cat "$KEY_FILE"
    exit 0
fi

echo -e "${GREEN}✅ Private key copied to clipboard (via $CLIPBOARD_CMD)!${NC}"
echo ""
echo -e "${BLUE}📝 Next steps:${NC}"
echo ""
echo "1️⃣  Open GitHub Secrets:"
echo "   https://github.com/Alex-Berezov/books/settings/secrets/actions"
echo ""
echo "2️⃣  Click 'New repository secret'"
echo ""
echo "3️⃣  Fill in:"
echo "   Name: DEPLOY_SSH_KEY"
echo "   Value: Ctrl+V (paste from clipboard)"
echo ""
echo "4️⃣  Click 'Add secret'"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "5️⃣  Open GitHub Variables:"
echo "   https://github.com/Alex-Berezov/books/settings/variables/actions"
echo ""
echo "6️⃣  Add two variables:"
echo ""
echo "   Variable 1:"
echo "   Name: PRODUCTION_SERVER"
echo "   Value: bibliaris.com"
echo ""
echo "   Variable 2:"
echo "   Name: PRODUCTION_DOMAIN"
echo "   Value: bibliaris.com"
echo ""
echo -e "${GREEN}🚀 After setup, run the workflow:${NC}"
echo "   https://github.com/Alex-Berezov/books/actions/workflows/deploy.yml"
echo ""
