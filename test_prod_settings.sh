#!/bin/bash
# Скрипт для локального тестирования prod настроек

echo "🧪 Тестирование продакшн настроек локально"
echo "=========================================="

# Сохранить оригинальный .env
if [ -f .env ]; then
    cp .env .env.backup
    echo "✅ Сохранен .env как .env.backup"
fi

# Временно заменить .env на .env.prod для тестирования
cp .env.prod .env.temp
echo "✅ Создан временный .env.temp из .env.prod"

# Модифицировать DATABASE_URL для локального тестирования
sed 's/postgres:5432/localhost:5432/g' .env.temp > .env.test_prod

echo "✅ Создан .env.test_prod для локального тестирования"
echo ""
echo "📝 Настройки для продакшна:"
echo "   - NODE_ENV=production"
echo "   - SWAGGER_ENABLED=0"
echo "   - RATE_LIMIT_GLOBAL_ENABLED=1"
echo "   - TRUST_PROXY=1"
echo "   - JWT секреты обновлены"
echo ""
echo "ℹ️  Для тестирования используйте:"
echo "   NODE_ENV=production ENV_FILE=.env.test_prod yarn start"
echo ""
echo "🧹 Для очистки:"
echo "   rm .env.temp .env.test_prod"

if [ -f .env.backup ]; then
    echo "   mv .env.backup .env  # Восстановить оригинал"
fi
