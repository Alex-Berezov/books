#!/bin/bash
# Script to manage Swagger on the production server

set -e

DEPLOY_DIR="/opt/books/app/src"
ENV_FILE=".env.prod"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

function print_usage() {
  echo "Usage: $0 {enable|disable|status}"
  echo ""
  echo "Commands:"
  echo "  enable  - Enable Swagger (SWAGGER_ENABLED=1)"
  echo "  disable - Disable Swagger (SWAGGER_ENABLED=0)"
  echo "  status  - Check current Swagger status"
  echo ""
  echo "Example:"
  echo "  $0 enable   # Enable Swagger"
  echo "  $0 disable  # Disable Swagger"
  echo "  $0 status   # Show status"
  exit 1
}

function check_env_file() {
  if [ ! -f "$DEPLOY_DIR/$ENV_FILE" ]; then
    echo -e "${RED}❌ File $ENV_FILE not found in $DEPLOY_DIR${NC}"
    exit 1
  fi
}

function get_current_value() {
  cd "$DEPLOY_DIR"
  grep "^SWAGGER_ENABLED=" "$ENV_FILE" | cut -d'=' -f2 || echo "not_set"
}

function enable_swagger() {
  echo -e "${YELLOW}🔧 Enabling Swagger...${NC}"
  
  cd "$DEPLOY_DIR"
  
  # Check current value
  CURRENT=$(get_current_value)
  
  if [ "$CURRENT" = "1" ]; then
    echo -e "${GREEN}✅ Swagger is already enabled${NC}"
    return 0
  fi
  
  # Update value
  if grep -q "^SWAGGER_ENABLED=" "$ENV_FILE"; then
    sed -i 's/^SWAGGER_ENABLED=.*/SWAGGER_ENABLED=1/' "$ENV_FILE"
  else
    echo "SWAGGER_ENABLED=1" >> "$ENV_FILE"
  fi
  
  echo -e "${GREEN}✅ SWAGGER_ENABLED=1 set in $ENV_FILE${NC}"
  
  # Restart app container
  echo -e "${YELLOW}🔄 Restarting app...${NC}"
  docker compose --profile prod -f docker-compose.prod.yml restart app
  
  echo ""
  echo -e "${GREEN}✅ Swagger enabled!${NC}"
  echo -e "${GREEN}📍 URL: https://api.bibliaris.com/docs${NC}"
  echo -e "${GREEN}📍 JSON: https://api.bibliaris.com/docs-json${NC}"
  echo ""
  echo -e "${YELLOW}⚠️  REMEMBER TO DISABLE after use: $0 disable${NC}"
}

function disable_swagger() {
  echo -e "${YELLOW}🔧 Disabling Swagger...${NC}"
  
  cd "$DEPLOY_DIR"
  
  # Check current value
  CURRENT=$(get_current_value)
  
  if [ "$CURRENT" = "0" ]; then
    echo -e "${GREEN}✅ Swagger is already disabled${NC}"
    return 0
  fi
  
  # Update value
  if grep -q "^SWAGGER_ENABLED=" "$ENV_FILE"; then
    sed -i 's/^SWAGGER_ENABLED=.*/SWAGGER_ENABLED=0/' "$ENV_FILE"
  else
    echo "SWAGGER_ENABLED=0" >> "$ENV_FILE"
  fi
  
  echo -e "${GREEN}✅ SWAGGER_ENABLED=0 set in $ENV_FILE${NC}"
  
  # Restart app container
  echo -e "${YELLOW}🔄 Restarting app...${NC}"
  docker compose --profile prod -f docker-compose.prod.yml restart app
  
  echo ""
  echo -e "${GREEN}✅ Swagger disabled${NC}"
}

function check_status() {
  echo -e "${YELLOW}🔍 Checking Swagger status...${NC}"
  
  cd "$DEPLOY_DIR"
  
  CURRENT=$(get_current_value)
  
  echo ""
  echo "Configuration ($ENV_FILE):"
  echo "  SWAGGER_ENABLED=$CURRENT"
  echo ""
  
  if [ "$CURRENT" = "1" ]; then
    echo -e "${GREEN}✅ Swagger ENABLED${NC}"
    echo -e "${GREEN}📍 URL: https://bibliaris.com/docs${NC}"
    echo -e "${GREEN}📍 JSON: https://bibliaris.com/docs-json${NC}"
  elif [ "$CURRENT" = "0" ]; then
    echo -e "${YELLOW}⚠️  Swagger DISABLED${NC}"
  else
    echo -e "${RED}❌ SWAGGER_ENABLED is not set${NC}"
  fi
  
  echo ""
  echo "Application logs (last mentions of 'swagger'):"
  docker compose --profile prod -f docker-compose.prod.yml logs app 2>/dev/null | grep -i "swagger" | tail -n 3 || echo "  (no log entries found)"
}

# Main script
if [ "$#" -ne 1 ]; then
  print_usage
fi

check_env_file

case "$1" in
  enable)
    enable_swagger
    ;;
  disable)
    disable_swagger
    ;;
  status)
    check_status
    ;;
  *)
    print_usage
    ;;
esac
