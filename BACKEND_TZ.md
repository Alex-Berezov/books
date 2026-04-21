# ТЗ для бэкенд-агента: поддержка раздела «Аудиокниги»

> Задача — обеспечить полный контракт для фронтовой реализации аудио-версий книг (админка + публичный плеер). Документ фиксирует ожидания фронта и запросы к бэкенду. Где что-то уже реализовано — отмечено ✅, где требуется действие — ⚠️.
>
> **Проект:** Bibliaris (books-app-back)
> **Автор ТЗ:** фронтенд-агент
> **Дата:** 21 апреля 2026
> **Связано с:** `books-docs/frontend/ENDPOINTS.md`, `backend/frontend-related/ADMIN_UI_SPEC.md`, `backend/guides/media-library.md`

---

## 1. Общая идея

Аудиокнига на платформе = `BookVersion` c `type = 'audio'` + набор `AudioChapter` (одна глава = один аудио-файл из Media Library). Метаданные (title/author/description/cover/SEO/isFree/referralUrl) хранятся на `BookVersion`, Summary — в `BookSummary`. Фронт (админка и публичный плеер) ожидает стабильный REST-контракт, документированные лимиты и корректную валидацию.

**MVP-ограничения, согласованные фронтом:**

- Одна глава = один аудио-файл. Нарезка на главы выполняется админом вручную **до** загрузки.
- Формат: `mp3` (основное), `m4a/aac`, опционально `ogg`, `wav`.
- Soft-limit фронта: **200 MB/файл**. Требуется согласовать реальный лимит бэкенда.

---

## 2. Эндпоинты — статус и требования

### 2.1. AudioChapter CRUD ✅ (уже есть) + уточнения ⚠️

Из `backend/api/endpoints.md`:

| Method | Path                                      | Access                   | Статус |
| ------ | ----------------------------------------- | ------------------------ | ------ |
| GET    | `/versions/:bookVersionId/audio-chapters` | Public                   | ✅     |
| POST   | `/versions/:bookVersionId/audio-chapters` | admin \| content_manager | ✅     |
| GET    | `/audio-chapters/:id`                     | Public                   | ✅     |
| PATCH  | `/audio-chapters/:id`                     | admin \| content_manager | ✅     |
| DELETE | `/audio-chapters/:id`                     | admin \| content_manager | ✅     |

**⚠️ Требуется подтвердить / дополнить:**

1. **Полная схема полей `AudioChapter`** (DTO response) — ожидаемый минимум:

   ```ts
   interface AudioChapter {
     id: string; // UUID
     bookVersionId: string; // UUID
     number: number; // int, unique в пределах версии
     title: string; // required, non-empty
     audioUrl: string; // public URL (из Media Library)
     mediaId?: string | null; // FK на MediaAsset.id (желательно)
     duration: number; // seconds, int ≥ 0
     description?: string | null; // ⚠️ НОВОЕ: краткое описание главы (markdown/plain, ≤ 5000 симв.)
     transcript?: string | null; // ⚠️ ОПЦ.: полный транскрипт (markdown, ≤ N симв.)
     createdAt: string; // ISO
     updatedAt: string; // ISO
   }
   ```

   **Запрос к бэкенду:**
   - Подтвердить текущую форму DTO (дать выдержку из Swagger/OpenAPI для `AudioChapter`/`AudioChapterDto`).
   - **Добавить** поле `description?: string` (если его нет). Обоснование: фронту требуется краткое описание главы для UI плеера и админки — сейчас такого поля нет в документации.
   - Рассмотреть добавление `transcript?: string` для поддержки текста главы при прослушивании (nice-to-have, можно вынести в отдельный endpoint позднее).
   - **Желательно**: хранить `mediaId` (FK на `MediaAsset`) — чтобы при удалении главы корректно считать orphan media. По аналогии с планом `BookVersion.coverImageUrl → mediaId` из `media-library.md`.

