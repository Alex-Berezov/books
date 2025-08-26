# Media Library (Медиа-библиотека)

Цель: централизованное хранение и повторное использование медиа (изображения/аудио) по ключу стораджа, с удобным админ-листингом и безопасным удалением.

## Модель данных

Таблица: `MediaAsset`

- id: string (uuid)
- key: string (уникальный ключ в сторадже, например uploads/2025/08/…)
- url: string (публичная ссылка, разрешён http/https)
- contentType?: string (image/jpeg, audio/mpeg, …)
- size?: number (байты)
- width?/height?: number (пиксели, если изображение)
- hash?: string (опциональный контроль дубликатов)
- createdAt: Date
- createdById?: string → User.id
- isDeleted: boolean (soft delete)

Индексы: key @unique, createdAt, hash.

## API

Требуются роли: admin или content_manager (JwtAuthGuard + RolesGuard).

1. POST /media/confirm

- Назначение: идемпотентно подтверждает объект по key, создаёт/обновляет запись `MediaAsset`.
- Body (ConfirmMediaDto):
  - key: string (обязательно)
  - url?: string (если не передан — берём из StorageService.getPublicUrl(key))
  - contentType?: string
  - size?: number, width?: number, height?: number, hash?: string
- Ответ: MediaAsset

2. GET /media?page&limit&q&type

- Назначение: листинг медиа с фильтрами.
- Query (MediaListQueryDto):
  - page?: number = 1
  - limit?: number = 20
  - q?: string (подстрока по key|url)
  - type?: string (префикс по contentType, например image/ или audio/)
- Ответ: { items: MediaAsset[], total: number, page: number, limit: number }

3. DELETE /media/:id

- Назначение: мягкое удаление (isDeleted=true) + попытка удалить файл из стораджа (best-effort).
- Ответ: { success: true }

## Валидация и соглашения

- url должен начинаться с http/https; для локального стораджа формируется `/static/...` через публичный базовый URL.
- confirm — идемпотентный по `key`: существующая запись обновляется и возвращается.
- Листинг исключает помеченные isDeleted=true.

## Интеграция со стораджем

- Используется `StorageService` (локальный драйвер: `var/uploads`, публичный доступ через `/static`).
- Получение публичного URL: `getPublicUrl(key)`.
- Удаление файла при DELETE — best-effort: ошибки стораджа не блокируют ответ API.

## Миграции

- В автоматической среде используем ручной деплой миграций (non-interactive):
  - Локально: `yarn prisma:migrate --name add_media_asset` → `yarn prisma:generate` → применить миграции к dev БД.
  - На сервере: `prisma migrate deploy`.

## Тесты

- e2e: `test/media.e2e-spec.ts` — smoke-сценарии confirm → list → delete.

## Доступ/безопасность

- Все ручки доступны только для `admin` и `content_manager`.
- Поведение и guard-ы согласованы со стилем модулей Tags/Categories.

## Дальнейшие шаги

- Рефактор `BookVersion.coverImageUrl` → `mediaId` (миграция данных, обратная совместимость DTO, обновление e2e).
- Отдельные политики очистки сиротских файлов (опционально).
- Хеширование для дедупликации (использовать `hash` более активно в UI/поиске).
