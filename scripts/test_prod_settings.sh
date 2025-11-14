#!/bin/bash
# Script to locally test production settings

echo "🧪 Testing production settings locally"
echo "======================================"

# Backup original .env
if [ -f .env ]; then
    cp .env .env.backup
    echo "✅ Saved .env as .env.backup"
fi

# Create a temporary env from .env.prod for testing
cp .env.prod .env.temp
echo "✅ Created temporary .env.temp from .env.prod"

# Adjust DATABASE_URL for local testing
sed 's/postgres:5432/localhost:5432/g' .env.temp > .env.test_prod

echo "✅ Created .env.test_prod for local testing"
echo ""
echo "📝 Production settings:"
echo "   - NODE_ENV=production"
echo "   - SWAGGER_ENABLED=0"
echo "   - RATE_LIMIT_GLOBAL_ENABLED=1"
echo "   - TRUST_PROXY=1"
echo "   - JWT secrets updated"
echo ""
echo "ℹ️  To test, run:"
echo "   NODE_ENV=production ENV_FILE=.env.test_prod yarn start"
echo ""
echo "🧹 To clean up:"
echo "   rm .env.temp .env.test_prod"

if [ -f .env.backup ]; then
    echo "   mv .env.backup .env  # Restore original"
fi
