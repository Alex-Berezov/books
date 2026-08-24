-- Системная CMS-страница хаба авторов (`authors-hub`), пять языков.
--
-- 🔴 Почему миграцией, а не руками в админке. `Page.systemKey` редактору
-- недоступен: поля нет ни в одном DTO страниц, а `forbidNonWhitelisted` отвечает
-- 400 на попытку его прислать. Так сделано намеренно (`20260809000000_page_system_key`):
-- ключ — функциональный контракт, и он не должен меняться при обычном сохранении.
-- Следствие: страницу с ключом нельзя завести никаким запросом к API вообще,
-- и единственный доступный путь — миграция, как и бэкфилл пяти прежних ключей.
--
-- Редактор дальше правит эти страницы в админке как обычные: слаг, заголовок,
-- текст и FAQ ему доступны, недоступен только `system_key`. Контент здесь —
-- стартовый, а не окончательный.
--
-- ⚠️ Идемпотентно. Каждая вставка идёт через `WHERE NOT EXISTS` по паре
-- «язык + ключ»: повторный накат и накат на базу, где страницу уже завели,
-- не дублируют строк и не затирают правки редактора. Пустой CTE не отдаёт строк,
-- поэтому и `Seo` в этом случае не создаётся — висячих записей не остаётся.
--
-- ⚠️ Без `DO $$ ... $$`: `scripts/drift-check.mjs` разбирает операторы миграций
-- и объявление переменной PL/pgSQL прочитать не может, а непрочитанный оператор
-- он считает скрытой рассинхронизацией и красит проверку (ADR-011).
--
-- Пять строк, по одной на язык: уникальность `("language", "system_key")`
-- составная, страница существует один раз в каждом языке. `translation_group_id`
-- общий — это переводы одной страницы, а не пять разных.

-- ru --------------------------------------------------------------------------
WITH seo AS (
  INSERT INTO "Seo" ("metaTitle", "metaDescription", "createdAt", "updatedAt")
  SELECT
    'Авторы книг | Bibliaris',
    'Каталог авторов на Bibliaris: биографии писателей, поэтов и философов, их книги и аудиокниги.',
    NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "Page" WHERE "language" = 'ru' AND "system_key" = 'authors-hub')
  RETURNING "id"
)
INSERT INTO "Page" (
  "id", "slug", "title", "type", "content", "status", "language",
  "translation_group_id", "system_key", "h1", "shortDescription", "faq",
  "createdAt", "updatedAt", "seoId"
)
SELECT
  gen_random_uuid(), 'authors-hub-index', 'Авторы', 'author_index',
  '<p>Здесь собраны писатели, поэты и мыслители, чьи произведения есть в библиотеке Bibliaris. У каждого автора — страница с биографией, списком книг и доступными аудиокнигами.</p><p>Список можно листать по алфавиту, искать по имени или отсортировать по числу книг. Авторы, у которых пока нет опубликованных произведений, в каталоге не показываются.</p>',
  'published', 'ru', 'c1a7f0de-2b64-4d51-9a3e-7f0b5c8e41d2'::uuid, 'authors-hub',
  'Авторы',
  'Писатели, поэты и мыслители, чьи книги собраны в библиотеке',
  '[{"question":"Как найти автора по имени?","answer":"Начните вводить имя в поле поиска над списком — выдача обновится сама. Искать можно и по части имени, регистр значения не имеет."},{"question":"Почему некоторых авторов нет в списке?","answer":"В каталоге показываются только авторы, у которых есть хотя бы одна опубликованная книга на этом языке. Как только книга появится, автор появится и здесь."},{"question":"Что означает золотая пометка на карточке?","answer":"Она показывает, что у автора есть аудиокниги, и сколько именно. Слушать их можно прямо на сайте."}]'::jsonb,
  NOW(), NOW(), seo."id"
FROM seo;

