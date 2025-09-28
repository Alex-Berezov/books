#!/bin/bash

# Production Server Setup Script
# ===============================
# Автоматическая настройка VPS для развертывания Books App Backend
# 
# Использование:
#   ./scripts/setup_server.sh [OPTIONS]
#
# Опции:
#   --domain DOMAIN    Основной домен API (например: api.example.com)
#   --user USER        Пользователь для деплоя (по умолчанию: deploy)
#   --skip-security   Пропустить настройку безопасности
#   --skip-monitoring Пропустить настройку мониторинга
#   --skip-caddy      Пропустить установку Caddy
#   --dry-run         Показать команды без выполнения
#   -h, --help        Показать эту справку

set -euo pipefail

# Цветовая схема для логов
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

# Переменные по умолчанию
DOMAIN=""
DEPLOY_USER="deploy"
SKIP_SECURITY=false
SKIP_MONITORING=false
SKIP_CADDY=false
DRY_RUN=false

# Логирование
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_info() {
    echo -e "${CYAN}ℹ️  $1${NC}"
}

# Показать справку
show_help() {
    cat << EOF
Production Server Setup Script
===============================

Автоматическая настройка VPS сервера для Books App Backend.

ИСПОЛЬЗОВАНИЕ:
    ./scripts/setup_server.sh --domain api.example.com [OPTIONS]

ОБЯЗАТЕЛЬНЫЕ ПАРАМЕТРЫ:
    --domain DOMAIN    Основной домен API (например: api.example.com)

ОПЦИОНАЛЬНЫЕ ПАРАМЕТРЫ:
    --user USER        Пользователь для деплоя (по умолчанию: deploy)
    --skip-security    Пропустить настройку безопасности
    --skip-monitoring  Пропустить настройку мониторинга  
    --skip-caddy       Пропустить установку Caddy
    --dry-run          Показать команды без выполнения
    -h, --help         Показать эту справку

ПРИМЕРЫ:
    # Полная настройка сервера
    ./scripts/setup_server.sh --domain api.mybooks.com
    
    # Настройка без мониторинга
    ./scripts/setup_server.sh --domain api.mybooks.com --skip-monitoring
    
    # Dry run для проверки команд
    ./scripts/setup_server.sh --domain api.mybooks.com --dry-run

ТРЕБОВАНИЯ:
    - Ubuntu 22.04+ или Debian 12+
    - Root доступ или sudo права
    - Интернет соединение
    - Открытые порты: 22, 80, 443

EOF
}

# Парсинг аргументов
while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)
            DOMAIN="$2"
            shift 2
            ;;
        --user)
            DEPLOY_USER="$2"
            shift 2
            ;;
        --skip-security)
            SKIP_SECURITY=true
            shift
            ;;
        --skip-monitoring)
            SKIP_MONITORING=true
            shift
            ;;
        --skip-caddy)
            SKIP_CADDY=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            log_error "Неизвестный параметр: $1"
            echo "Используйте --help для справки"
            exit 1
            ;;
    esac
done

# Проверка обязательных параметров
if [[ -z "$DOMAIN" ]]; then
    log_error "Не указан домен. Используйте --domain api.example.com"
    echo "Используйте --help для справки"
    exit 1
fi

# Функция выполнения команд (с поддержкой dry-run)
execute() {
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "${GRAY}[DRY-RUN] $1${NC}"
    else
        log "Выполняется: $1"
        eval "$1"
    fi
}

# Проверка root прав
check_root() {
    if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
        log_error "Требуются права root или sudo без пароля"
        exit 1
    fi
}

# Проверка операционной системы
check_os() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case $ID in
            ubuntu)
                if [[ $(echo "$VERSION_ID >= 22.04" | bc -l) -eq 0 ]]; then
                    log_warning "Рекомендуется Ubuntu 22.04+, текущая: $VERSION_ID"
                fi
                ;;
            debian)
                if [[ $(echo "$VERSION_ID >= 12" | bc -l) -eq 0 ]]; then
                    log_warning "Рекомендуется Debian 12+, текущая: $VERSION_ID"
                fi
                ;;
            *)
                log_warning "Неподдерживаемая ОС: $PRETTY_NAME"
                ;;
        esac
    else
        log_warning "Не удалось определить операционную систему"
    fi
}

