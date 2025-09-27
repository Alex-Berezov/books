# Backup Guide - Руководство по системе бэкапов

> Комплексное руководство по настройке, использованию и управлению системой бэкапов Books App.

## Обзор

Система бэкапов Books App обеспечивает автоматическое резервное копирование:

- **PostgreSQL база данных** - полные дампы с сжатием
- **Медиафайлы** - архивы всех загруженных файлов из `/opt/books/uploads`
- **Автоматическая ротация** - удаление старых бэкапов по расписанию
- **Проверка целостности** - регулярная валидация созданных бэкапов
- **Восстановление** - простые инструменты для recovery

## Быстрый старт

### Автоматическая настройка

```bash
# Настройка автоматических бэкапов (пользовательские cron задачи)
./scripts/setup_backup_cron.sh

# Или системная настройка (требует root)
sudo ./scripts/setup_backup_cron.sh system

# Создание первого бэкапа
sudo -u deploy ./scripts/backup_database.sh

# Проверка целостности
./scripts/test_backup.sh
```

### Быстрая проверка статуса

```bash
# Статус бэкапов
ls -la /opt/books/backups/*/

# Последний лог
tail -20 /opt/books/backups/backup.log

# Cron задачи
sudo -u deploy crontab -l | grep backup
```

## 1. Архитектура системы

### Структура директорий

```
/opt/books/backups/
├── daily/              # Ежедневные бэкапы
│   ├── books-db_20231201_020000.sql.gz
│   └── uploads_20231201_020000.tar.gz
├── weekly/             # Еженедельные бэкапы
│   ├── books-db_20231203_030000.sql.gz
│   └── uploads_20231203_030000.tar.gz
├── monthly/            # Ежемесячные бэкапы
│   ├── books-db_20231201_040000.sql.gz
│   └── uploads_20231201_040000.tar.gz
├── backup.log          # Общий лог всех операций
└── *_report_*.txt      # Отчеты о бэкапах и проверках
```

### Типы бэкапов

- **daily** - ежедневные (хранятся 14 дней)
- **weekly** - еженедельные (можно хранить дольше)
- **monthly** - ежемесячные (для долгосрочного хранения)

### Компоненты системы

1. **backup_database.sh** - основной скрипт создания бэкапов
2. **restore_database.sh** - восстановление из бэкапа
3. **test_backup.sh** - проверка целостности
4. **setup_backup_cron.sh** - настройка автоматизации

## 2. Создание бэкапов

### Ручное создание бэкапа

```bash
# Ежедневный бэкап
./scripts/backup_database.sh daily

# Еженедельный бэкап
./scripts/backup_database.sh weekly

# Ежемесячный бэкап
./scripts/backup_database.sh monthly

# Только база данных (без медиафайлов)
INCLUDE_UPLOADS=false ./scripts/backup_database.sh daily

# С другими настройками
BACKUP_RETENTION_DAYS=30 COMPRESS_BACKUPS=true ./scripts/backup_database.sh
```

### Переменные окружения

Основные настройки (можно задать в `/opt/books/app/.env.backup`):

```bash
# Директория бэкапов
BACKUP_DIR="/opt/books/backups"

# Срок хранения (дни)
BACKUP_RETENTION_DAYS=14

# Сжатие бэкапов
COMPRESS_BACKUPS=true

# Включать медиафайлы
INCLUDE_UPLOADS=true

# PostgreSQL настройки
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=books
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password

# Docker настройки
USE_DOCKER=auto  # auto/true/false
```

### Автоматический режим

Система автоматически определяет:

- **Способ подключения к PostgreSQL** (Docker vs локальный)
- **Наличие медиафайлов** для бэкапа
- **Доступное место на диске** для очистки старых бэкапов

## 3. Восстановление данных

### Интерактивное восстановление

```bash
# Восстановление с выбором бэкапа
./scripts/restore_database.sh

# Восстановление из конкретного файла
./scripts/restore_database.sh /opt/books/backups/daily/books-db_20231201_020000.sql.gz

# Автоматическое подтверждение (для скриптов)
./scripts/restore_database.sh /path/to/backup.sql.gz '' true
```

### Процесс восстановления

1. **Создание резервной копии** текущего состояния
2. **Остановка приложения** (если в Docker)
3. **Восстановление БД** из выбранного бэкапа
4. **Восстановление медиафайлов** (если найдены)
5. **Проверка целостности** восстановленных данных
6. **Запуск приложения**

### Безопасность восстановления

