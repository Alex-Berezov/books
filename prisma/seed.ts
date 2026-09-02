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

  // Seed Book with Version via Rights Intake Workflow
  // Create Rights Intake
  const intake = await prisma.rightsIntake.upsert({
    where: { id: 'seed-intake-harry-potter' },
    update: {},
    create: {
      id: 'seed-intake-harry-potter',
      candidateTitle: "Harry Potter and the Philosopher's Stone",
      candidateAuthor: 'J.K. Rowling',
      originalLanguage: 'en',
      originalTitle: "Harry Potter and the Philosopher's Stone",
      workflowStatus: 'APPROVED',
      targetLanguages: ['en', 'es', 'fr', 'pt', 'ru'],
      targetCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
      plannedContentTypes: ['text', 'audio'],
      approvedReviewId: 'seed-review-harry-potter',
    },
  });

  // Create Rights Profile
  const profile = await prisma.rightsProfile.upsert({
    where: { id: 'seed-profile-harry-potter' },
    update: {},
    create: {
      id: 'seed-profile-harry-potter',
      rightsIntakeId: intake.id,
      status: 'APPROVED',
      isCurrent: true,
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Public domain work - author died in 1946',
      conclusionRu: 'Approved for publication',
    },
  });

  // Create Rights Review Import
  await prisma.rightsReviewImport.upsert({
    where: { id: 'seed-import-harry-potter' },
    update: {},
    create: {
      id: 'seed-import-harry-potter',
      rightsIntakeId: intake.id,
      importStatus: 'VALIDATED',
      isCurrent: true,
      reportJson: { source: 'seed' },
    },
  });

  // Create Rights Review
  await prisma.rightsReview.upsert({
    where: { id: 'seed-review-harry-potter' },
    update: {},
    create: {
      id: 'seed-review-harry-potter',
      rightsProfileId: profile.id,
      rightsReviewImportId: 'seed-import-harry-potter',
      status: 'HUMAN_APPROVED',
      reviewerType: 'HUMAN',
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Public domain work',
      conclusionRu: 'Approved',
      approvedAt: new Date(),
    },
  });

  // Create Book with rights linkage
  const book = await prisma.book.upsert({
    where: { slug: 'harry-potter' },
    update: {
      rightsIntakeId: intake.id,
      currentRightsProfileId: profile.id,
      approvedRightsReviewId: 'seed-review-harry-potter',
      rightsCreatedAt: new Date(),
    },
    create: {
      slug: 'harry-potter',
      rightsIntakeId: intake.id,
      currentRightsProfileId: profile.id,
      approvedRightsReviewId: 'seed-review-harry-potter',
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
            rightsProfileId: profile.id,
            approvedRightsReviewId: 'seed-review-harry-potter',
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
          update: {
            authorId: author.id,
            author: v.author,
            title: v.title,
            slug: v.slug,
            description: v.description,
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
            rightsProfileId: profile.id,
            approvedRightsReviewId: 'seed-review-harry-potter',
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

  console.log('Seeded categories and a sample book with version');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