# Обновление системы
update_system() {
    log "Обновление системы..."
    execute "apt-get update -y"
    execute "apt-get upgrade -y"
    execute "apt-get autoremove -y"
    execute "apt-get autoclean"
    log_success "Система обновлена"
}

# Установка базовых пакетов
install_base_packages() {
    log "Установка базовых пакетов..."
    
    local packages=(
        "curl"
        "wget" 
        "git"
        "unzip"
        "htop"
        "tree"
        "jq"
        "bc"
        "cron"
        "logrotate"
        "ca-certificates"
        "gnupg"
        "lsb-release"
    )
    
    execute "apt-get install -y ${packages[*]}"
    log_success "Базовые пакеты установлены"
}

# Установка Docker
install_docker() {
    log "Установка Docker..."
    
    if command -v docker &> /dev/null; then
        log_info "Docker уже установлен: $(docker --version)"
        return 0
    fi
    
    # Установка Docker из официального репозитория
    execute "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg"
    execute "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \$(lsb_release -cs) stable\" | tee /etc/apt/sources.list.d/docker.list > /dev/null"
    execute "apt-get update -y"
    execute "apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin"
    
    # Запуск и включение в автозагрузку
    execute "systemctl enable docker"
    execute "systemctl start docker"
    
    log_success "Docker установлен: $(docker --version)"
}

# Создание пользователя для деплоя
create_deploy_user() {
    log "Создание пользователя $DEPLOY_USER..."
    
    if id "$DEPLOY_USER" &>/dev/null; then
        log_info "Пользователь $DEPLOY_USER уже существует"
    else
        execute "useradd -m -s /bin/bash $DEPLOY_USER"
        log_success "Пользователь $DEPLOY_USER создан"
    fi
    
    # Добавление в группы docker и sudo
    execute "usermod -aG docker $DEPLOY_USER"
    execute "usermod -aG sudo $DEPLOY_USER"
    
    # Создание структуры каталогов
    execute "mkdir -p /opt/books/{app,uploads,backups,logs}"
    execute "chown -R $DEPLOY_USER:$DEPLOY_USER /opt/books"
    execute "chmod 755 /opt/books"
    execute "chmod 700 /opt/books/backups"
    
    log_success "Пользователь $DEPLOY_USER настроен"
}

# Настройка SSH ключей (интерактивно)
setup_ssh_keys() {
    log "Настройка SSH ключей для пользователя $DEPLOY_USER..."
    
    local user_home="/home/$DEPLOY_USER"
    execute "mkdir -p $user_home/.ssh"
    execute "chmod 700 $user_home/.ssh"
    
    if [[ "$DRY_RUN" == false ]]; then
        echo -e "${YELLOW}"
        echo "=========================================="
        echo "НАСТРОЙКА SSH КЛЮЧЕЙ"
        echo "=========================================="
        echo "Добавьте ваш публичный SSH ключ для пользователя $DEPLOY_USER:"
        echo "1. Скопируйте содержимое вашего ~/.ssh/id_rsa.pub"
        echo "2. Вставьте его ниже и нажмите Enter"
        echo "3. Для завершения введите пустую строку"
        echo -e "${NC}"
        
        > "$user_home/.ssh/authorized_keys"
        while IFS= read -r line; do
            [[ -z "$line" ]] && break
            echo "$line" >> "$user_home/.ssh/authorized_keys"
        done
        
        execute "chmod 600 $user_home/.ssh/authorized_keys"
        execute "chown -R $DEPLOY_USER:$DEPLOY_USER $user_home/.ssh"
        
        log_success "SSH ключи настроены для пользователя $DEPLOY_USER"
    else
        log_info "[DRY-RUN] Будет запрошен ввод SSH ключей"
    fi
}

# Настройка производственной среды
setup_production_environment() {
    log "Настройка производственной среды..."
    
    # Переменные окружения для Docker Compose
    cat > /opt/books/.env << EOF
# Production Environment Settings
DOMAIN=$DOMAIN
DEPLOY_USER=$DEPLOY_USER
COMPOSE_PROJECT_NAME=books-prod
COMPOSE_FILE=docker-compose.prod.yml
EOF
    
    execute "chown $DEPLOY_USER:$DEPLOY_USER /opt/books/.env"
    execute "chmod 600 /opt/books/.env"
    
    log_success "Производственная среда настроена"
}