- Автоматическое создание backup'а текущего состояния
- Возврат к предыдущему состоянию при ошибках
- Подтверждение перед началом операции
- Проверка целостности после восстановления

## 4. Проверка целостности

### Автоматическая проверка

```bash
# Полная проверка системы бэкапов
./scripts/test_backup.sh

# Результат покажет:
# - ✓ Пройденные проверки (зеленый)
# - ⚠ Предупреждения (желтый)
# - ✗ Ошибки (красный)
```

### Виды проверок

1. **Директории** - существование и права доступа
2. **Файлы бэкапов** - наличие и размеры
3. **Актуальность** - возраст последних бэкапов
4. **Сжатие** - целостность .gz архивов
5. **SQL структура** - валидность дампов PostgreSQL
6. **Медиафайлы** - целостность .tar.gz архивов
7. **Логи** - наличие записей и ошибок
8. **Дисковое пространство** - доступное место
9. **Расписание** - настройка cron задач

### Настройка проверок

```bash
# Минимальный размер бэкапа (МБ)
MIN_BACKUP_SIZE_MB=5 ./scripts/test_backup.sh

# Максимальный возраст бэкапа (дни)
MAX_BACKUP_AGE_DAYS=3 ./scripts/test_backup.sh
```

## 5. Автоматизация

### Настройка расписания

```bash
# Стандартное расписание
./scripts/setup_backup_cron.sh

# Пользовательские настройки времени
DAILY_TIME=01:30 WEEKLY_TIME=02:30 ./scripts/setup_backup_cron.sh

# Системная настройка (требует root)
sudo NOTIFICATION_EMAIL=admin@example.com ./scripts/setup_backup_cron.sh system
```

### Расписание по умолчанию

- **Ежедневные**: каждый день в 02:00
- **Еженедельные**: воскресенье в 03:00
- **Ежемесячные**: 1-е число в 04:00
- **Проверка целостности**: понедельник в 06:00

### Управление cron задачами

```bash
# Просмотр задач
sudo -u deploy crontab -l

# Редактирование задач
sudo -u deploy crontab -e

# Удаление всех задач бэкапа
sudo -u deploy crontab -l | grep -v backup_database.sh | sudo -u deploy crontab -

# Логи cron
journalctl -u cron -f
```

## 6. Мониторинг и алерты

### Проверка статуса

```bash
# Последние бэкапы
find /opt/books/backups -name "*.sql*" -mtime -1 -ls

# Размер бэкапов
du -sh /opt/books/backups/*/

# Ошибки в логах
grep "ERROR\|FAIL" /opt/books/backups/backup.log | tail -10

# Статус cron задач
systemctl status cron
```

### Интеграция с мониторингом

Добавьте в Prometheus/Grafana мониторинг:

```bash
# Возраст последнего бэкапа (секунды)
echo "backup_age_seconds $(( $(date +%s) - $(stat -c %Y /opt/books/backups/daily/books-db_*.sql.gz | tail -1) ))" > /var/lib/node_exporter/textfile_collector/backup_age.prom

# Размер бэкапов (байты)
echo "backup_size_bytes $(du -sb /opt/books/backups | cut -f1)" > /var/lib/node_exporter/textfile_collector/backup_size.prom

# Количество бэкапов
echo "backup_count $(find /opt/books/backups -name "*.sql*" | wc -l)" > /var/lib/node_exporter/textfile_collector/backup_count.prom
```

### Email уведомления

Настройте через системный cron с MAILTO:

```bash
# В /etc/cron.d/books_backup
MAILTO=admin@example.com

# Или через postfix/sendmail для детальных уведомлений
```

## 7. Troubleshooting

### Частые проблемы

#### Ошибка подключения к PostgreSQL

```bash
# Проверка подключения
docker exec postgres pg_isready -h localhost -p 5432

# Или локально
pg_isready -h localhost -p 5432 -U postgres

# Проверка переменных окружения
echo $POSTGRES_PASSWORD
```

#### Нет места на диске

```bash
# Проверка места
df -h /opt/books/backups

# Ручная очистка старых бэкапов
find /opt/books/backups -name "*.sql*" -mtime +30 -delete
find /opt/books/backups -name "*.tar.gz" -mtime +30 -delete

# Уменьшение срока хранения
BACKUP_RETENTION_DAYS=7 ./scripts/backup_database.sh
```

#### Поврежденные бэкапы

```bash
# Проверка сжатых файлов
gzip -t /opt/books/backups/daily/*.gz

# Проверка SQL структуры
gunzip -c backup.sql.gz | head -20

# Пересоздание бэкапа
./scripts/backup_database.sh daily
```

