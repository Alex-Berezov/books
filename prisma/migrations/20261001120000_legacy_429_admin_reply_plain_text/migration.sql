-- LEGACY-429, решение арбитра T79 (01.10.2026). До T47 ответ администратора на отзыв писался
-- редактором разметки и сохранялся HTML-строкой; читатель видит её с тегами (`{comment.text}`
-- экранируется React). T47 (фронт, выкат 2026-09-28 21:09:34 UTC) закрыл только новые ответы.
--
-- Перезапись откатываемая: исходный текст сначала копируется в "_legacy429_comment_text".
-- Откат после выката — только вперёд, новой миграцией через конвейер (решение арбитра 01.10.2026):
-- UPDATE "Comment" c SET "text" = b."text" FROM "_legacy429_comment_text" b
-- WHERE c."id" = b."id" AND c."text" = <очищенный b."text">, чтобы не затереть правки после выката.
-- Этот файл после выката не удаляется и не ревертится. DROP резервной таблицы — решение владельца
-- (тема №2), миграцией не делается.
--
-- Граница строк: ответ (parentId), автор с ролью модератора (admin/content_manager — тот же
-- набор, что `ModeratorRolesService.isModerator`), записан до выката T47 и содержит тег из набора
-- редактора. Набор — строка в строку `RICH_HTML_ALLOWED_TAGS` (`src/shared/sanitize/rich-html.ts`,
-- копия во фронте — `lib/utils/rich-html.ts`, LEGACY-414); третья копия здесь, потому что SQL
-- константу TS не прочитает. Отзывы читателей не трогаются: в них `<` — это текст, а не разметка.
-- Вывод редактора всегда начинается блочным тегом (p, ul, ol, h1-h6, pre, blockquote); ответ модератора
-- из публичной формы отзывов — простой текст, где `<br>` или `&amp;` набраны руками, — без такого начала
-- и не трогается.
-- Повтор безопасен: копия — ON CONFLICT DO NOTHING, перезапись — только пока текст равен копии.
-- На базе без таких строк обе операции пустые.

CREATE TABLE IF NOT EXISTS "_legacy429_comment_text" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "_legacy429_comment_text_pkey" PRIMARY KEY ("id")
);

INSERT INTO "_legacy429_comment_text" ("id", "text")
SELECT c."id", c."text"
FROM "Comment" c
WHERE c."parentId" IS NOT NULL
  AND c."createdAt" < TIMESTAMP '2026-09-28 21:09:34'
  AND c."text" ~* '<(p|br|strong|em|u|s|code|pre|h[1-6]|ul|ol|li|blockquote|hr|a|img)(\s[^>]*)?/?>'
  AND c."text" ~* '^\s*<(p|ul|ol|h[1-6]|pre|blockquote)(\s[^>]*)?>'
  AND EXISTS (
    SELECT 1
    FROM "UserRole" ur
    JOIN "Role" r ON r."id" = ur."roleId"
    WHERE ur."userId" = c."userId" AND r."name" IN ('admin', 'content_manager')
  )
ON CONFLICT ("id") DO NOTHING;

-- Строчные теги (strong, em, u, s, code) снимаются первыми — содержимого у них нет, и ссылка с ними
-- внутри остаётся ссылкой; `<li><p>x</p></li>` и `<blockquote><p>x</p></blockquote>` дают один перевод
-- строки, а не два.
-- Адрес ссылки и картинки не теряется: `<a href="X">текст</a>` -> `текст (X)` (ссылка, текст которой
-- и есть адрес, -> `X`), ссылка с тегом внутри (картинка, `<br>`) -> `(X) ...`, `<img src="X">` -> `X`.
-- Каждый адрес из исходника остаётся в очищенном тексте: резервная таблица исключена из поиска медиа
-- (`media-references.spec.ts`), и адрес, оставшийся только в ней, уборка сочла бы ничьим. Концы блоков (p, li, h1-h6, pre, blockquote), <br>
-- и <hr> — перевод строки, остальные теги снимаются, сущности разворачиваются
-- (`&amp;` последней, чтобы `&amp;lt;` не превратилось в `<`), три и больше переводов строки
-- сжимаются до двух, края обрезаются. Пустой итог не пишется: текст обязателен.
UPDATE "Comment" c
SET "text" = s."clean"
FROM (
  SELECT b."id", b."text" AS "original",
    btrim(regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                      regexp_replace(b."text", '</?(strong|em|u|s|code)(\s[^>]*)?>', '', 'gi'),
                      '</p>\s*</(li|blockquote)>', '</\1>', 'gi'),
                    '<a\s[^>]*href="([^"]*)"[^>]*>\1</a>', '\1', 'gi'),
                  '<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)</a>', '\2 (\1)', 'gi'),
                  '<a\s[^>]*href="([^"]*)"[^>]*>', '(\1) ', 'gi'),
                '<img\s[^>]*src="([^"]*)"[^>]*>', '\1', 'gi'),
              '<(br|hr)(\s[^>]*)?/?>', E'\n', 'gi'),
            '</(p|li|h[1-6]|pre|blockquote)\s*>', E'\n', 'gi'),
          '<[^>]*>', '', 'g'),
        '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#34;', '"'), '&#39;', ''''),
        '&#x27;', ''''), '&apos;', ''''), '&nbsp;', ' '), '&amp;', '&'),
      E'\n{3,}', E'\n\n', 'g'), E' \t\n') AS "clean"
  FROM "_legacy429_comment_text" b
) s
WHERE c."id" = s."id"
  AND c."text" = s."original"
  AND s."clean" <> '';
