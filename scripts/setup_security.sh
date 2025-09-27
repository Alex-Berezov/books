#!/bin/bash
set -euo pipefail

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функции логирования
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Проверка прав суперпользователя
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "Этот скрипт должен запускаться от имени root"
        log_info "Запустите: sudo $0"
        exit 1
    fi
}

# Обновление системы
update_system() {
    log_info "Обновление системы..."
    apt update -y
    apt upgrade -y
    apt autoremove -y
    log_success "Система обновлена"
}

# Настройка SSH
setup_ssh() {
    log_info "Настройка SSH безопасности..."
    
    # Бэкап оригинального конфига
    cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup.$(date +%Y%m%d_%H%M%S)
    
    # Настройки SSH
    sed -i 's/#PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
    sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config
    sed -i 's/#AuthorizedKeysFile/AuthorizedKeysFile/' /etc/ssh/sshd_config
    
    # Добавляем дополнительные настройки безопасности
    grep -q "Protocol 2" /etc/ssh/sshd_config || echo "Protocol 2" >> /etc/ssh/sshd_config
    grep -q "X11Forwarding no" /etc/ssh/sshd_config || echo "X11Forwarding no" >> /etc/ssh/sshd_config
    grep -q "MaxAuthTries 3" /etc/ssh/sshd_config || echo "MaxAuthTries 3" >> /etc/ssh/sshd_config
    grep -q "ClientAliveInterval 300" /etc/ssh/sshd_config || echo "ClientAliveInterval 300" >> /etc/ssh/sshd_config
    grep -q "ClientAliveCountMax 2" /etc/ssh/sshd_config || echo "ClientAliveCountMax 2" >> /etc/ssh/sshd_config
    
    # Перезапуск SSH
    systemctl reload sshd
    log_success "SSH настроен (отключены пароли, только ключи)"
}

# Настройка UFW (Uncomplicated Firewall)
setup_ufw() {
    log_info "Настройка UFW firewall..."
    
    # Установка UFW если не установлен
    if ! command -v ufw &> /dev/null; then
        apt install -y ufw
    fi
    
    # Сброс правил
    ufw --force reset
    
    # Базовые политики
    ufw default deny incoming
    ufw default allow outgoing
    
    # Разрешенные порты
    ufw allow 22/tcp    # SSH
    ufw allow 80/tcp    # HTTP
    ufw allow 443/tcp   # HTTPS
    
    # Включение UFW
    ufw --force enable
    
    log_success "UFW настроен (разрешены порты: 22, 80, 443)"
}

# Установка и настройка fail2ban
setup_fail2ban() {
    log_info "Установка и настройка fail2ban..."
    
    # Установка fail2ban
    apt install -y fail2ban
    
    # Создание локального конфига
    cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
# Банить на 1 час после 5 неудачных попыток за 10 минут
bantime = 3600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
logpath = /var/log/nginx/error.log

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
logpath = /var/log/nginx/error.log
maxretry = 10

[nginx-botsearch]
enabled = true
filter = nginx-botsearch
logpath = /var/log/nginx/access.log
EOF
    
    # Запуск и включение fail2ban
    systemctl enable fail2ban
    systemctl restart fail2ban
    
    log_success "fail2ban установлен и настроен"
}

# Настройка автоматических обновлений безопасности
setup_unattended_upgrades() {
    log_info "Настройка автоматических обновлений безопасности..."
    
    # Установка пакета
    apt install -y unattended-upgrades apt-listchanges
    
    # Создание конфигурации
    cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

Unattended-Upgrade::Package-Blacklist {
};

Unattended-Upgrade::DevRelease "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "02:00";
EOF
    
    # Включение автоматических обновлений
    echo 'APT::Periodic::Update-Package-Lists "1";' > /etc/apt/apt.conf.d/20auto-upgrades
    echo 'APT::Periodic::Unattended-Upgrade "1";' >> /etc/apt/apt.conf.d/20auto-upgrades
    echo 'APT::Periodic::AutocleanInterval "7";' >> /etc/apt/apt.conf.d/20auto-upgrades
    
    # Запуск сервиса
    systemctl enable unattended-upgrades
    systemctl restart unattended-upgrades
    
    log_success "Автоматические обновления безопасности настроены"
}

