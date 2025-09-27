# Security Guide - Руководство по безопасности продакшн сервера

> Это руководство описывает все аспекты безопасности для продакшн развертывания Books App backend.

## Обзор

Безопасность продакшн сервера состоит из нескольких уровней защиты:

1. **Сетевая безопасность** - Firewall (UFW) и сетевая изоляция
2. **Доступ к серверу** - SSH с ключами, отключение паролей
3. **Защита от атак** - fail2ban, rate limiting
4. **Системная безопасность** - автоматические обновления, лимиты
5. **Безопасность приложения** - CORS, HTTPS, ограничения доступа

## Быстрый старт

### Автоматическая установка

Для быстрой настройки безопасности используйте готовый скрипт:

```bash
# На сервере под root
sudo ./scripts/setup_security.sh

# После установки проверьте настройки
./scripts/test_security.sh
```

### Проверка статуса

```bash
# Проверка всех компонентов безопасности
./scripts/test_security.sh

# Статус firewall
sudo ufw status verbose

# Статус fail2ban
sudo fail2ban-client status

# SSH попытки подключения
sudo grep "Failed password" /var/log/auth.log | tail -10
```

## 1. SSH Security

### Основные настройки

SSH настроен максимально безопасно:

- ✅ Root логин отключен (`PermitRootLogin no`)
- ✅ Парольная аутентификация отключена (`PasswordAuthentication no`)
- ✅ Только ключевая аутентификация (`PubkeyAuthentication yes`)
- ✅ Максимум 3 попытки входа (`MaxAuthTries 3`)
- ✅ Автоматическое отключение неактивных соединений

### Настройка SSH ключей

```bash
# На вашей локальной машине создайте SSH ключ (если нет)
ssh-keygen -t ed25519 -C "your-email@example.com"

# Скопируйте публичный ключ на сервер
ssh-copy-id -i ~/.ssh/id_ed25519.pub deploy@your-server.com

# Или вручную добавьте ключ
cat ~/.ssh/id_ed25519.pub >> /home/deploy/.ssh/authorized_keys
```

### Дополнительная защита SSH

SSH порт защищен несколькими механизмами:

- **UFW rate limiting** - максимум 6 попыток за 30 секунд
- **fail2ban** - блокировка IP после 3 неудачных попыток на 1 час
- **Системные лимиты** - ограничение ресурсов для SSH процессов

### Проверка SSH безопасности

```bash
# Проверка конфигурации SSH
sudo sshd -t

# Просмотр активных SSH соединений
who

# Анализ SSH логов
sudo journalctl -u ssh -f

# Проверка заблокированных IP
sudo fail2ban-client status sshd
```

## 2. Firewall (UFW)

### Политика безопасности

Firewall настроен по принципу "запретить все, разрешить необходимое":

**Разрешенные порты:**

- `22/tcp` - SSH (с ограничением скорости)
- `80/tcp` - HTTP (для Caddy)
- `443/tcp` - HTTPS (для Caddy)

**Заблокированные порты:**

- `5000/tcp` - Прямой доступ к приложению
- `5432/tcp` - PostgreSQL
- `6379/tcp` - Redis
- `3000/tcp` - Grafana
- `9090/tcp` - Prometheus
- `9093/tcp` - AlertManager

### Управление firewall

```bash
# Статус firewall
sudo ufw status verbose

# Просмотр правил с номерами
sudo ufw status numbered

# Добавить временное правило (например, для отладки)
sudo ufw allow from YOUR_IP to any port 3000

# Удалить правило по номеру
sudo ufw delete [номер]

# Сбросить все правила (ОСТОРОЖНО!)
sudo ufw --force reset
```

### Мониторинг firewall

```bash
# Просмотр логов UFW
sudo tail -f /var/log/ufw.log

# Статистика заблокированных подключений
sudo grep BLOCK /var/log/ufw.log | tail -20

# Топ заблокированных IP
sudo grep BLOCK /var/log/ufw.log | awk '{print $13}' | sort | uniq -c | sort -nr | head -10
```

## 3. fail2ban

### Настроенные jail'ы

