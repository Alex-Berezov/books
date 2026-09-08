import 'dotenv/config';
import { PrismaClient, Language, BookType, CategoryType, RoleName } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * Автор сида. Идентификатор задан литералом, а не оставлен `uuid()`: сид
 * идемпотентен и гоняется повторно поверх той же базы, а естественного ключа
 * у `Author` нет - уникальность живёт в `AuthorTranslation`.
 */
const SEED_AUTHOR_ID = 'seed-author-jk-rowling';

/**
 * Слаг демо-книги. С `LEGACY-200` это ещё и ключ идемпотентности всей правовой
 * цепочки: у `RightsIntake`/`RightsProfile`/`RightsReview`/`RightsReviewImport`
 * своих фиксированных id больше нет, и найти уже заведённые строки можно только
 * по ссылкам этой книги. Литерал в трёх местах разъехался бы молча: чтение нашло бы
 * не ту книгу, а `upsert` завёл бы вторую цепочку.
 */
const SEED_BOOK_SLUG = 'harry-potter';

const AUTHOR_TRANSLATIONS = [
  { language: Language.en, slug: 'j-k-rowling', name: 'J.K. Rowling' },
  { language: Language.ru, slug: 'dzhoan-rouling', name: 'Джоан Роулинг' },
  { language: Language.es, slug: 'j-k-rowling-es', name: 'J.K. Rowling' },
  { language: Language.fr, slug: 'j-k-rowling-fr', name: 'J.K. Rowling' },
  { language: Language.pt, slug: 'j-k-rowling-pt', name: 'J.K. Rowling' },
];

const VERSION_SEEDS = [
  {
    language: Language.en,
    title: "Harry Potter and the Philosopher's Stone",
    slug: 'harry-potter-and-the-philosophers-stone',
    author: 'J.K. Rowling',
    description: 'First book of the Harry Potter series',
  },
  {
    language: Language.ru,
    title: 'Гарри Поттер и философский камень',
    slug: 'garri-potter-i-filosofskiy-kamen',
    author: 'Джоан Роулинг',
    description: 'Первая книга серии о Гарри Поттере',
  },
  {
    language: Language.es,
    title: 'Harry Potter y la piedra filosofal',
    slug: 'harry-potter-y-la-piedra-filosofal',
    author: 'J.K. Rowling',
    description: 'Primer libro de la serie de Harry Potter',
  },
  {
    language: Language.fr,
    title: "Harry Potter à l'école des sorciers",
    slug: 'harry-potter-a-l-ecole-des-sorciers',
    author: 'J.K. Rowling',
    description: 'Premier livre de la série Harry Potter',
  },
  {
    language: Language.pt,
    title: 'Harry Potter e a Pedra Filosofal',
    slug: 'harry-potter-e-a-pedra-filosofal',
    author: 'J.K. Rowling',
    description: 'Primeiro livro da série Harry Potter',
  },
];

/** Английская версия — она же заводится внутри `book.upsert`, чтобы книга не создавалась пустой. */
const EN_VERSION = VERSION_SEEDS[0];

/**
 * Каталог под гейт SEO на пути PR (`Q1`, `LEGACY-016`).
 *
 * 🔴 Пять книг на язык - это не «побольше данных», а ровно порог индексируемости.
 * `resolveAutoIndexable` (`src/modules/seo/indexability/taxonomyIndexability.ts:19-37`)
 * открывает термин при `bookCount >= 5` и закрывает при `<= 2`, между - держит прежнее
 * состояние. Хаб рисует ссылку только на линкуемый термин, а линкуемость требует
 * `autoIndexable` (`books-front/lib/seo/taxonomy-linkable.ts:55-74`). Меньшее число книг
 * дало бы зелёный аудит лишь потому, что колонка `autoIndexable` объявлена
 * `@default(true)`, - и первый же вызов пересчёта (`book-version.service.ts:1203`,
 * `category.service.ts:885`) молча опустошил бы хабы. Решение арбитра 08.09.2026,
 * `books-app-docs/ai-context/decisions-log.md`.
 *
 * ⚠️ Термин каждого вида ровно один: `smoke`-прогон `books-front/scripts/seo-audit.mjs`
 * требует одной живой ссылки на каждом из четырёх хабов, а не полного каталога.
 * `fantasy` и `bestsellers` намеренно оставлены как были - они обслуживают другие спеки.
 */
