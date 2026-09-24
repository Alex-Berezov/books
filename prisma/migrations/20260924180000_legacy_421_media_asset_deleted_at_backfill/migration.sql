-- LEGACY-421, решение арбитра T53 (M1). До 24.09.2026 ручной DELETE /media/:id помечал ассет
-- isDeleted = true, но не писал deletedAt; stage 2 уборки выбирает только deletedAt IS NOT NULL,
-- и такие строки оставались в MediaAsset навсегда. Файл у них уже удалён.
--
-- Заполнение неразрушительно: схема не меняется, строки не удаляются. Через MEDIA_CLEANUP_HARD_DAYS
-- stage 2 перепроверит ссылки и удалит строку или оставит занятую помеченной. Повтор безопасен:
-- условие deletedAt IS NULL после первого применения пусто.
UPDATE "MediaAsset" SET "deletedAt" = now() WHERE "isDeleted" AND "deletedAt" IS NULL;