- **sshd** - защита SSH от брутфорса
- **nginx-http-auth** - защита от атак на HTTP аутентификацию
- **nginx-limit-req** - защита от превышения лимитов запросов
- **nginx-botsearch** - защита от ботов

### Параметры блокировки

- **Время бана**: 1 час (3600 сек)
- **Окно наблюдения**: 10 минут (600 сек)
- **Максимальные попытки**: 5 (SSH: 3)

### Управление fail2ban

```bash
# Общий статус
sudo fail2ban-client status

# Статус конкретного jail
sudo fail2ban-client status sshd

# Разблокировать IP
sudo fail2ban-client set sshd unbanip IP_ADDRESS

# Заблокировать IP вручную
sudo fail2ban-client set sshd banip IP_ADDRESS

# Перезагрузить конфигурацию
sudo fail2ban-client reload
```

### Мониторинг fail2ban

```bash
# Логи fail2ban
sudo journalctl -u fail2ban -f

# Активные баны
sudo fail2ban-client banned

# История банов
sudo grep "Ban " /var/log/fail2ban.log | tail -10
```

## 4. Автоматические обновления

### Настройки unattended-upgrades

Система автоматически устанавливает:

- ✅ Обновления безопасности Ubuntu
- ✅ Критические обновления ESM (Extended Security Maintenance)
- ✅ Удаление неиспользуемых пакетов и ядер
- ❌ Автоматическая перезагрузка отключена

### Мониторинг обновлений

```bash
# Статус службы
sudo systemctl status unattended-upgrades

# Логи обновлений
sudo journalctl -u unattended-upgrades -f

# Проверка доступных обновлений
sudo apt list --upgradable

# Проверка обновлений безопасности
sudo unattended-upgrades --dry-run

# История обновлений
cat /var/log/unattended-upgrades/unattended-upgrades.log
```

### Ручное управление обновлениями

```bash
# Обновить систему вручную
sudo apt update && sudo apt upgrade -y

# Только обновления безопасности
sudo unattended-upgrades

# Отключить автообновления (не рекомендуется)
sudo systemctl disable unattended-upgrades
```

## 5. Пользователь deploy

### Настройки пользователя

- **Пользователь**: `deploy`
- **Домашняя директория**: `/home/deploy`
- **Права**: `sudo` группа
- **SSH**: только ключевая аутентификация
- **Ограничения**: системные лимиты на файлы и процессы

### Управление пользователем

```bash
# Добавить SSH ключ
echo "ssh-ed25519 AAAAC3..." >> /home/deploy/.ssh/authorized_keys

# Проверить права sudo
sudo -l -U deploy

# Просмотр активных сессий пользователя
w deploy

# История команд
sudo cat /home/deploy/.bash_history
```

### Безопасность пользователя

```bash
# Проверить права на файлы SSH
ls -la /home/deploy/.ssh/

# Должны быть:
# drwx------ deploy deploy .ssh/
# -rw------- deploy deploy authorized_keys

# Исправить права если нужно
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
```

## 6. Директории проекта

### Структура директорий

```
/opt/books/
├── app/           # Приложение и конфигурация (.env.prod)
├── uploads/       # Загруженные файлы (медиа)
├── backups/       # Бэкапы базы данных
└── logs/          # Логи приложения и системы
```

### Права доступа

```bash
# Проверить права
ls -la /opt/books/

# Должны быть:
# drwxr-xr-x deploy deploy app/
# drwxrwxr-x deploy deploy uploads/
# drwxrwxr-x deploy deploy backups/
# drwxrwxr-x deploy deploy logs/

# Исправить права
sudo chown -R deploy:deploy /opt/books
sudo chmod 755 /opt/books/app
sudo chmod 775 /opt/books/{uploads,backups,logs}
```

### Безопасность файлов

```bash
# .env.prod должен быть защищен
sudo chmod 600 /opt/books/app/.env.prod
sudo chown deploy:deploy /opt/books/app/.env.prod

# Регулярная очистка временных файлов
find /opt/books/logs -name "*.log" -mtime +30 -delete
find /opt/books/backups -name "*.sql.gz" -mtime +14 -delete
```

## 7. Мониторинг безопасности

### Регулярные проверки

Рекомендуется запускать еженедельно:

```bash
# Полная проверка безопасности
./scripts/test_security.sh

# Проверка системных обновлений
sudo apt list --upgradable | grep security

# Анализ логов безопасности
sudo grep "FAILED\|ERROR\|WARNING" /var/log/auth.log | tail -20
sudo grep "Ban" /var/log/fail2ban.log | tail -10
sudo grep "BLOCK" /var/log/ufw.log | tail -10
```

### Алерты и уведомления

Настройте уведомления для:

- SSH подключения с новых IP
- Множественные неудачные попытки входа
- Изменения в системных файлах
- Доступные критические обновления
- Ошибки в логах приложения

### Мониторинг через Prometheus/Grafana

Метрики безопасности доступны в Grafana:

- Активные SSH соединения
- fail2ban статистика
- UFW заблокированные соединения
- Системная нагрузка и ресурсы

## 8. Incident Response

### При подозрении на компрометацию

1. **Немедленные действия:**

```bash
# Заблокировать все входящие соединения (кроме SSH)
sudo ufw deny in

# Просмотр активных соединений
sudo netstat -tulpn
sudo ss -tulpn

# Проверка процессов
sudo ps aux | grep -v "\[.*\]"
```

2. **Анализ логов:**

```bash
# Последние SSH подключения
sudo last | head -20

# Подозрительные процессы
sudo top -c

# Сетевая активность
sudo lsof -i
```

3. **Восстановление:**

```bash
# Сменить SSH ключи
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_new
# Добавить новый ключ, удалить старый

# Обновить все пакеты
sudo apt update && sudo apt upgrade -y

# Проверить integrity системных файлов
sudo debsums -c
```

### Контакты

При критических инцидентах:

1. Заблокируйте доступ
2. Сохраните логи
3. Обратитесь к системному администратору
4. Документируйте инцидент

## 9. Резервное копирование конфигураций

### Бэкап настроек безопасности

```bash
# Создать бэкап всех настроек
mkdir -p /opt/books/backups/security/$(date +%Y%m%d)
sudo cp /etc/ssh/sshd_config /opt/books/backups/security/$(date +%Y%m%d)/
sudo cp /etc/fail2ban/jail.local /opt/books/backups/security/$(date +%Y%m%d)/
sudo ufw show added > /opt/books/backups/security/$(date +%Y%m%d)/ufw-rules.txt
sudo cp /etc/security/limits.conf /opt/books/backups/security/$(date +%Y%m%d)/
```

### Восстановление настроек

```bash
# Восстановить конфигурацию SSH
sudo cp /opt/books/backups/security/20231201/sshd_config /etc/ssh/
sudo systemctl reload sshd

# Восстановить fail2ban
sudo cp /opt/books/backups/security/20231201/jail.local /etc/fail2ban/
sudo systemctl restart fail2ban
```

## 10. Чеклист безопасности

### Перед развертыванием в продакшен

- [ ] SSH настроен (только ключи, отключен root)
- [ ] UFW активен с правильными правилами
- [ ] fail2ban установлен и настроен
- [ ] Автоматические обновления включены
- [ ] Пользователь deploy создан с правильными правами
- [ ] Директории проекта созданы с правильными правами
- [ ] Системные лимиты настроены
- [ ] Проверка безопасности пройдена (`./scripts/test_security.sh`)

### Еженедельные проверки

- [ ] Запуск `./scripts/test_security.sh`
- [ ] Проверка доступных обновлений
- [ ] Анализ логов безопасности
- [ ] Проверка бэкапов
- [ ] Мониторинг дискового пространства
- [ ] Проверка активных SSH соединений

### Ежемесячные задачи

- [ ] Аудит SSH ключей
- [ ] Ротация логов
- [ ] Проверка настроек fail2ban
- [ ] Обновление документации
- [ ] Тестирование процедур восстановления

---

## Дополнительные ресурсы

- [Ubuntu Security Guide](https://ubuntu.com/security)
- [SSH Hardening Guide](https://www.ssh.com/academy/ssh/sshd_config)
- [fail2ban Documentation](https://fail2ban.readthedocs.io/)
- [UFW Documentation](https://help.ubuntu.com/community/UFW)

Созданно: 2025-09-27  
Обновлено: 2025-09-27