-- en --------------------------------------------------------------------------
WITH seo AS (
  INSERT INTO "Seo" ("metaTitle", "metaDescription", "createdAt", "updatedAt")
  SELECT
    'Book Authors | Bibliaris',
    'Author catalog on Bibliaris: writer biographies, poets, and philosophers, their books and audiobooks.',
    NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "Page" WHERE "language" = 'en' AND "system_key" = 'authors-hub')
  RETURNING "id"
)
INSERT INTO "Page" (
  "id", "slug", "title", "type", "content", "status", "language",
  "translation_group_id", "system_key", "h1", "shortDescription", "faq",
  "createdAt", "updatedAt", "seoId"
)
SELECT
  gen_random_uuid(), 'authors-hub-index', 'Authors', 'author_index',
  '<p>These are the writers, poets, and thinkers whose work is available in the Bibliaris library. Every author has a page with a biography, a list of books, and any audiobooks on offer.</p><p>Browse the list alphabetically, search by name, or sort it by the number of books. Authors with no published work yet are not listed.</p>',
  'published', 'en', 'c1a7f0de-2b64-4d51-9a3e-7f0b5c8e41d2'::uuid, 'authors-hub',
  'Authors',
  'Writers, poets, and thinkers whose books are collected in the library',
  '[{"question":"How do I find an author by name?","answer":"Start typing the name in the search box above the list and the results update as you type. Partial names work, and case does not matter."},{"question":"Why are some authors missing from the list?","answer":"Only authors with at least one published book in this language are listed. As soon as a book is published, the author appears here."},{"question":"What does the gold badge on a card mean?","answer":"It shows that the author has audiobooks, and how many. You can listen to them right on the site."}]'::jsonb,
  NOW(), NOW(), seo."id"
FROM seo;

-- es --------------------------------------------------------------------------
WITH seo AS (
  INSERT INTO "Seo" ("metaTitle", "metaDescription", "createdAt", "updatedAt")
  SELECT
    'Autores de libros | Bibliaris',
    'Catálogo de autores en Bibliaris: biografías de escritores, poetas y filósofos, sus libros y audiolibros.',
    NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "Page" WHERE "language" = 'es' AND "system_key" = 'authors-hub')
  RETURNING "id"
)
INSERT INTO "Page" (
  "id", "slug", "title", "type", "content", "status", "language",
  "translation_group_id", "system_key", "h1", "shortDescription", "faq",
  "createdAt", "updatedAt", "seoId"
)
SELECT
  gen_random_uuid(), 'authors-hub-index', 'Autores', 'author_index',
  '<p>Aquí están los escritores, poetas y pensadores cuya obra forma parte de la biblioteca Bibliaris. Cada autor tiene una página con su biografía, la lista de sus libros y los audiolibros disponibles.</p><p>Puedes recorrer la lista por orden alfabético, buscar por nombre u ordenarla por número de libros. Los autores que todavía no tienen obras publicadas no aparecen en el catálogo.</p>',
  'published', 'es', 'c1a7f0de-2b64-4d51-9a3e-7f0b5c8e41d2'::uuid, 'authors-hub',
  'Autores',
  'Escritores, poetas y pensadores cuyos libros están reunidos en la biblioteca',
  '[{"question":"¿Cómo busco un autor por su nombre?","answer":"Empieza a escribir el nombre en el campo de búsqueda situado sobre la lista y los resultados se actualizarán solos. Funciona con nombres parciales y no distingue mayúsculas."},{"question":"¿Por qué faltan algunos autores en la lista?","answer":"Solo se muestran los autores con al menos un libro publicado en este idioma. En cuanto se publique un libro, el autor aparecerá aquí."},{"question":"¿Qué significa la marca dorada de una ficha?","answer":"Indica que el autor tiene audiolibros y cuántos. Puedes escucharlos directamente en el sitio."}]'::jsonb,
  NOW(), NOW(), seo."id"
FROM seo;