const SEO_CATALOG_CATEGORIES: Array<{
  key: string;
  type: CategoryType;
  name: string;
  translations: Array<{ language: Language; name: string; slug: string }>;
}> = [
  {
    key: 'world-literature',
    type: CategoryType.category,
    name: 'World literature',
    translations: [
      { language: Language.en, name: 'World literature', slug: 'world-literature' },
      { language: Language.ru, name: 'Мировая литература', slug: 'mirovaya-literatura' },
      { language: Language.es, name: 'Literatura mundial', slug: 'literatura-mundial' },
      { language: Language.fr, name: 'Littérature mondiale', slug: 'litterature-mondiale' },
      { language: Language.pt, name: 'Literatura mundial', slug: 'literatura-mundial' },
    ],
  },
  {
    key: 'adventure',
    type: CategoryType.genre,
    name: 'Adventure',
    translations: [
      { language: Language.en, name: 'Adventure', slug: 'adventure' },
      { language: Language.ru, name: 'Приключения', slug: 'priklyucheniya' },
      { language: Language.es, name: 'Aventuras', slug: 'aventuras' },
      { language: Language.fr, name: 'Aventure', slug: 'aventure' },
      { language: Language.pt, name: 'Aventura', slug: 'aventura' },
    ],
  },
  {
    key: 'school-reading',
    type: CategoryType.collection,
    name: 'School reading',
    translations: [
      { language: Language.en, name: 'School reading', slug: 'school-reading' },
      { language: Language.ru, name: 'Школьное чтение', slug: 'shkolnoe-chtenie' },
      { language: Language.es, name: 'Lectura escolar', slug: 'lectura-escolar' },
      { language: Language.fr, name: 'Lecture scolaire', slug: 'lecture-scolaire' },
      { language: Language.pt, name: 'Leitura escolar', slug: 'leitura-escolar' },
    ],
  },
];

/** Языки каталога: те же пять, на которых заведены переводы терминов и версии книг. */
const SEO_CATALOG_LANGUAGES: Language[] = [
  Language.en,
  Language.ru,
  Language.es,
  Language.fr,
  Language.pt,
];

const SEO_CATALOG_TAG = {
  key: 'classics',
  name: 'Classics',
  translations: [
    { language: Language.en, name: 'Classics', slug: 'classics' },
    { language: Language.ru, name: 'Классика', slug: 'klassika' },
    { language: Language.es, name: 'Clásicos', slug: 'clasicos' },
    { language: Language.fr, name: 'Classiques', slug: 'classiques' },
    { language: Language.pt, name: 'Clássicos', slug: 'classicos' },
  ],
};

/**
 * Пять книг каталога, каждая - на пяти языках. Названия настоящие: страницы книг
 * попадают и в карту сайта, и в выборку смоук-прогона, а осмысленный заголовок
 * отличает сломанную страницу от пустой быстрее, чем `seed-book-3`.
 *
 * ⚠️ Слаг версии уникален **в пределах языка** (`@@unique([language, slug])` на
 * `BookVersion`), и с адресами терминов он не сталкивается вовсе: те живут
 * в `CategoryTranslation`/`TagTranslation`. Поэтому одно и то же слово занимает
 * слаг на разных языках свободно, и суффикса языка здесь нет ни у одной записи.
 */