# Создание пользователя deploy
create_deploy_user() {
    log_info "Создание пользователя deploy..."
    
    if id "deploy" &>/dev/null; then
        log_warning "Пользователь deploy уже существует"
    else
        # Создание пользователя
        useradd -m -s /bin/bash deploy
        usermod -aG sudo deploy
        
        # Создание директории для SSH ключей
        mkdir -p /home/deploy/.ssh
        chmod 700 /home/deploy/.ssh
        touch /home/deploy/.ssh/authorized_keys
        chmod 600 /home/deploy/.ssh/authorized_keys
        chown -R deploy:deploy /home/deploy/.ssh
        
        log_success "Пользователь deploy создан"
        log_warning "Не забудьте добавить SSH ключ в /home/deploy/.ssh/authorized_keys"
    fi
}

# Настройка директорий для проекта
setup_project_directories() {
    log_info "Создание директорий для проекта..."
    
    # Создание базовых директорий
    mkdir -p /opt/books/{app,uploads,backups,logs}
    
    # Установка владельца
    chown -R deploy:deploy /opt/books
    chmod 755 /opt/books
    chmod 775 /opt/books/{uploads,backups,logs}
    
    log_success "Директории проекта созданы в /opt/books"
}

# Установка базовых пакетов безопасности
install_security_packages() {
    log_info "Установка базовых пакетов безопасности..."
    
    apt install -y \
        curl \
        wget \
        git \
        htop \
        iotop \
        net-tools \
        lsof \
        tcpdump \
        nmap \
        logrotate \
        rsync \
        cron \
        acl
    
    log_success "Базовые пакеты установлены"
}

# Настройка системных лимитов
setup_system_limits() {
    log_info "Настройка системных лимитов..."
    
    # Настройка limits.conf для пользователя deploy
    cat >> /etc/security/limits.conf << 'EOF'
# Лимиты для пользователя deploy
deploy soft nofile 65536
deploy hard nofile 65536
deploy soft nproc 32768
deploy hard nproc 32768
EOF
    
    # Настройка sysctl
    cat >> /etc/sysctl.conf << 'EOF'
# Настройки безопасности сети
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1

# Защита от SYN flood атак
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_syn_retries = 5

# Настройки памяти для production
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
EOF
    
    # Применение настроек sysctl
    sysctl -p
    
    log_success "Системные лимиты настроены"
}

# Основная функция
main() {
    log_info "=== Настройка безопасности продакшн сервера ==="
    log_info "Начинаем установку компонентов безопасности..."
    
    check_root
    
    # Выполнение всех настроек
    update_system
    install_security_packages
    create_deploy_user
    setup_ssh
    setup_ufw
    setup_fail2ban
    setup_unattended_upgrades
    setup_project_directories
    setup_system_limits
    
    log_success "=== Настройка безопасности завершена! ==="
    echo
    log_info "Следующие шаги:"
    echo "1. Добавьте ваш SSH ключ в /home/deploy/.ssh/authorized_keys"
    echo "2. Перелогиньтесь и проверьте доступ под пользователем deploy"
    echo "3. Запустите ./test_security.sh для проверки настроек"
    echo "4. Настройте Docker и развертывание приложения"
    echo
    log_warning "ВНИМАНИЕ: Убедитесь, что у вас есть доступ по SSH ключу перед отключением от сервера!"
}

# Проверка аргументов
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Использование: $0"
    echo
    echo "Этот скрипт настраивает базовую безопасность для продакшн сервера:"
    echo "- Отключение SSH паролей, только ключи"
    echo "- Настройка UFW firewall (порты 22, 80, 443)"
    echo "- Установка и настройка fail2ban"
    echo "- Автоматические обновления безопасности"
    echo "- Создание пользователя deploy"
    echo "- Системные настройки безопасности"
    echo
    echo "Запуск: sudo $0"
    exit 0
fi

# Запуск основной функции
main "$@"