-- fr --------------------------------------------------------------------------
WITH seo AS (
  INSERT INTO "Seo" ("metaTitle", "metaDescription", "createdAt", "updatedAt")
  SELECT
    'Auteurs de livres | Bibliaris',
    'Catalogue des auteurs sur Bibliaris : biographies d''écrivains, de poètes et de philosophes, leurs livres et livres audio.',
    NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "Page" WHERE "language" = 'fr' AND "system_key" = 'authors-hub')
  RETURNING "id"
)
INSERT INTO "Page" (
  "id", "slug", "title", "type", "content", "status", "language",
  "translation_group_id", "system_key", "h1", "shortDescription", "faq",
  "createdAt", "updatedAt", "seoId"
)
SELECT
  gen_random_uuid(), 'authors-hub-index', 'Auteurs', 'author_index',
  '<p>Voici les écrivains, poètes et penseurs dont l''œuvre figure dans la bibliothèque Bibliaris. Chaque auteur dispose d''une page avec sa biographie, la liste de ses livres et les livres audio disponibles.</p><p>Parcourez la liste par ordre alphabétique, cherchez par nom ou triez-la par nombre de livres. Les auteurs sans œuvre publiée n''apparaissent pas dans le catalogue.</p>',
  'published', 'fr', 'c1a7f0de-2b64-4d51-9a3e-7f0b5c8e41d2'::uuid, 'authors-hub',
  'Auteurs',
  'Écrivains, poètes et penseurs dont les livres sont réunis dans la bibliothèque',
  '[{"question":"Comment trouver un auteur par son nom ?","answer":"Commencez à saisir le nom dans le champ de recherche au-dessus de la liste : les résultats se mettent à jour au fur et à mesure. Les noms partiels fonctionnent et la casse n''a pas d''importance."},{"question":"Pourquoi certains auteurs manquent-ils dans la liste ?","answer":"Seuls les auteurs ayant au moins un livre publié dans cette langue sont listés. Dès qu''un livre paraît, l''auteur apparaît ici."},{"question":"Que signifie la pastille dorée sur une fiche ?","answer":"Elle indique que l''auteur a des livres audio, et combien. Vous pouvez les écouter directement sur le site."}]'::jsonb,
  NOW(), NOW(), seo."id"
FROM seo;

-- pt --------------------------------------------------------------------------
WITH seo AS (
  INSERT INTO "Seo" ("metaTitle", "metaDescription", "createdAt", "updatedAt")
  SELECT
    'Autores de livros | Bibliaris',
    'Catálogo de autores no Bibliaris: biografias de escritores, poetas e filósofos, seus livros e audiolivros.',
    NOW(), NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "Page" WHERE "language" = 'pt' AND "system_key" = 'authors-hub')
  RETURNING "id"
)
INSERT INTO "Page" (
  "id", "slug", "title", "type", "content", "status", "language",
  "translation_group_id", "system_key", "h1", "shortDescription", "faq",
  "createdAt", "updatedAt", "seoId"
)
SELECT
  gen_random_uuid(), 'authors-hub-index', 'Autores', 'author_index',
  '<p>Aqui estão os escritores, poetas e pensadores cuja obra faz parte da biblioteca Bibliaris. Cada autor tem uma página com a biografia, a lista dos seus livros e os audiolivros disponíveis.</p><p>Percorra a lista por ordem alfabética, pesquise pelo nome ou ordene-a pelo número de livros. Autores ainda sem obras publicadas não aparecem no catálogo.</p>',
  'published', 'pt', 'c1a7f0de-2b64-4d51-9a3e-7f0b5c8e41d2'::uuid, 'authors-hub',
  'Autores',
  'Escritores, poetas e pensadores cujos livros estão reunidos na biblioteca',
  '[{"question":"Como encontro um autor pelo nome?","answer":"Comece a escrever o nome no campo de pesquisa acima da lista e os resultados atualizam-se sozinhos. Funciona com nomes parciais e não distingue maiúsculas."},{"question":"Porque faltam alguns autores na lista?","answer":"Só são listados os autores com pelo menos um livro publicado neste idioma. Assim que um livro for publicado, o autor aparece aqui."},{"question":"O que significa a marca dourada num cartão?","answer":"Mostra que o autor tem audiolivros, e quantos. Pode ouvi-los diretamente no site."}]'::jsonb,
  NOW(), NOW(), seo."id"
FROM seo;