const SEO_CATALOG_BOOKS: Array<{
  slug: string;
  author: string;
  versions: Array<{ language: Language; title: string; slug: string; description: string }>;
}> = [
  {
    slug: 'treasure-island',
    author: 'Robert Louis Stevenson',
    versions: [
      {
        language: Language.en,
        title: 'Treasure Island',
        slug: 'treasure-island',
        description: 'A boy, a map and a mutiny on the way to the pirate hoard.',
      },
      {
        language: Language.ru,
        title: 'Остров сокровищ',
        slug: 'ostrov-sokrovishch',
        description: 'Мальчик, карта и мятеж на пути к пиратскому кладу.',
      },
      {
        language: Language.es,
        title: 'La isla del tesoro',
        slug: 'la-isla-del-tesoro',
        description: 'Un muchacho, un mapa y un motín camino del tesoro pirata.',
      },
      {
        language: Language.fr,
        title: "L'Île au trésor",
        slug: 'l-ile-au-tresor',
        description: 'Un garçon, une carte et une mutinerie sur la route du trésor.',
      },
      {
        language: Language.pt,
        title: 'A Ilha do Tesouro',
        slug: 'a-ilha-do-tesouro',
        description: 'Um rapaz, um mapa e um motim a caminho do tesouro pirata.',
      },
    ],
  },
  {
    slug: 'the-jungle-book',
    author: 'Rudyard Kipling',
    versions: [
      {
        language: Language.en,
        title: 'The Jungle Book',
        slug: 'the-jungle-book',
        description: 'A boy raised by wolves learns the law of the jungle.',
      },
      {
        language: Language.ru,
        title: 'Книга джунглей',
        slug: 'kniga-dzhungley',
        description: 'Мальчик, выращенный волками, учится закону джунглей.',
      },
      {
        language: Language.es,
        title: 'El libro de la selva',
        slug: 'el-libro-de-la-selva',
        description: 'Un niño criado por lobos aprende la ley de la selva.',
      },
      {
        language: Language.fr,
        title: 'Le Livre de la jungle',
        slug: 'le-livre-de-la-jungle',
        description: 'Un enfant élevé par des loups apprend la loi de la jungle.',
      },
      {
        language: Language.pt,
        title: 'O Livro da Selva',
        slug: 'o-livro-da-selva',
        description: 'Um menino criado por lobos aprende a lei da selva.',
      },
    ],
  },
  {
    slug: 'around-the-world-in-eighty-days',
    author: 'Jules Verne',
    versions: [
      {
        language: Language.en,
        title: 'Around the World in Eighty Days',
        slug: 'around-the-world-in-eighty-days',
        description: 'A wager sends Phileas Fogg racing the calendar around the globe.',
      },
      {
        language: Language.ru,
        title: 'Вокруг света за восемьдесят дней',
        slug: 'vokrug-sveta-za-vosemdesyat-dney',
        description: 'Пари отправляет Филеаса Фогга в гонку с календарём вокруг света.',
      },
      {
        language: Language.es,
        title: 'La vuelta al mundo en ochenta días',
        slug: 'la-vuelta-al-mundo-en-ochenta-dias',
        description: 'Una apuesta lanza a Phileas Fogg a una carrera contra el calendario.',
      },
      {
        language: Language.fr,
        title: 'Le Tour du monde en quatre-vingts jours',
        slug: 'le-tour-du-monde-en-quatre-vingts-jours',
        description: 'Un pari lance Phileas Fogg dans une course contre le calendrier.',
      },
      {
        language: Language.pt,
        title: 'A Volta ao Mundo em Oitenta Dias',
        slug: 'a-volta-ao-mundo-em-oitenta-dias',
        description: 'Uma aposta lança Phileas Fogg numa corrida contra o calendário.',
      },
    ],
  },
  {
    slug: 'the-three-musketeers',
    author: 'Alexandre Dumas',
    versions: [
      {
        language: Language.en,
        title: 'The Three Musketeers',
        slug: 'the-three-musketeers',
        description: "A Gascon joins the king's musketeers and their quarrels.",
      },
      {
        language: Language.ru,
        title: 'Три мушкетёра',
        slug: 'tri-mushketyora',
        description: 'Гасконец попадает в королевские мушкетёры и в их распри.',
      },
      {
        language: Language.es,
        title: 'Los tres mosqueteros',
        slug: 'los-tres-mosqueteros',
        description: 'Un gascón entra en los mosqueteros del rey y en sus pleitos.',
      },
      {
        language: Language.fr,
        title: 'Les Trois Mousquetaires',
        slug: 'les-trois-mousquetaires',
        description: 'Un Gascon entre chez les mousquetaires du roi et dans leurs querelles.',
      },
      {
        language: Language.pt,
        title: 'Os Três Mosqueteiros',
        slug: 'os-tres-mosqueteiros',
        description: 'Um gascão entra para os mosqueteiros do rei e para as suas contendas.',
      },
    ],
  },
  {
    slug: 'twenty-thousand-leagues-under-the-sea',
    author: 'Jules Verne',
    versions: [
      {
        language: Language.en,
        title: 'Twenty Thousand Leagues Under the Sea',
        slug: 'twenty-thousand-leagues-under-the-sea',
        description: 'Captain Nemo takes three captives on a voyage beneath the oceans.',
      },
      {
        language: Language.ru,
        title: 'Двадцать тысяч лье под водой',
        slug: 'dvadtsat-tysyach-le-pod-vodoy',
        description: 'Капитан Немо увозит троих пленников в плавание под океанами.',
      },
      {
        language: Language.es,
        title: 'Veinte mil leguas de viaje submarino',
        slug: 'veinte-mil-leguas-de-viaje-submarino',
        description: 'El capitán Nemo lleva a tres cautivos a un viaje bajo los océanos.',
      },
      {
        language: Language.fr,
        title: 'Vingt mille lieues sous les mers',
        slug: 'vingt-mille-lieues-sous-les-mers',
        description: 'Le capitaine Nemo emmène trois captifs sous les océans.',
      },
      {
        language: Language.pt,
        title: 'Vinte Mil Léguas Submarinas',
        slug: 'vinte-mil-leguas-submarinas',
        description: 'O capitão Nemo leva três cativos numa viagem sob os oceanos.',
      },
    ],
  },
];

