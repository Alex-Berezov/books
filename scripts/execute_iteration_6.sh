#!/bin/bash

# Главный скрипт для выполнения Итерации 6: Настройка доступа к домену bibliaris.com
# 
# Этот скрипт координирует все этапы настройки:
# 1. Подготовка файлов для сервера
# 2. Инструкции по DNS
# 3. Установка и настройка Caddy на сервере
# 4. Проверка результатов

set -euo pipefail

# Конфигурация
DOMAIN="bibliaris.com"
SERVER_IP="209.74.88.183"
SERVER_USER="deploy"

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функции логирования
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Проверка зависимостей
check_dependencies() {
    log_info "Проверка зависимостей..."
    
    local missing=()
    
    for cmd in ssh scp dig curl; do
        if ! command -v $cmd &> /dev/null; then
            missing+=($cmd)
        fi
    done
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Не найдены необходимые утилиты: ${missing[*]}"
        log_info "Установите их: sudo apt install openssh-client dnsutils curl"
        exit 1
    fi
    
    log_success "Все зависимости найдены"
}

# Проверка SSH доступа к серверу
check_ssh_access() {
    log_info "Проверка SSH доступа к серверу $SERVER_IP..."
    
    if ssh -o ConnectTimeout=10 -o BatchMode=yes $SERVER_USER@$SERVER_IP "echo 'SSH OK'" >/dev/null 2>&1; then
        log_success "SSH доступ к серверу работает"
    else
        log_error "Нет SSH доступа к серверу $SERVER_IP"
        log_info "Убедитесь что:"
        log_info "  - SSH ключ добавлен на сервер"
        log_info "  - Пользователь $SERVER_USER существует"
        log_info "  - Сервер доступен по сети"
        exit 1
    fi
}

# Копирование скрипта на сервер
copy_setup_script() {
    log_info "Копирование скрипта установки на сервер..."
    
    if scp ./setup_bibliaris_caddy.sh $SERVER_USER@$SERVER_IP:/tmp/; then
        log_success "Скрипт скопирован на сервер"
    else
        log_error "Ошибка копирования скрипта на сервер"
        exit 1
    fi
}

