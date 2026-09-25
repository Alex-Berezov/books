-- LEGACY-420, второй рубеж к замку: одна сводка на языковую версию книги.
--
-- CREATE UNIQUE INDEX на живых данных — класс 2 по ADR-018. Расширением был релиз v1.0.128
-- (пачка T31): единственный писатель BookSummary, BookSummaryService.upsertForVersion,
-- пишет под pg_advisory_xact_lock по bookVersionId, и новый дубль кодом не возникает.
-- Этот релиз — сжатие: сам рубеж в базе. Запись третьего вида в
-- scripts/migration-compat-allowlist.json называет образ v1.0.129 целью отката.
--
-- Дубли. Замер на проде 25.09.2026, после выката v1.0.128: одна строка, дублей нет.
-- Повторный замер не требуется (решение арбитра 25.09.2026, decisions-log.md): писатель
-- один и под замком, миграции и скрипты в таблицу не пишут.
--
-- Данные. Миграция не удаляет и не изменяет ни одной строки. На дубле она падает целиком
-- (23505): строка в _prisma_migrations с finished_at = NULL, следующий `migrate deploy`
-- отвечает P3009 до ручной чистки дубля и `prisma migrate resolve` — это делает владелец
-- (books-app-docs/backend/guides/migration-failure-runbook.md). Образ при этом поднимается:
-- docker-entrypoint.sh глотает отказ миграций, замок в коде продолжает держать.
--
-- Идемпотентность — двумя операторами, как в 20260919170000_legacy_276_category_slug_unique:
-- DO-блок только проверяет, что занятое имя — это полный UNIQUE по одной колонке
-- bookVersionId (иначе `IF NOT EXISTS` молча оставил бы не тот индекс, класс LEGACY-367),
-- а создание идёт плоским оператором, который видит scripts/drift-check.mjs.
--
-- Locks. SHARE на "BookSummary" до конца файла; таблица на проде — одна строка, окно
-- в миллисекундах. CONCURRENTLY невозможен внутри транзакционного блока Prisma.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'BookSummary_bookVersionId_key'
       AND c.relkind = 'i'
       AND n.nspname = current_schema()
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
     WHERE c.relname = 'BookSummary_bookVersionId_key'
       AND t.relname = 'BookSummary'
       AND i.indisunique
       AND i.indpred IS NULL
       AND i.indnkeyatts = 1
       AND (
         SELECT a.attname FROM pg_attribute a
          WHERE a.attrelid = t.oid AND a.attnum = i.indkey[0]
       ) = 'bookVersionId'
  ) THEN
    RAISE EXCEPTION
      'LEGACY-420: "BookSummary_bookVersionId_key" уже существует, но это не полный UNIQUE по BookSummary(bookVersionId). Применённой такую миграцию считать нельзя.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "BookSummary_bookVersionId_key" ON "BookSummary"("bookVersionId");