/**
 * Правовая цепочка одной книги: `RightsIntake` -> `RightsProfile` -> `RightsReview`
 * (плюс импорт отчёта). Возвращает три ссылки, которые кладутся в саму книгу и в снимок
 * каждой её версии.
 *
 * Вынесена из `main` не ради красоты: с 08.09.2026 (`Q1`, `LEGACY-016`) сид заводит
 * шесть книг вместо одной, а цепочка у каждой своя - `RightsProfile.rightsIntakeId`
 * и `RightsReview.rightsProfileId` связывают её с конкретной заявкой. Одна цепочка
 * на всех означала бы, что вердикт по одной книге стоит снимком на чужих версиях.
 *
 * LEGACY-200: `RightsIntake`/`RightsProfile`/`RightsReview`/`RightsReviewImport` больше не
 * получают `id` литералом - `@default(uuid())` в схеме реален, только если ничто в коде
 * не подставляет своё значение. Идемпотентность сида (повторный прогон поверх той же базы)
 * держится не на фиксированном id этих четырёх записей, а на `Book.slug`: если книга с этим
 * слагом уже привязана к цепочке прав, цепочка переиспользуется по ссылкам из самой книги,
 * а не создаётся заново.
 *
 * ⚠️ Цепочка заводится одной транзакцией по той же причине, что и блок версий ниже.
 * Прежняя форма на `upsert` с фиксированными id самолечилась: обрыв посередине
 * чинился следующим прогоном, потому что ключ был известен заранее. Теперь ключа нет,
 * и оборванная на середине цепочка (Ctrl+C, `P1017`, OOM контейнера на шаге сида
 * в конвейере фронта - `LEGACY-294`) осталась бы без книги, а значит недостижимой
 * навсегда: следующий прогон её не найдёт и заведёт вторую.
 */
async function ensureRightsChain(
  bookSlug: string,
  candidate: { title: string; author: string; summaryRu: string },
) {
  return prisma.$transaction(
    async (tx) => {
      const existingBook = await tx.book.findUnique({
        where: { slug: bookSlug },
        select: {
          rightsIntakeId: true,
          currentRightsProfileId: true,
          approvedRightsReviewId: true,
        },
      });

      // 🔴 Переиспользуется **каждая ссылка по отдельности**, а не тройка целиком.
      // Условие «все три на месте, иначе создаём заново» строило новую цепочку из-за
      // одной недостающей строки, а живые оставляло висеть без владельца. Прежний
      // `upsert` по фиксированному id чинил ровно недостающую запись - это поведение
      // и восстановлено. `findUnique` вместо доверия ссылке обязателен: колонки
      // `Book.currentRightsProfileId` и `approvedRightsReviewId` внешнего ключа
      // не несут, и ссылка переживает удаление строки, на которую указывает.
      const intake =
        (existingBook?.rightsIntakeId
          ? await tx.rightsIntake.findUnique({
              where: { id: existingBook.rightsIntakeId },
              select: { id: true },
            })
          : null) ??
        (await tx.rightsIntake.create({
          data: {
            candidateTitle: candidate.title,
            candidateAuthor: candidate.author,
            originalLanguage: 'en',
            originalTitle: candidate.title,
            workflowStatus: 'APPROVED',
            targetLanguages: ['en', 'es', 'fr', 'pt', 'ru'],
            targetCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
            plannedContentTypes: ['text', 'audio'],
          },
          select: { id: true },
        }));

      const profile =
        (existingBook?.currentRightsProfileId
          ? await tx.rightsProfile.findUnique({
              where: { id: existingBook.currentRightsProfileId },
              select: { id: true },
            })
          : null) ??
        (await tx.rightsProfile.create({
          data: {
            rightsIntakeId: intake.id,
            status: 'APPROVED',
            isCurrent: true,
            overallStatus: 'PUBLISHABLE',
            publicationGate: 'ALLOW',
            confidence: 'HIGH',
            summaryRu: candidate.summaryRu,
            conclusionRu: 'Approved for publication',
          },
          select: { id: true },
        }));

      // Импорт заводится только вместе с ревью: он существует ради него одного
      // (`RightsReview.rightsReviewImportId` объявлен `@unique`), и отдельной ссылки
      // на импорт у книги нет - искать его при живом ревью незачем.
      const review =
        (existingBook?.approvedRightsReviewId
          ? await tx.rightsReview.findUnique({
              where: { id: existingBook.approvedRightsReviewId },
              select: { id: true },
            })
          : null) ??
        (await (async () => {
          const createdImport = await tx.rightsReviewImport.create({
            data: {
              rightsIntakeId: intake.id,
              importStatus: 'VALIDATED',
              isCurrent: true,
              reportJson: { source: 'seed' },
            },
            select: { id: true },
          });

          return tx.rightsReview.create({
            data: {
              rightsProfileId: profile.id,
              rightsReviewImportId: createdImport.id,
              status: 'HUMAN_APPROVED',
              reviewerType: 'HUMAN',
              overallStatus: 'PUBLISHABLE',
              publicationGate: 'ALLOW',
              confidence: 'HIGH',
              summaryRu: 'Public domain work',
              conclusionRu: 'Approved',
              approvedAt: new Date(),
            },
            select: { id: true },
          });
        })());

      // Разрыв цикла: `RightsIntake.approvedReviewId` указывает на ревью, которого
      // в момент создания самого intake ещё не существует. Ставится безусловно —
      // при переиспользованном intake и заново созданном ревью ссылка иначе осталась бы
      // на удалённой строке.
      await tx.rightsIntake.update({
        where: { id: intake.id },
        data: { approvedReviewId: review.id },
      });

      return { intake, profile, review };
    },
    { timeout: 30_000, maxWait: 15_000 },
  );
}

