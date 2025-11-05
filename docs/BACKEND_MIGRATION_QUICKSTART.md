# 🚀 Быстрый старт: Миграция бэкенд документации

> **Для ИИ-агента бэкенда:** Краткая шпаргалка по миграции документации

## 🎯 Задача

Перенести документацию из `books-app-back/docs/` в `books-app-docs/backend/` и настроить MCP.

## ⚡ Команды для выполнения

### 1. Клонировать books-app-docs
```bash
cd ~/Dev
git clone git@github.com:Alex-Berezov/books-app-docs.git
```

### 2. Создать структуру папок  
```bash
cd books-app-docs
mkdir -p backend/{api,architecture,deployment,guides,troubleshooting}
mkdir -p backend/api/examples
```

### 3. Скопировать документацию
```bash
# Из бэкенд репо (адаптируй пути)
cp ../books-app-back/docs/ENDPOINTS.md backend/api/endpoints.md
cp ../books-app-back/docs/API.md backend/api/
cp ../books-app-back/docs/PRODUCTION_DEPLOYMENT_GUIDE.md backend/deployment/production.md
# И так далее для всех .md файлов
```

### 4. Очистить бэкенд репо
```bash
cd ../books-app-back
echo "docs/" >> .gitignore
git rm -r --cached docs/
# Обновить README.md со ссылкой на books-app-docs
git add .gitignore README.md
git commit -m "docs: move documentation to books-app-docs"
git push
```

### 5. Настроить MCP (если не настроен)
```bash
mkdir -p ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings

cat > ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json << 'JSON'
{
  "mcpServers": {
    "filesystem-bibliaris-docs": {
      "command": "npx",
      "args": [
        "-y", 
        "@modelcontextprotocol/server-filesystem",
        "/home/aleber/Dev/books-app-docs"
      ],
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
JSON

# Перезапустить VS Code!
```

### 6. Коммитнуть в books-app-docs
```bash
cd ~/Dev/books-app-docs
git add backend/
git commit -m "docs: migrate backend documentation from books-app-back"
git push origin main
```

## ✅ Проверка работы

После перезапуска VS Code спроси у ИИ-агента:
```
"Покажи структуру API для книг"
```

Должен найти endpoints из `books-app-docs/backend/api/`

## 📋 Чек-лист

- [ ] Склонировал books-app-docs
- [ ] Создал структуру папок в backend/
- [ ] Скопировал все .md файлы из books-app-back/docs/
- [ ] Очистил books-app-back (gitignore + git rm)
- [ ] Настроил MCP конфигурацию  
- [ ] Перезапустил VS Code
- [ ] Протестировал доступ к документации через ИИ
- [ ] Закоммитил изменения в оба репо

## 🆘 Проблемы?

См. подробную инструкцию: [BACKEND_AGENT_MIGRATION_INSTRUCTIONS.md](./BACKEND_AGENT_MIGRATION_INSTRUCTIONS.md)

---

**Время выполнения:** ~15-30 минут  
**Результат:** ИИ-агент видит документацию фронта И бэка! 🎉