2. **Схемы `CreateAudioChapterDto` / `UpdateAudioChapterDto`** — ожидания фронта:

   ```ts
   // POST /versions/:bookVersionId/audio-chapters
   interface CreateAudioChapterDto {
     number: number; // required
     title: string; // required, 1..255
     audioUrl: string; // required, http(s)://...
     mediaId?: string; // опц., если бэк решит связывать
     duration: number; // required, ≥ 0, seconds
     description?: string; // ≤ 5000
     transcript?: string; // опц.
   }

   // PATCH /audio-chapters/:id
   interface UpdateAudioChapterDto {
     number?: number;
     title?: string;
     audioUrl?: string;
     mediaId?: string;
     duration?: number;
     description?: string;
     transcript?: string;
   }
   ```

   **Валидация (обязательна на бэке):**
   - `number`: integer ≥ 1, **unique в пределах `bookVersionId`** (409 Conflict при дубликате с читаемым сообщением).
   - `title`: 1..255.
   - `audioUrl`: `http(s)://`, непустой.
   - `duration`: integer ≥ 0, разумный upper bound (например ≤ 24h = 86400).
   - `description`: ≤ 5000 символов.

3. **Пагинация `GET /versions/:bookVersionId/audio-chapters`:**
   - Параметры: `page` (≥ 1, default 1), `limit` (1..100, default 50).
   - Ответ — единый формат со списочными эндпоинтами (уточнить: `{ items, total, page, limit }` или `{ data, meta }`).
   - Сортировка: по `number ASC` по умолчанию.
   - **Не принимать** `language` — язык определяется родительской `BookVersion`.

4. **Публичная выдача `GET /audio-chapters/:id`:**
   - Должна возвращать главу **только если родительская версия `published`** (404 иначе).
   - Для админки — использовать **admin-эндпоинт** (см. п. 2.2).

### 2.2. Admin-версия endpoint'ов ⚠️ (рекомендация)

По аналогии с `/admin/versions/:id`, `/admin/pages/:id` (решает проблему «404 на draft» — см. `FIX_BOOK_VERSION_404.md`) требуется:

| Method | Path                                            | Доступ                   |
| ------ | ----------------------------------------------- | ------------------------ |
| GET    | `/admin/versions/:bookVersionId/audio-chapters` | admin \| content_manager |
| GET    | `/admin/audio-chapters/:id`                     | admin \| content_manager |

**Поведение:** возвращать главы в **любом** статусе родительской версии (draft/published). Иначе админ-панель не сможет редактировать аудио-главы у черновиков.

### 2.3. (Опц.) Reorder ⚠️

Фронт может потребовать массовое переупорядочивание глав:

```
POST /versions/:bookVersionId/audio-chapters/reorder
Body: { audioChapterIds: string[] }  // новый порядок
```

- Атомарная транзакция: обновить `number` у всех глав.
- Ответ: актуальный массив `AudioChapter[]` в новом порядке.
- Если не хотите этот endpoint — подтвердите, фронт будет делать N PATCH-запросов (хуже, но рабочее решение).

---

## 3. Загрузка файлов

### 3.1. Текущий флоу ✅

Фронт использует `POST /media/upload` (multipart `file`) — one-step загрузка → `MediaAsset`. Принимает `audio/*` (по ответу медиа-библиотеки).

### 3.2. Требования к контракту ⚠️

Документировать (и реализовать, если отсутствует):

1. **Лимит размера тела запроса** (nginx/caddy + multer):
   - Требование фронта: **≥ 200 MB** для одного файла.
   - Указать в `MAX_UPLOAD_SIZE` (env) и вернуть точное значение через **документацию** (желательно — новый endpoint `GET /uploads/limits` или поле в `GET /health`).
2. **Whitelist MIME-типов** для аудио:
   - Обязательно: `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/x-m4a`.
   - Желательно: `audio/ogg`, `audio/wav`, `audio/webm`.
   - Любой другой — 415 Unsupported Media Type.
3. **Коды ошибок**:
   - 413 Payload Too Large (файл больше лимита).
   - 415 Unsupported Media Type (неподдерживаемый MIME).
   - 429 Too Many Requests (rate-limit).
