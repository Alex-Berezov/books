-- Раздел «Пересказ» (17.10.2026, решение арбитра в decisions-log.md, 2026-10-17-summary-section).
-- Признак «в пересказе есть видимый текст»: по нему считаются `_count.summaries` и `hasSummary`
-- в карточке, списке книг (карта сайта) и обзоре книги. Только добавление: колонка с умолчанием
-- одним оператором - прежний образ, пишущий пересказ во время выката, колонки не знает.
-- Новые строки пишет `BookSummaryService.upsertForVersion` по `richHtmlText` (тот же, что валидатор).
-- Откат: `ALTER TABLE "BookSummary" DROP COLUMN "hasText";` - только через владельца (тема 2).
ALTER TABLE "BookSummary" ADD COLUMN IF NOT EXISTS "hasText" BOOLEAN NOT NULL DEFAULT true;

-- Одноразовый пересчёт строк, сохранённых до валидатора `@RichHtmlHasText`: SQL-приближение
-- `richHtmlText` - вырезанные санитайзером script/style (содержимое без `<`: ленивые квантификаторы
-- Postgres съедали текст между двумя блоками), теги, пробельные и невидимые сущности
-- (именованные и числовые - все пробельные коды `\s` JS и знаки нулевой ширины), пробельные
-- и невидимые знаки. Остаток пуст - текста нет.
-- Формы посажены `test/book-summary-has-text-migration.e2e-spec.ts`.
UPDATE "BookSummary" SET "hasText" = false
WHERE btrim(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace("summary", '<script[^>]*>[^<]*</script>', '', 'gi'),
              '<style[^>]*>[^<]*</style>', '', 'gi'),
            '<[^>]*>', '', 'g'),
          '&(nbsp|ensp|emsp|thinsp|shy|zwnj|zwj);', '', 'gi'),
        '&#0*(9|1[0-3]|32|160|173|5760|819[2-9]|820[0-5]|8232|8233|8239|8287|8288|12288|65279);', '', 'g'),
      '&#x0*(9|a|b|c|d|20|a0|ad|1680|200[0-9a-d]|2028|2029|202f|205f|2060|3000|feff);', '', 'gi'),
    '[\s\u00a0\u00ad\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]', '', 'g')
) = '';