# Настройка системных лимитов
setup_system_limits() {
    log "Настройка системных лимитов..."
    
    # Лимиты для пользователя deploy
    cat > /etc/security/limits.d/books-app.conf << EOF
# Books App Production Limits
$DEPLOY_USER soft nofile 65536
$DEPLOY_USER hard nofile 65536
$DEPLOY_USER soft nproc 32768
$DEPLOY_USER hard nproc 32768

# Docker containers
* soft nofile 65536
* hard nofile 65536
EOF
    
    # Системные настройки для производительности
    cat > /etc/sysctl.d/99-books-app.conf << EOF
# Books App Production System Settings

# Network
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 5000
net.core.rmem_default = 262144
net.core.rmem_max = 16777216
net.core.wmem_default = 262144
net.core.wmem_max = 16777216
net.ipv4.tcp_keepalive_time = 120
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3

# File system
fs.file-max = 1000000

# Virtual memory
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
EOF
    
    execute "sysctl -p /etc/sysctl.d/99-books-app.conf"
    
    log_success "Системные лимиты настроены"
}

# Настройка логирования
setup_logging() {
    log "Настройка логирования..."
    
    # Логротация для приложения
    cat > /etc/logrotate.d/books-app << EOF
/opt/books/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 $DEPLOY_USER $DEPLOY_USER
    su $DEPLOY_USER $DEPLOY_USER
    postrotate
        # Перезапуск контейнеров для переоткрытия лог файлов
        /usr/bin/docker compose -f /opt/books/app/docker-compose.prod.yml restart app 2>/dev/null || true
    endscript
}