4. **Ответ `POST /media/upload` — полный DTO `MediaAsset`** (проверить что присутствуют):

   ```ts
   interface MediaAsset {
     id: string;
     key: string;
     url: string;
     contentType: string; // "audio/mpeg"
     size: number; // bytes
     duration?: number; // ⚠️ ЖЕЛАТЕЛЬНО: sec, если бэк умеет считать (ffprobe)
     createdAt: string;
     createdById: string;
   }
   ```

   **Nice-to-have:** если бэк уже использует `ffprobe`/аналог — добавить поле `duration` в ответ для аудио. Тогда фронту не нужно считать длительность на клиенте.

### 3.3. (Опц.) Прогресс / presigned direct upload ⚠️

- Текущий `POST /media/upload` не поддерживает onProgress — фронт перейдёт на XHR, это ок.
- Если реальный лимит бэкенда < 200 MB — **обязательно** документировать presigned-флоу для аудио:
  - `POST /uploads/presign { key, contentType, size }` → `{ token, url, key }`.
  - `POST /uploads/direct` (Bearer token) — прямая бинарная загрузка.
  - `POST /media/confirm { key, contentType, size, duration? }` → `MediaAsset`.
  - Уточнить rate-limit и таймауты.

---

## 4. Связанные контракты

### 4.1. `BookVersion.type = 'audio'` ✅

Уже поддержано. Подтвердить:

- Канонический URL публичной аудио-версии — `/versions/:id` (нейтральный, без `:lang`).
- Поле `type` принимает `'text' | 'audio' | 'referral'`.

### 4.2. SEO для аудио-версии ✅

`GET /seo/resolve?type=version&id=:id` — без изменений. Canonical `/versions/:id`.

### 4.3. Reading Progress ✅ (проверить)

`PUT /me/progress/:versionId` принимает `{ audioChapterNumber?: number, position?: number }`. Запрос:

- Подтвердить, что `position` для аудио — **секунды** (float/int).
- Валидация: `position ≥ 0`, `audioChapterNumber` существует в версии.

### 4.4. Comments с target=audio ✅

`POST /comments { audioChapterId, text, parentId? }` — без изменений.

### 4.5. Views ⚠️ (уточнить)

`POST /views { versionId, source }` — подтвердить, что для аудио есть отдельный `source='audio'` (или `'listen'`), чтобы разделять статистику чтения и прослушивания.

---

## 5. Дополнительные пожелания

### 5.1. Sample / preview audio ⚠️ (nice-to-have, low priority)

Для платных книг — возможность отдать **короткий preview** (первые 30–60 сек) публично. Варианты:

- Отдельный endpoint `GET /audio-chapters/:id/preview` (streaming первые N секунд).
- Или поле `previewUrl?: string` у `BookVersion` с готовым ссылкой на preview-mp3.

**Не блокирует MVP**, но желательно обсудить на будущее.

### 5.2. Orphan media cleanup ⚠️

При `DELETE /audio-chapters/:id` — **best-effort** пометить связанный `MediaAsset` как soft-deleted (если он не используется другой главой / версией). Либо отложить до отдельного cron-worker'а — подтвердите стратегию.

### 5.3. OpenAPI / Swagger

**Обязательно** после изменений:

- Обновить `/api/docs` (Swagger UI) и `/api/docs-json` (OpenAPI).
- Фронт перегенерирует типы командой `yarn openapi:types:prod` (см. `frontend/frontend-agents/backend-api-reference.md`).

---

## 6. Чек-лист для бэкенд-агента

