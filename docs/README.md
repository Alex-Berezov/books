# 📚 Документация проекта Books App

> Индекс актуальной документации проекта  
> Последнее обновление: 31 октября 2025

## 🎯 Для AI-ассистентов и быстрого старта

Если вы AI-ассистент или новый разработчик, начните с этих файлов:

1. **[AGENT_CONTEXT.md](AGENT_CONTEXT.md)** - Правила работы, стиль кода, контракт итераций
2. **[../README.md](../README.md)** - Главная документация: установка, запуск, конфигурация
3. **[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)** - Обзор архитектуры и основных концепций
4. **[../CHANGELOG.md](../CHANGELOG.md)** - История изменений проекта

## 📖 Основная документация

### Архитектура и спецификации

- **[ENDPOINTS.md](ENDPOINTS.md)** - Полная спецификация API endpoints
- **[API_URL_STRUCTURE.md](API_URL_STRUCTURE.md)** - ⭐ Архитектурное решение по структуре URL
- **[MULTISITE_I18N.md](MULTISITE_I18N.md)** - Мультиязычность и i18n
- **[MEDIA_LIBRARY.md](MEDIA_LIBRARY.md)** - Система управления медиа
- **[ADMIN_UI_SPEC.md](ADMIN_UI_SPEC.md)** - Спецификация админ-панели
- **[adr/](adr/)** - Architecture Decision Records (ADR)

### Frontend интеграция

- **[AI_AGENT_FRONTEND_GUIDE.md](AI_AGENT_FRONTEND_GUIDE.md)** - 🤖 Полное руководство для AI-агентов фронтенда
- **[FRONTEND_COMMON_ISSUES.md](FRONTEND_COMMON_ISSUES.md)** - � Распространенные проблемы и их решения
- **[FRONTEND_QUICK_START.md](FRONTEND_QUICK_START.md)** - 🚀 Быстрый старт для фронтенда

### Roadmap и планирование

- **[ITERATION_TASKS.md](ITERATION_TASKS.md)** - План задач и итераций (roadmap)

## 🚀 Production и Development

### Deployment

- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Техническая документация деплоя
- **[PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md)** - Пошаговое руководство
- **[DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md)** - Чеклист для деплоя (22 этапа)

### Инфраструктура и безопасность

- **[SECURITY_GUIDE.md](SECURITY_GUIDE.md)** - Настройка безопасности сервера
- **[MONITORING_GUIDE.md](MONITORING_GUIDE.md)** - Prometheus + Grafana + AlertManager
- **[BACKUP_GUIDE.md](BACKUP_GUIDE.md)** - Система бэкапов PostgreSQL
- **[REVERSE_PROXY_GUIDE.md](REVERSE_PROXY_GUIDE.md)** - Caddy reverse proxy с HTTPS

### Тестирование

- **[UNIT_TESTING_PLAN.md](UNIT_TESTING_PLAN.md)** - План юнит-тестирования

## 🎓 Быстрые ссылки

### Для разработки

```bash
# Установка и запуск
yarn
yarn prisma:migrate
yarn prisma:generate
yarn start:dev

# Тесты
yarn test              # unit tests
yarn test:e2e          # e2e tests
yarn lint              # eslint
yarn typecheck         # typescript check
```

### Production URLs

- **API Base**: https://api.bibliaris.com/api/*
- **Swagger UI**: https://api.bibliaris.com/docs ⭐
- **OpenAPI JSON**: https://api.bibliaris.com/docs-json ⭐
- **Health**: https://api.bibliaris.com/api/health/liveness
- **Metrics**: https://api.bibliaris.com/api/metrics

**Примечание**: Swagger на `/docs` (без `/api`), API endpoints на `/api/*` - см. [API_URL_STRUCTURE.md](API_URL_STRUCTURE.md)

## 📊 Статус проекта

- ✅ **Production**: Полностью функционален на bibliaris.com
- ✅ **HTTPS**: SSL сертификат от Let's Encrypt
- ✅ **Monitoring**: Prometheus метрики доступны
- ✅ **Documentation**: Swagger UI активен

---

**Последняя завершенная итерация**: Iteration 8 - Подготовка Backend для Frontend (31.10.2025)

Для истории изменений см. [CHANGELOG.md](../CHANGELOG.md)