#### Проблемы с правами доступа

```bash
# Исправление владельца директорий
sudo chown -R deploy:deploy /opt/books/backups

# Исправление прав
sudo chmod 755 /opt/books/backups
sudo chmod 775 /opt/books/backups/{daily,weekly,monthly}
```

### Восстановление после сбоя

1. **Проверка последнего корректного бэкапа**:

```bash
./scripts/test_backup.sh
```

2. **Восстановление из резервной копии**:

```bash
./scripts/restore_database.sh
```

3. **Проверка целостности данных**:

```bash
# Количество записей в основных таблицах
docker exec postgres psql -U postgres -d books -c "
SELECT 'users' as table, count(*) from \"User\"
UNION ALL SELECT 'books', count(*) from \"Book\"
UNION ALL SELECT 'versions', count(*) from \"BookVersion\";"
```

4. **Пересоздание бэкапа**:

```bash
./scripts/backup_database.sh daily
```

## 8. Оптимизация производительности

### Настройки PostgreSQL для бэкапов

```sql
-- Оптимизация для pg_dump
SET checkpoint_segments = 32;
SET checkpoint_completion_target = 0.9;
SET wal_buffers = 16MB;
```

### Сжатие и архивирование

```bash
# Альтернативные методы сжатия (если нужна скорость)
COMPRESS_BACKUPS=false ./scripts/backup_database.sh

# Использование pigz для параллельного сжатия (если установлен)
alias gzip='pigz'
```

### Планирование нагрузки

- Запускайте бэкапы в часы минимальной нагрузки
- Разносите по времени разные типы бэкапов
- Мониторьте влияние на производительность приложения

## 9. Безопасность

### Защита бэкапов

```bash
# Шифрование бэкапов (опционально)
gpg --symmetric --cipher-algo AES256 backup.sql

# Ограничение прав доступа
chmod 600 /opt/books/app/.env.backup
chmod 700 /opt/books/backups
```

### Аудит доступа

```bash
# Логирование доступа к бэкапам
sudo ausearch -f /opt/books/backups -i

# Мониторинг изменений
inotifywait -m /opt/books/backups -e create,delete,modify
```

## 10. Миграция и масштабирование

### Перенос бэкапов

```bash
# Синхронизация с удаленным хранилищем
rsync -av /opt/books/backups/ backup-server:/backups/books/

# S3 интеграция (если настроено)
aws s3 sync /opt/books/backups s3://mybucket/backups/
```

### Распределенные бэкапы

```bash
# Бэкап на несколько серверов
for server in backup1 backup2; do
    scp backup.sql.gz $server:/backups/
done
```

## 11. Автоматизация через CI/CD

### GitLab CI пример

```yaml
backup_test:
  script:
    - ./scripts/test_backup.sh
  only:
    - schedules

backup_create:
  script:
    - ./scripts/backup_database.sh monthly
  only:
    - tags
```

### Интеграция с Ansible

```yaml
- name: Setup backup system
  script: ./scripts/setup_backup_cron.sh system
  become: yes

- name: Test backup integrity
  script: ./scripts/test_backup.sh
  register: backup_test

- name: Notify on backup failure
  mail:
    to: admin@example.com
    subject: 'Backup test failed'
  when: backup_test.rc != 0
```

## 12. Чеклист для продакшена

### Перед запуском

- [ ] Все скрипты протестированы
- [ ] Cron задачи настроены и работают
- [ ] Переменные окружения настроены
- [ ] Права доступа корректны
- [ ] Достаточно места на диске
- [ ] Email уведомления настроены
- [ ] Мониторинг настроен

### Еженедельные проверки

- [ ] Запуск `./scripts/test_backup.sh`
- [ ] Проверка свободного места
- [ ] Тестовое восстановление (раз в месяц)
- [ ] Проверка логов на ошибки
- [ ] Мониторинг метрик бэкапов

### Ежемесячные задачи

- [ ] Полная проверка системы
- [ ] Тестирование процедуры восстановления
- [ ] Очистка старых отчетов
- [ ] Обновление документации
- [ ] Проверка соответствия политикам

---

## Дополнительные ресурсы

- [PostgreSQL Backup Documentation](https://www.postgresql.org/docs/current/backup.html)
- [Cron Job Guide](https://crontab.guru/)
- [Bash Scripting Guide](https://tldp.org/LDP/Bash-Beginners-Guide/html/)

**Контакты поддержки**: В случае проблем с бэкапами обращайтесь к системному администратору.

Создано: 2025-09-27  
Обновлено: 2025-09-27