# Показать инструкции по DNS
show_dns_instructions() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${YELLOW}📋 ИНСТРУКЦИИ ПО НАСТРОЙКЕ DNS${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "${BLUE}🌐 Домен:${NC} $DOMAIN"
    echo -e "${BLUE}🖥️ Сервер:${NC} $SERVER_IP"
    echo ""
    echo -e "${YELLOW}📝 Выполните следующие шаги в Namecheap:${NC}"
    echo ""
    echo "1. Войдите в панель Namecheap"
    echo "2. Перейдите в Domain List → $DOMAIN → Manage"
    echo "3. ⚠️  КРИТИЧНО: Удалите URL Forward в разделе 'Redirects'"
    echo "4. Перейдите в 'Advanced DNS'"
    echo "5. Добавьте A-record:"
    echo "   Type: A Record"
    echo "   Host: @"
    echo "   Value: $SERVER_IP"
    echo "   TTL: Automatic"
    echo "6. Сохраните изменения"
    echo ""
    echo -e "${YELLOW}⏱️  DNS изменения могут занять до 48 часов${NC}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# Установка Caddy на сервере
install_caddy_on_server() {
    log_info "Установка и настройка Caddy на сервере..."
    
    echo ""
    log_warning "Сейчас будет запущена установка Caddy на сервере $SERVER_IP"
    log_warning "Потребуются права sudo на сервере"
    echo ""
    
    # Запуск скрипта установки на сервере
    if ssh -t $SERVER_USER@$SERVER_IP "sudo bash /tmp/setup_bibliaris_caddy.sh"; then
        log_success "Caddy успешно установлен и настроен!"
    else
        log_error "Ошибка при установке Caddy"
        return 1
    fi
}

# Проверка текущего состояния DNS
check_current_dns() {
    log_info "Проверка текущего состояния DNS..."
    
    dns_result=$(dig +short $DOMAIN A 2>/dev/null || echo "")
    
    if [[ "$dns_result" == "$SERVER_IP" ]]; then
        log_success "DNS уже настроен правильно: $DOMAIN → $SERVER_IP"
        return 0
    elif [[ -n "$dns_result" ]]; then
        log_warning "DNS указывает на другой IP: $DOMAIN → $dns_result"
        log_warning "Ожидается: $SERVER_IP"
        return 1
    else
        log_warning "DNS записи не найдены для $DOMAIN"
        return 1
    fi
}

# Ожидание DNS propagation
wait_for_dns() {
    local max_attempts=20
    local attempt=1
    
    log_info "Ожидание DNS propagation..."
    
    while [[ $attempt -le $max_attempts ]]; do
        log_info "Попытка $attempt/$max_attempts..."
        
        if check_current_dns >/dev/null 2>&1; then
            log_success "DNS propagation завершен!"
            return 0
        fi
        
        if [[ $attempt -lt $max_attempts ]]; then
            log_info "DNS еще не обновлен, ждем 30 секунд..."
            sleep 30
        fi
        
        ((attempt++))
    done
    
    log_warning "DNS propagation займет больше времени"
    log_info "Проверьте позже командой: ./scripts/check_bibliaris.sh"
    return 1
}

# Финальная проверка
final_check() {
    log_info "Запуск финальной проверки..."
    
    if ./check_bibliaris.sh; then
        log_success "Все проверки пройдены! 🎉"
        echo ""
        echo "✅ bibliaris.com полностью настроен и работает"
        echo "🔗 API доступен: https://bibliaris.com/"
    else
        log_warning "Некоторые проверки не прошли"
        log_info "Возможные причины:"
        log_info "  - DNS еще не обновился полностью"
        log_info "  - Нужно время на получение SSL сертификата"
        log_info "Повторите проверку через 10-15 минут: ./scripts/check_bibliaris.sh"
    fi
}

# Очистка временных файлов
cleanup() {
    log_info "Очистка временных файлов..."
    
    # Удаление скрипта с сервера
    ssh $SERVER_USER@$SERVER_IP "rm -f /tmp/setup_bibliaris_caddy.sh" 2>/dev/null || true
    
    log_success "Очистка завершена"
}

# Главное меню
show_menu() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}🌐 Итерация 6: Настройка доступа к домену bibliaris.com${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Выберите действие:"
    echo ""
    echo "1) 📋 Показать инструкции по настройке DNS"
    echo "2) 🚀 Установить Caddy на сервере (требует SSH доступ)"
    echo "3) 🔍 Проверить текущее состояние DNS"
    echo "4) 🧪 Выполнить полную проверку доступности"
    echo "5) ⚡ Выполнить все шаги автоматически"
    echo "6) 🧹 Очистить временные файлы"
    echo "0) 🚪 Выход"
    echo ""
    read -p "Введите номер действия: " choice
    
    case $choice in
        1) show_dns_instructions; show_menu ;;
        2) copy_setup_script && install_caddy_on_server; show_menu ;;
        3) check_current_dns; show_menu ;;
        4) final_check; show_menu ;;
        5) run_full_setup ;;
        6) cleanup; show_menu ;;
        0) log_info "Выход"; exit 0 ;;
        *) log_error "Неверный выбор"; show_menu ;;
    esac
}

# Полная автоматическая настройка
run_full_setup() {
    log_info "Запуск полной автоматической настройки..."
    echo ""
    
    # Этап 1: Подготовка
    check_dependencies
    check_ssh_access
    
    # Этап 2: Инструкции по DNS
    show_dns_instructions
    echo ""
    read -p "Выполнили настройку DNS в Namecheap? (y/N): " dns_done
    
    if [[ ! "$dns_done" =~ ^[Yy]$ ]]; then
        log_warning "Сначала настройте DNS, затем запустите скрипт заново"
        exit 1
    fi
    
    # Этап 3: Установка Caddy
    copy_setup_script
    install_caddy_on_server
    
    # Этап 4: Проверка DNS
    if check_current_dns; then
        log_success "DNS уже готов!"
    else
        log_info "Ожидание DNS propagation..."
        wait_for_dns
    fi
    
    # Этап 5: Финальная проверка
    sleep 10  # Дать время на инициализацию SSL
    final_check
    
    # Этап 6: Очистка
    cleanup
    
    echo ""
    log_success "Итерация 6 завершена! 🎉"
}

# Проверка аргументов командной строки
if [[ $# -gt 0 ]]; then
    case $1 in
        --auto) run_full_setup ;;
        --dns) show_dns_instructions ;;
        --check) final_check ;;
        --help) 
            echo "Использование: $0 [OPTION]"
            echo "  --auto    Автоматическое выполнение всех этапов"
            echo "  --dns     Показать инструкции по DNS"
            echo "  --check   Проверить доступность сайта"
            echo "  --help    Показать эту справку"
            ;;
        *) log_error "Неизвестный параметр: $1"; exit 1 ;;
    esac
else
    show_menu
fi
