#!/bin/bash
set -euo pipefail

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Счетчики
CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_WARNING=0

# Функции логирования
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((CHECKS_PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((CHECKS_FAILED++))
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    ((CHECKS_WARNING++))
}

# Проверка SSH конфигурации
check_ssh_security() {
    log_info "Проверка настроек SSH..."
    
    # Проверка отключения root логина
    if grep -q "^PermitRootLogin no" /etc/ssh/sshd_config; then
        log_pass "Root логин отключен"
    else
        log_fail "Root логин не отключен"
    fi
    
    # Проверка отключения парольной аутентификации
    if grep -q "^PasswordAuthentication no" /etc/ssh/sshd_config; then
        log_pass "Парольная аутентификация отключена"
    else
        log_fail "Парольная аутентификация включена"
    fi
    
    # Проверка включения ключевой аутентификации
    if grep -q "^PubkeyAuthentication yes" /etc/ssh/sshd_config; then
        log_pass "Ключевая аутентификация включена"
    else
        log_fail "Ключевая аутентификация отключена"
    fi
    
    # Проверка дополнительных настроек
    if grep -q "MaxAuthTries 3" /etc/ssh/sshd_config; then
        log_pass "Максимальное количество попыток аутентификации ограничено"
    else
        log_warning "Максимальное количество попыток аутентификации не ограничено"
    fi
}

# Проверка UFW
check_ufw() {
    log_info "Проверка UFW firewall..."
    
    if command -v ufw &> /dev/null; then
        if ufw status | grep -q "Status: active"; then
            log_pass "UFW активен"
            
            # Проверка разрешенных портов
            if ufw status | grep -q "22/tcp"; then
                log_pass "SSH (порт 22) разрешен"
            else
                log_fail "SSH (порт 22) не разрешен"
            fi
            
            if ufw status | grep -q "80/tcp"; then
                log_pass "HTTP (порт 80) разрешен"
            else
                log_warning "HTTP (порт 80) не разрешен"
            fi
            
            if ufw status | grep -q "443/tcp"; then
                log_pass "HTTPS (порт 443) разрешен"
            else
                log_warning "HTTPS (порт 443) не разрешен"
            fi
        else
            log_fail "UFW не активен"
        fi
    else
        log_fail "UFW не установлен"
    fi
}

# Проверка fail2ban
check_fail2ban() {
    log_info "Проверка fail2ban..."
    
    if command -v fail2ban-client &> /dev/null; then
        if systemctl is-active fail2ban &> /dev/null; then
            log_pass "fail2ban активен"
            
            # Проверка jail для SSH
            if fail2ban-client status | grep -q "sshd"; then
                log_pass "SSH jail настроен"
            else
                log_warning "SSH jail не найден"
            fi
        else
            log_fail "fail2ban не запущен"
        fi
    else
        log_fail "fail2ban не установлен"
    fi
}

# Проверка автоматических обновлений
check_unattended_upgrades() {
    log_info "Проверка автоматических обновлений..."
    
    if command -v unattended-upgrades &> /dev/null; then
        log_pass "unattended-upgrades установлен"
        
        if systemctl is-active unattended-upgrades &> /dev/null; then
            log_pass "unattended-upgrades активен"
        else
            log_warning "unattended-upgrades не запущен"
        fi
        
        if [[ -f "/etc/apt/apt.conf.d/50unattended-upgrades" ]]; then
            log_pass "Конфигурация unattended-upgrades найдена"
        else
            log_fail "Конфигурация unattended-upgrades не найдена"
        fi
    else
        log_fail "unattended-upgrades не установлен"
    fi
}

# Проверка пользователя deploy
check_deploy_user() {
    log_info "Проверка пользователя deploy..."
    
    if id "deploy" &>/dev/null; then
        log_pass "Пользователь deploy существует"
        
        # Проверка домашней директории
        if [[ -d "/home/deploy" ]]; then
            log_pass "Домашняя директория пользователя deploy существует"
        else
            log_fail "Домашняя директория пользователя deploy не найдена"
        fi
        
        # Проверка SSH директории
        if [[ -d "/home/deploy/.ssh" ]]; then
            log_pass "SSH директория для пользователя deploy существует"
            
            # Проверка authorized_keys
            if [[ -f "/home/deploy/.ssh/authorized_keys" ]]; then
                if [[ -s "/home/deploy/.ssh/authorized_keys" ]]; then
                    log_pass "SSH ключи для пользователя deploy настроены"
                else
                    log_warning "Файл authorized_keys пуст - добавьте SSH ключи"
                fi
            else
                log_warning "Файл authorized_keys не найден"
            fi
        else
            log_fail "SSH директория для пользователя deploy не найдена"
        fi
        
        # Проверка прав sudo
        if groups deploy | grep -q sudo; then
            log_pass "Пользователь deploy имеет права sudo"
        else
            log_fail "Пользователь deploy не имеет прав sudo"
        fi
    else
        log_fail "Пользователь deploy не существует"
    fi
}

# Проверка директорий проекта
check_project_directories() {
    log_info "Проверка директорий проекта..."
    
    if [[ -d "/opt/books" ]]; then
        log_pass "Базовая директория /opt/books существует"
        
        for dir in app uploads backups logs; do
            if [[ -d "/opt/books/$dir" ]]; then
                log_pass "Директория /opt/books/$dir существует"
            else
                log_fail "Директория /opt/books/$dir не найдена"
            fi
        done
        
        # Проверка владельца
        if [[ "$(stat -c %U /opt/books)" == "deploy" ]]; then
            log_pass "Владелец /opt/books - пользователь deploy"
        else
            log_warning "Владелец /opt/books не пользователь deploy"
        fi
    else
        log_fail "Базовая директория /opt/books не найдена"
    fi
}

# Проверка системных настроек
check_system_settings() {
    log_info "Проверка системных настроек..."
    
    # Проверка sysctl настроек
    if sysctl net.ipv4.tcp_syncookies | grep -q "= 1"; then
        log_pass "SYN cookies включены"
    else
        log_warning "SYN cookies не включены"
    fi
    
    if sysctl net.ipv4.conf.all.accept_redirects | grep -q "= 0"; then
        log_pass "ICMP redirects отключены"
    else
        log_warning "ICMP redirects включены"
    fi
    
    # Проверка лимитов
    if grep -q "deploy.*nofile.*65536" /etc/security/limits.conf; then
        log_pass "Лимиты файловых дескрипторов для deploy настроены"
    else
        log_warning "Лимиты файловых дескрипторов для deploy не настроены"
    fi
}

# Проверка сетевых портов
check_network_ports() {
    log_info "Проверка открытых портов..."
    
    # Получаем список открытых портов
    OPEN_PORTS=$(netstat -tuln | grep LISTEN | awk '{print $4}' | cut -d: -f2 | sort -nu)
    
    log_info "Открытые порты: $(echo $OPEN_PORTS | tr '\n' ' ')"
    
    # Проверка критически важных портов
    if echo "$OPEN_PORTS" | grep -q "^22$"; then
        log_pass "SSH порт (22) открыт"
    else
        log_fail "SSH порт (22) не открыт"
    fi
    
    # Предупреждения о потенциально небезопасных портах
    for port in 3306 5432 6379 27017; do
        if echo "$OPEN_PORTS" | grep -q "^$port$"; then
            log_warning "Обнаружен открытый порт базы данных ($port) - убедитесь в безопасности"
        fi
    done
}

# Проверка обновлений системы
check_system_updates() {
    log_info "Проверка состояния обновлений..."
    
    # Обновляем списки пакетов
    apt update -qq 2>/dev/null || true
    
    # Проверяем доступные обновления
    UPDATES=$(apt list --upgradable 2>/dev/null | grep -c upgradable || echo "0")
    SECURITY_UPDATES=$(apt list --upgradable 2>/dev/null | grep -c security || echo "0")
    
    if [[ "$UPDATES" -eq 0 ]]; then
        log_pass "Система обновлена"
    else
        if [[ "$SECURITY_UPDATES" -gt 0 ]]; then
            log_fail "Доступно $SECURITY_UPDATES критических обновлений безопасности"
        else
            log_warning "Доступно $UPDATES обновлений"
        fi
    fi
}

# Проверка логов безопасности
check_security_logs() {
    log_info "Проверка последних событий безопасности..."
    
    # Проверка последних неудачных SSH подключений
    SSH_FAILURES=$(grep "Failed password" /var/log/auth.log 2>/dev/null | tail -5 | wc -l || echo "0")
    if [[ "$SSH_FAILURES" -gt 0 ]]; then
        log_warning "Обнаружено $SSH_FAILURES неудачных SSH подключений в последних записях"
    else
        log_pass "Неудачные SSH подключения не обнаружены"
    fi
    
    # Проверка fail2ban банов
    if command -v fail2ban-client &> /dev/null; then
        BANNED_IPS=$(fail2ban-client status sshd 2>/dev/null | grep "Banned IP list" | wc -w || echo "0")
        if [[ "$BANNED_IPS" -gt 2 ]]; then # 2 слова в "Banned IP"
            log_warning "fail2ban заблокировал несколько IP адресов"
        else
            log_pass "Нет заблокированных IP адресов"
        fi
    fi
}

# Основная функция проверки
main() {
    echo "=== Проверка безопасности продакшн сервера ==="
    echo "Дата проверки: $(date)"
    echo "Хост: $(hostname)"
    echo "ОС: $(lsb_release -d 2>/dev/null | cut -f2 || echo 'Unknown')"
    echo

    # Выполнение всех проверок
    check_ssh_security
    echo
    check_ufw
    echo
    check_fail2ban
    echo
    check_unattended_upgrades
    echo
    check_deploy_user
    echo
    check_project_directories
    echo
    check_system_settings
    echo
    check_network_ports
    echo
    check_system_updates
    echo
    check_security_logs
    
    echo
    echo "=== Результаты проверки ==="
    echo -e "${GREEN}Пройдено: $CHECKS_PASSED${NC}"
    echo -e "${YELLOW}Предупреждений: $CHECKS_WARNING${NC}"
    echo -e "${RED}Ошибок: $CHECKS_FAILED${NC}"
    
    if [[ $CHECKS_FAILED -eq 0 ]]; then
        echo -e "\n${GREEN}✓ Общая оценка: Безопасность настроена корректно${NC}"
        if [[ $CHECKS_WARNING -gt 0 ]]; then
            echo -e "${YELLOW}! Рекомендуется устранить предупреждения${NC}"
        fi
        exit 0
    else
        echo -e "\n${RED}✗ Общая оценка: Обнаружены критические проблемы безопасности${NC}"
        echo -e "${RED}Необходимо устранить ошибки перед развертыванием в продакшене${NC}"
        exit 1
    fi
}

# Проверка аргументов
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Использование: $0"
    echo
    echo "Этот скрипт проверяет настройки безопасности продакшн сервера:"
    echo "- SSH конфигурация"
    echo "- UFW firewall"
    echo "- fail2ban"
    echo "- Автоматические обновления"
    echo "- Пользователь deploy"
    echo "- Директории проекта"
    echo "- Системные настройки"
    echo "- Открытые порты"
    echo "- Состояние обновлений"
    echo "- Логи безопасности"
    echo
    echo "Коды возврата:"
    echo "  0 - Все проверки пройдены успешно"
    echo "  1 - Обнаружены критические проблемы"
    exit 0
fi

# Запуск основной функции
main "$@"