/opt/books/backups/*.log {
    weekly
    missingok
    rotate 12
    compress
    delaycompress
    notifempty
    create 644 $DEPLOY_USER $DEPLOY_USER
    su $DEPLOY_USER $DEPLOY_USER
}
EOF
    
    # Настройка journald для контроля размера логов
    mkdir -p /etc/systemd/journald.conf.d
    cat > /etc/systemd/journald.conf.d/books-app.conf << EOF
[Journal]
SystemMaxUse=1G
SystemMaxFileSize=100M
RuntimeMaxUse=1G
RuntimeMaxFileSize=100M
EOF
    
    execute "systemctl restart systemd-journald"
    
    log_success "Логирование настроено"
}

# Проверка статуса всех служб
check_services_status() {
    log "Проверка статуса служб..."
    
    services=("docker" "cron" "ssh")
    
    for service in "${services[@]}"; do
        if systemctl is-active --quiet "$service"; then
            log_success "$service: активен"
        else
            log_error "$service: неактивен"
        fi
    done
    
    # Проверка Docker
    if [[ "$DRY_RUN" == false ]] && command -v docker &> /dev/null; then
        if docker ps &> /dev/null; then
            log_success "Docker: готов к использованию"
        else
            log_error "Docker: ошибка подключения"
        fi
    fi
}

# Создание информационного файла
create_info_file() {
    log "Создание информационного файла..."
    
    cat > /opt/books/SERVER_INFO.md << EOF
# Books App Production Server
============================

**Дата настройки:** $(date)
**Домен:** $DOMAIN
**Пользователь деплоя:** $DEPLOY_USER
**Версия ОС:** $(lsb_release -d | cut -f2)
**Версия Docker:** $(docker --version 2>/dev/null || echo "Не установлен")

## Структура каталогов

\`\`\`
/opt/books/
├── app/                    # Код приложения и конфигурация
│   ├── .env.prod          # Переменные окружения (chmod 600)
│   └── docker-compose.prod.yml
├── uploads/               # Медиафайлы пользователей
├── backups/              # Бэкапы базы данных (chmod 700)
└── logs/                 # Логи приложения
\`\`\`

## Следующие шаги

1. **Скопировать код приложения:**
   \`\`\`bash
   su $DEPLOY_USER
   cd /opt/books/app
   git clone <repository-url> .
   \`\`\`

2. **Настроить переменные окружения:**
   \`\`\`bash
   cp .env.example .env.prod
   vim .env.prod  # Обновить для продакшена
   chmod 600 .env.prod
   \`\`\`

3. **Запустить приложение:**
   \`\`\`bash
   docker compose -f docker-compose.prod.yml up -d
   \`\`\`

## Полезные команды

\`\`\`bash
# Статус контейнеров
docker compose -f docker-compose.prod.yml ps

# Логи приложения
docker compose -f docker-compose.prod.yml logs -f app

# Вход в контейнер
docker compose -f docker-compose.prod.yml exec app sh

# Бэкап базы данных
./scripts/backup_database.sh daily

# Проверка безопасности
./scripts/test_security.sh
\`\`\`

## Мониторинг

- **Логи системы:** \`journalctl -u docker -f\`
- **Процессы:** \`htop\`
- **Диск:** \`df -h\`
- **Сеть:** \`netstat -tuln\`

EOF
    
    execute "chown $DEPLOY_USER:$DEPLOY_USER /opt/books/SERVER_INFO.md"
    
    log_success "Информационный файл создан: /opt/books/SERVER_INFO.md"
}

# Основная функция
main() {
    echo -e "${PURPLE}"
    echo "========================================"
    echo "🚀 Books App Production Server Setup"
    echo "========================================"
    echo -e "${NC}"
    echo "Домен: $DOMAIN"
    echo "Пользователь: $DEPLOY_USER"
    echo "Режим: $([ "$DRY_RUN" == true ] && echo "DRY RUN" || echo "ВЫПОЛНЕНИЕ")"
    echo ""
    
    if [[ "$DRY_RUN" == false ]]; then
        read -p "Продолжить настройку? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Настройка отменена пользователем"
            exit 0
        fi
    fi
    
    # Проверки
    check_root
    check_os
    
    # Основные шаги настройки
    update_system
    install_base_packages
    install_docker
    create_deploy_user
    setup_ssh_keys
    setup_production_environment
    setup_system_limits
    setup_logging
    
    # Дополнительные компоненты
    if [[ "$SKIP_SECURITY" == false ]]; then
        log "Запуск настройки безопасности..."
        if [[ -f "./scripts/setup_security.sh" ]]; then
            execute "./scripts/setup_security.sh --production"
        else
            log_warning "Скрипт setup_security.sh не найден, пропускаем"
        fi
    fi
    
    if [[ "$SKIP_CADDY" == false ]]; then
        log "Установка Caddy reverse proxy..."
        if [[ -f "./scripts/install_caddy.sh" ]]; then
            execute "./scripts/install_caddy.sh --domain $DOMAIN"
        else
            log_warning "Скрипт install_caddy.sh не найден, пропускаем"
        fi
    fi
    
    if [[ "$SKIP_MONITORING" == false ]]; then
        log "Настройка мониторинга..."
        if [[ -f "./scripts/setup_monitoring.sh" ]]; then
            execute "./scripts/setup_monitoring.sh --production"
        else
            log_warning "Скрипт setup_monitoring.sh не найден, пропускаем"
        fi
    fi
    
    # Финальные проверки
    check_services_status
    create_info_file
    
    echo ""
    echo -e "${GREEN}"
    echo "========================================"
    echo "✅ Сервер настроен успешно!"
    echo "========================================"
    echo -e "${NC}"
    echo "Домен: $DOMAIN"
    echo "Пользователь: $DEPLOY_USER"
    echo "Каталог: /opt/books"
    echo ""
    echo "Следующие шаги:"
    echo "1. Переключитесь на пользователя: su $DEPLOY_USER"
    echo "2. Перейдите в каталог: cd /opt/books/app"
    echo "3. Склонируйте репозиторий приложения"
    echo "4. Настройте .env.prod файл"
    echo "5. Запустите: docker compose -f docker-compose.prod.yml up -d"
    echo ""
    echo "Документация: /opt/books/SERVER_INFO.md"
}

# Обработка ошибок
trap 'log_error "Ошибка в строке $LINENO. Код выхода: $?"' ERR

# Запуск
main "$@"