- [ ] Подтвердить текущую схему `AudioChapter` DTO (выдержка из Swagger).
- [ ] Добавить `description?: string` в схему `AudioChapter` (+ Create/Update DTO + валидация).
- [ ] Обсудить `transcript?: string` (добавить сейчас или позднее — решение бэка).
- [ ] Рассмотреть `mediaId` FK на `MediaAsset` (миграция + обратная совместимость).
- [ ] Документировать валидации: `number` unique per version, `title` 1..255, `duration` 0..86400.
- [ ] Добавить admin-endpoint'ы `GET /admin/versions/:bookVersionId/audio-chapters` и `GET /admin/audio-chapters/:id` (возвращают главы для draft-версий).
- [ ] (Опц.) Endpoint `POST /versions/:id/audio-chapters/reorder` — или явно отказать.
- [ ] Документировать лимит размера загрузки (env `MAX_UPLOAD_SIZE`, подтвердить ≥ 200 MB).
- [ ] Whitelist MIME для аудио + корректные коды ошибок (413/415/429).
- [ ] (Желательно) Добавить `duration` в `MediaAsset` DTO при загрузке аудио (через ffprobe).
- [ ] Подтвердить поле `source` в `POST /views` для аудио (`audio` / `listen`).
- [ ] (Опц.) Обсудить preview-audio для платных книг.
- [ ] Обновить Swagger / OpenAPI и соответствующие секции в `books-docs`:
  - `backend/api/endpoints.md` (раздел Audio Chapters)
  - `backend/frontend-related/ADMIN_UI_SPEC.md` (уточнения полей)
  - `backend/guides/media-library.md` (audio MIME / limits)
  - `frontend/ENDPOINTS.md` и `frontend/frontend-agents/backend-api-reference.md`
- [ ] После мёрджа — уведомить фронт для регенерации типов (`yarn openapi:types:prod`).

---

## 7. Примеры запросов/ответов (ожидаемые фронтом)

### Создание главы

```http
POST /api/versions/v_abc123/audio-chapters
Authorization: Bearer <token>
Content-Type: application/json

{
  "number": 1,
  "title": "Chapter 1: The Boy Who Lived",
  "audioUrl": "https://cdn.bibliaris.com/audio/hp1/ch1.mp3",
  "mediaId": "m_xyz789",
  "duration": 1860,
  "description": "Introduction to Harry Potter's world."
}
```

**200 / 201:**

```json
{
  "id": "ac_456",
  "bookVersionId": "v_abc123",
  "number": 1,
  "title": "Chapter 1: The Boy Who Lived",
  "audioUrl": "https://cdn.bibliaris.com/audio/hp1/ch1.mp3",
  "mediaId": "m_xyz789",
  "duration": 1860,
  "description": "Introduction to Harry Potter's world.",
  "transcript": null,
  "createdAt": "2026-04-21T10:00:00.000Z",
  "updatedAt": "2026-04-21T10:00:00.000Z"
}
```

### Ошибка дубликата `number`

```http
POST /api/versions/v_abc123/audio-chapters
{ "number": 1, "title": "...", "audioUrl": "...", "duration": 100 }
```

**409 Conflict:**

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Audio chapter with number 1 already exists in this version",
  "field": "number"
}
```

### Получение списка

```http
GET /api/versions/v_abc123/audio-chapters?page=1&limit=50
```

**200:**

```json
{
  "items": [
    { "id": "ac_456", "number": 1, "title": "...", "audioUrl": "...", "duration": 1860, ... },
    { "id": "ac_789", "number": 2, "title": "...", "audioUrl": "...", "duration": 1740, ... }
  ],
  "total": 17,
  "page": 1,
  "limit": 50
}
```

---

## 8. Синхронизация

После реализации бэкенд-изменений:

1. Бэкенд-агент обновляет `books-docs` (секции указаны в чек-листе).
2. Бэкенд-агент пишет фронт-агенту короткий changelog (что изменилось, что breaking).
3. Фронт регенерирует `types/api-schema.ts` (`yarn openapi:types:prod`) и запускает Фазу 2 плана (см. [PLAN.md](./PLAN.md)).

---

## 9. Приоритеты

**Must-have (блокирует фронт):**

- Подтверждение схемы `AudioChapter` + добавление `description`.
- Admin-endpoint'ы для draft-версий.
- Документированный лимит размера + whitelist MIME.

**Should-have:**

- `mediaId` FK, `duration` в MediaAsset, reorder endpoint.

**Nice-to-have:**

- `transcript`, preview audio, orphan cleanup.