/**
 * Термины и книги каталога: три категории, один тег и пять книг на пяти языках.
 *
 * Порядок внутри важен: термины заводятся до книг, потому что привязка `BookCategory`
 * ссылается и на версию, и на термин, а не создаёт ни того, ни другого.
 *
 * ⚠️ `autoIndexable` и `bookCount` на переводах терминов не проставляются намеренно.
 * Это кэш пересчёта (`TaxonomyIndexabilityService`), и сид не имеет права объявлять
 * индексируемость в обход порога: пять опубликованных версий на язык - то самое условие,
 * при котором пересчёт откроет термин сам. Проставленный руками `true` выглядел бы
 * так же, но пережил бы удаление книг.
 */
async function seedSeoCatalog(): Promise<void> {
  // ⚠️ Термин и все его переводы - одной транзакцией, тем же приёмом, что версии и переводы
  // автора ниже. Обрыв между `category.upsert` и его `fr`-переводом оставляет термин без
  // языка: `GET /categories/tree?lang=fr` вернёт узел без `fr` в `translations`, и хаб
  // коллекций на этом языке ссылки не нарисует при ненулевом коде возврата сида.
  const { categories, tag } = await prisma.$transaction(
    async (tx) => {
      const categories: Array<{ id: string }> = [];
      for (const term of SEO_CATALOG_CATEGORIES) {
        const category = await tx.category.upsert({
          where: { key: term.key },
          // Тип и имя обновляются вместе со слагами переводов: иначе правка `type`
          // в таблице выше применилась бы к переводу и не применилась бы к термину,
          // и перенесённый из жанров в категории `adventure` продолжил бы висеть
          // в жанрах при диффе, выглядящем применённым.
          update: { type: term.type, name: term.name },
          create: { key: term.key, type: term.type, name: term.name, slug: term.key },
          select: { id: true },
        });
        categories.push(category);

        for (const t of term.translations) {
          await tx.categoryTranslation.upsert({
            where: { categoryId_language: { categoryId: category.id, language: t.language } },
            update: { name: t.name, slug: t.slug },
            create: { categoryId: category.id, language: t.language, name: t.name, slug: t.slug },
          });
        }
      }

      const tag = await tx.tag.upsert({
        where: { key: SEO_CATALOG_TAG.key },
        update: { name: SEO_CATALOG_TAG.name },
        create: {
          key: SEO_CATALOG_TAG.key,
          name: SEO_CATALOG_TAG.name,
          slug: SEO_CATALOG_TAG.key,
        },
        select: { id: true },
      });
      for (const t of SEO_CATALOG_TAG.translations) {
        await tx.tagTranslation.upsert({
          where: { tagId_language: { tagId: tag.id, language: t.language } },
          update: { name: t.name, slug: t.slug },
          create: { tagId: tag.id, language: t.language, name: t.name, slug: t.slug },
        });
      }

      return { categories, tag };
    },
    { timeout: 30_000, maxWait: 15_000 },
  );

  for (const bookSeed of SEO_CATALOG_BOOKS) {
    const { intake, profile, review } = await ensureRightsChain(bookSeed.slug, {
      title: bookSeed.versions[0].title,
      author: bookSeed.author,
      summaryRu: 'Public domain work',
    });

    const book = await prisma.book.upsert({
      where: { slug: bookSeed.slug },
      update: {
        rightsIntakeId: intake.id,
        currentRightsProfileId: profile.id,
        approvedRightsReviewId: review.id,
        rightsCreatedAt: new Date(),
      },
      create: {
        slug: bookSeed.slug,
        rightsIntakeId: intake.id,
        currentRightsProfileId: profile.id,
        approvedRightsReviewId: review.id,
        rightsCreatedAt: new Date(),
      },
    });

    // ⚠️ Версии и привязки одной транзакцией по той же причине, что и блок демо-книги
    // выше: обрыв посередине оставляет книгу с частью языков, и хаб на недосозданном
    // языке молча пуст при ненулевом коде возврата сида.
    await prisma.$transaction(
      async (tx) => {
        for (const v of bookSeed.versions) {
          const version = await tx.bookVersion.upsert({
            where: { bookId_language: { bookId: book.id, language: v.language } },
            update: {
              title: v.title,
              slug: v.slug,
              author: bookSeed.author,
              description: v.description,
              status: 'published',
              rightsProfileId: profile.id,
              approvedRightsReviewId: review.id,
            },
            create: {
              bookId: book.id,
              language: v.language,
              title: v.title,
              slug: v.slug,
              author: bookSeed.author,
              description: v.description,
              coverImageUrl: 'https://example.com/cover.jpg',
              type: BookType.text,
              isFree: true,
              // LEGACY-267: схема даёт `draft` умолчанием - публичность прописывается явно.
              status: 'published',
              rightsProfileId: profile.id,
              approvedRightsReviewId: review.id,
              rightsStatus: 'APPROVED',
              rightsAllowedCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
              rightsBlockedCountryCodes: [],
              rightsLicenseRequiredCountryCodes: [],
              rightsPendingCountryCodes: [],
            },
            select: { id: true },
          });

          for (const category of categories) {
            await tx.bookCategory.upsert({
              where: {
                bookVersionId_categoryId: { bookVersionId: version.id, categoryId: category.id },
              },
              update: {},
              create: { bookVersionId: version.id, categoryId: category.id },
            });
          }

          await tx.bookTag.upsert({
            where: { bookVersionId_tagId: { bookVersionId: version.id, tagId: tag.id } },
            update: {},
            create: { bookVersionId: version.id, tagId: tag.id },
          });
        }
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  }

  /**
   * 🔴 `bookCount` на переводе - кэш, который ведёт `TaxonomyIndexabilityService`, и сид
   * пишет его сам только потому, что пересчёт здесь не зовётся (`autoIndexable` обязан
   * оставаться заслуженным порогом, а не объявленным). Без этой строки поле остаётся
   * схемным нулём при пяти реальных книгах, и расходятся два потребителя: хабы читают
   * живой счёт сырым SQL (`category.service.ts:146-155`) и работают, а карта сайта строит
   * кластер `hreflang` **из кэша** (`books-front/lib/seo/hreflang-alternates.ts:83-104`
   * через `app/sitemaps/[filename]/route.ts:313`) - и отдаёт все двадцать адресов терминов
   * вообще без `xhtml:link`, включая self-ссылку. Проверка кластера на такой базе не может
   * покраснеть никогда. Решение арбитра 08.09.2026, `books-app-docs/ai-context/decisions-log.md`.
   *
   * ⚠️ Число берётся запросом по тому же составу, что завёл сид, а не литералом: состав
   * каталога правится таблицами выше, и литерал разошёлся бы с ними молча. Считаются строки
   * связи с опубликованной версией нужного языка - ровно так же, как их считает пересчёт
   * (`taxonomy-indexability.service.ts:37-54`).
   */
  for (const category of categories) {
    for (const language of SEO_CATALOG_LANGUAGES) {
      const bookCount = await prisma.bookCategory.count({
        where: { categoryId: category.id, bookVersion: { language, status: 'published' } },
      });
      await prisma.categoryTranslation.updateMany({
        where: { categoryId: category.id, language },
        data: { bookCount },
      });
    }
  }

  for (const language of SEO_CATALOG_LANGUAGES) {
    const bookCount = await prisma.bookTag.count({
      where: { tagId: tag.id, bookVersion: { language, status: 'published' } },
    });
    await prisma.tagTranslation.updateMany({
      where: { tagId: tag.id, language },
      data: { bookCount },
    });
  }
}

async function main() {
  // Seed Roles
  await prisma.$transaction([
    prisma.role.upsert({
      where: { name: RoleName.user },
      update: {},
      create: { name: RoleName.user },
    }),
    prisma.role.upsert({
      where: { name: RoleName.admin },
      update: {},
      create: { name: RoleName.admin },
    }),
    prisma.role.upsert({
      where: { name: RoleName.content_manager },
      update: {},
      create: { name: RoleName.content_manager },
    }),
    // Phase 19. Значение отсутствует в сгенерированном клиенте до `prisma generate` на VPS,
    // поэтому литерал приводится к RoleName вместо RoleName.lawyer.
    prisma.role.upsert({
      where: { name: 'lawyer' as RoleName },
      update: {},
      create: { name: 'lawyer' as RoleName },
    }),
  ]);

  // Optionally map env emails to roles (idempotent)
  const addRoleForEmails = async (emailsCsv: string | undefined, roleName: RoleName) => {
    const emails = (emailsCsv || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length === 0) return;
    const role = await prisma.role.findUnique({ where: { name: roleName }, select: { id: true } });
    if (!role?.id) return;
    for (const email of emails) {
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (user?.id) {
        const exists = await prisma.userRole.findUnique({
          where: { userId_roleId: { userId: user.id, roleId: role.id } },
          select: { userId: true },
        });
        if (!exists) {
          await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
        }
      }
    }
  };

  await addRoleForEmails(process.env.ADMIN_EMAILS, RoleName.admin);
  await addRoleForEmails(process.env.CONTENT_MANAGER_EMAILS, RoleName.content_manager);
  // Seed Categories (slug is not unique anymore => no upsert by slug)
  const getOrCreateCategory = async (
    slug: string,
    name: string,
    type: CategoryType,
  ): Promise<{ id: string; slug: string; name: string }> => {
    const existing = await prisma.category.findFirst({ where: { slug } });
    if (existing) return existing;
    return prisma.category.create({ data: { slug, name, type, key: slug } });
  };

  const categories = await Promise.all([
    getOrCreateCategory('fantasy', 'Fantasy', CategoryType.genre),
    getOrCreateCategory('bestsellers', 'Bestsellers', CategoryType.collection),
  ]);

  // Ensure default translations for seeded categories (idempotent)
  for (const cat of categories) {
    const existing = await prisma.categoryTranslation.findUnique({
      where: { categoryId_language: { categoryId: cat.id, language: Language.en } },
    });
    if (!existing) {
      await prisma.categoryTranslation.create({
        data: {
          categoryId: cat.id,
          language: Language.en,
          name: cat.name,
          slug: cat.slug,
        },
      });
    }
  }

  // Демо-книга через правовой конвейер: цепочка прав, затем сама книга со ссылками на неё.
  const { intake, profile, review } = await ensureRightsChain(SEED_BOOK_SLUG, {
    title: EN_VERSION.title,
    author: EN_VERSION.author,
    summaryRu: 'Public domain work - author died in 1946',
  });

  // Create Book with rights linkage
  const book = await prisma.book.upsert({
    where: { slug: SEED_BOOK_SLUG },
    update: {
      rightsIntakeId: intake.id,
      currentRightsProfileId: profile.id,
      approvedRightsReviewId: review.id,
      rightsCreatedAt: new Date(),
    },
    create: {
      slug: SEED_BOOK_SLUG,
      rightsIntakeId: intake.id,
      currentRightsProfileId: profile.id,
      approvedRightsReviewId: review.id,
      rightsCreatedAt: new Date(),
      versions: {
        create: [
          {
            // ⚠️ Значения берутся из `VERSION_SEEDS`, а не литералом. Литерал здесь
            // был бы вторым определением той же версии: цикл ниже проходит и по уже
            // существующей en-версии и перекрывает её содержимое значениями из таблицы.
            // Правка заголовка в литерале выглядела бы сделанной при неизменных данных.
            language: EN_VERSION.language,
            title: EN_VERSION.title,
            slug: EN_VERSION.slug,
            author: EN_VERSION.author,
            description: EN_VERSION.description,
            coverImageUrl: 'https://example.com/harry.jpg',
            type: BookType.text,
            isFree: true,
            // LEGACY-267: схема больше не даёт `published` умолчанием — сидовые версии
            // остаются публичными только если это прописано явно.
            status: 'published',
            rightsProfileId: profile.id,
            approvedRightsReviewId: review.id,
            rightsStatus: 'APPROVED',
            rightsAllowedCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
            rightsBlockedCountryCodes: [],
            rightsLicenseRequiredCountryCodes: [],
            rightsPendingCountryCodes: [],
          },
        ],
      },
    },
  });

  // --- Автор, переводы и версии по языкам (LEGACY-294) ---------------------
  //
  // 🔴 Хаб авторов читает `AuthorTranslation`, а буква попадает в указатель
  // только у автора с **опубликованной версией книги на том же языке**:
  // join сводит `bv.language` с `t.language`, а `listPublicLetters` добавляет
  // `HAVING COUNT(DISTINCT bv."bookId") > 0` (`src/modules/author/author.service.ts:134-137`
  // и `:437-448`). Поэтому одних переводов мало - на каждый язык нужна ещё
  // и версия книги, связанная с автором.
  //
  // До 02.09.2026 сид не создавал ни одного `Author` вовсе, и `authorId`
  // у единственной версии оставался `null`. На пустой базе конвейера фронта
  // это давало зелёный прогон e2e без единой проверки: спека хаба выходила
  // ранней веткой «букв нет - проверять нечего» (`LEGACY-294`).
  //
  // ⚠️ Имя на русском - кириллическое намеренно. Латинское «J.K. Rowling»
  // в русском алфавите своей буквы не имеет и уходит в группу `#`, то есть
  // указатель снова оказался бы без единой буквенной ссылки.
  // ⚠️ Одиннадцать записей идут одной транзакцией, как и роли выше. Порознь отказ
  // на середине - например, дубль слага в четвёртой версии - оставляет базу
  // с автором, пятью переводами и половиной версий: шаг сида краснеет, а шаблонная
  // база уже создана, и хаб на недосозданных языках молча пуст. Отката у такого
  // состояния нет, лечится только повторным прогоном.
  await prisma.$transaction(
    async (tx) => {
      const author = await tx.author.upsert({
        where: { id: SEED_AUTHOR_ID },
        update: {},
        create: { id: SEED_AUTHOR_ID, birthDate: '1965-07-31' },
      });

      for (const t of AUTHOR_TRANSLATIONS) {
        await tx.authorTranslation.upsert({
          where: { authorId_language: { authorId: author.id, language: t.language } },
          update: { slug: t.slug, name: t.name },
          create: { authorId: author.id, language: t.language, slug: t.slug, name: t.name },
        });
      }

      for (const v of VERSION_SEEDS) {
        // `upsert` по составному ключу, а не «прочитал - записал»: тем же приёмом,
        // что и цикл по переводам автора выше. Пара `findUnique` + `update`/`create`
        // давала бы вдвое больше обращений внутри открытой транзакции и под
        // `read committed` всё равно ничего не запирала бы - уникальность стережёт
        // `@@unique([bookId, language])`, уже объявленный в схеме.
        //
        // ⚠️ Содержимое обновляется тем же набором полей, что и при создании. Обновляй
        // только связь с автором - и `title`, `slug`, `description` английской записи
        // не применялись бы никогда: en-версия заводится выше, внутри `book.upsert`.
        // Правка заголовка в таблице выглядела бы сделанной при неизменных данных.
        await tx.bookVersion.upsert({
          where: { bookId_language: { bookId: book.id, language: v.language } },
          // ⚠️ Правовые ссылки обновляются вместе с содержимым (`LEGACY-200`). Пока
          // цепочка имела фиксированные id, пересозданная запись получала прежний id
          // и снимок версии оставался верным сам собой. Теперь пересозданное ревью
          // или профиль получают новый id, и версия, оставленная на прежнем снимке,
          // даёт `RIGHTS_REVIEW_SNAPSHOT_OUTDATED`: `canPublish: false` у гейта
          // и 400 на `PATCH /versions/:id/publish` при сохранном на вид сиде.
          update: {
            authorId: author.id,
            author: v.author,
            title: v.title,
            slug: v.slug,
            description: v.description,
            rightsProfileId: profile.id,
            approvedRightsReviewId: review.id,
          },
          create: {
            bookId: book.id,
            authorId: author.id,
            language: v.language,
            title: v.title,
            slug: v.slug,
            author: v.author,
            description: v.description,
            coverImageUrl: 'https://example.com/harry.jpg',
            type: BookType.text,
            isFree: true,
            // LEGACY-267: схема больше не даёт `published` умолчанием — сидовые версии
            // остаются публичными только если это прописано явно.
            status: 'published',
            rightsProfileId: profile.id,
            approvedRightsReviewId: review.id,
            rightsStatus: 'APPROVED',
            rightsAllowedCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
            rightsBlockedCountryCodes: [],
            rightsLicenseRequiredCountryCodes: [],
            rightsPendingCountryCodes: [],
          },
        });
      }
    },
    // ⚠️ `maxWait` задан явно: умолчание - 2000 мс, и это ожидание **свободного
    // соединения**, а не длительность самой транзакции. Сид гоняется вторым процессом
    // поверх уже работающего приложения (повторный прогон в `test/seed-dataset.e2e-spec.ts`,
    // шаг конвейера фронта внутри контейнера), пул при этом урезан. Занятый дольше двух
    // секунд пул дал бы `P2028` - отказ транзакции вместо содержательного результата,
    // и выглядел бы он как поломка сида, а не как теснота пула (`L-020`).
    { timeout: 30_000, maxWait: 15_000 },
  );

  // 🔴 Версия под категории берётся по языку, а не первой строкой связанного списка.
  // До 02.09.2026 версия была одна, и `book.versions[0]` был однозначен. Теперь их пять,
  // а порядок строк в выборке не задан ничем: на втором прогоне сида ветка `update`
  // перекладывает их в куче, и «первой» оказывалась то `fr`, то `pt`. Категории при этом
  // вешались на другую версию каждый раз, `BookCategory` рос до десяти строк вместо двух,
  // а книга появлялась в чужом языковом каталоге. Заодно снят и сам `include`: после этой
  // правки связанный список не читается больше нигде, а тянул он пять строк со всеми
  // колонками, включая правовые снимки.
  const baseVersion = await prisma.bookVersion.findUnique({
    where: { bookId_language: { bookId: book.id, language: Language.en } },
    select: { id: true },
  });
  if (!baseVersion) throw new Error('English book version was not created');

  // Привязка категорий - тем же приёмом, что и версии выше: `upsert` по составному
  // ключу `@@unique([bookVersionId, categoryId])`, а не «прочитал - записал» двумя
  // операторами. Обрыв между двумя `create` оставлял книгу в одной категории из двух,
  // и `GET /en/categories` показывал бы `bestsellers` с нулём книг при уже ненулевом
  // коде возврата сида.
  await prisma.$transaction(
    categories.map((cat) =>
      prisma.bookCategory.upsert({
        where: {
          bookVersionId_categoryId: { bookVersionId: baseVersion.id, categoryId: cat.id },
        },
        update: {},
        create: { bookVersionId: baseVersion.id, categoryId: cat.id },
      }),
    ),
  );

  await seedSeoCatalog();

  console.log('Seeded categories, a sample book with versions and the SEO catalog');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
