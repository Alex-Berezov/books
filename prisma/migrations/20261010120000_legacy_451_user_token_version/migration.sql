-- LEGACY-451, пачка T122: версия сессий пользователя. Аддитивно: колонка с умолчанием,
-- существующие токены без claim `tv` после выката считаются версией 0 и продолжают жить
-- до своего срока (решение арбитра 10.10.2026, `decisions-log.md`).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
