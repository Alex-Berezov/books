import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../src/modules/seo/indexability/taxonomy-indexability.service';
import { computeAnalysisCore } from '../src/modules/book-analysis/book-analysis-core';
import {
  BOOK_ANALYSIS_BLOCK_KEYS,
  type StoredBookAnalysis,
} from '../src/modules/book-analysis/book-analysis-data';
import {
  ANALYSIS_ACCEPTANCE,
  ANALYSIS_ACCEPTANCE_GEO_COUNTRY,
  ANALYSIS_FIELDS,
  ANALYSIS_TEXT_FIELDS,
  analysisAcceptanceBooks,
} from '../prisma/seed-analyses';
import {
  SUMMARY_ACCEPTANCE,
  SUMMARY_ACCEPTANCE_SECTION_MOVED_DATE,
  SUMMARY_ACCEPTANCE_SUMMARY_DATE,
  briefText,
  sectionText,
  sectionTitle,
  summaryAcceptanceBooks,
} from '../prisma/seed-summaries';
import { httpServerOf } from './http-server';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * 🔴 `LEGACY-364`. Сид зовётся **асинхронно**, и это не стилистика.
 *
 * `execSync` блокирует цикл событий на всё время сида — на CI это десятки секунд.
 * Пока цикл стоит, соединения ioredis не обслуживаются: сервер рвёт молчащие,
 * а клиент уходит в переподключение. У связи BullMQ стоит `maxRetriesPerRequest: null`
 * (обязателен для блокирующих операций), поэтому команды на переподключающейся связи
 * ждут **вечно** — и `connection.quit()` в `QueueModule.onModuleDestroy` уже не
 * возвращается. Отсюда `Exceeded timeout of 30000 ms for a hook` в `afterAll` при
 * всех зелёных тестах и живые `TCPSocketWrap` с таймерами ioredis в логе сторожа.
 *
 * Локально отказ не воспроизводится: сид по быстрой машине укладывается в секунды,
 * и связи переживают паузу. Отсюда и разница «локально зелено, на CI красно».
 */
const runSeed = promisify(exec);

/**
 * Что штатный сид (`prisma/seed.ts`) действительно кладёт в пустую базу.
 *
 * 🔴 Заведено 02.09.2026 по `LEGACY-294`. С 28.08.2026 конвейер фронта поднимает
 * бэкенд из образа и гоняет против него набор playwright, а с 02.09.2026 — ещё
 * и сеет базу этим же сидом. До этого сид не создавал ни одного `Author` вовсе:
 * хаб авторов на пустой базе оставался пустым, спека `authors-hub.spec.ts`
 * выходила ранней веткой «букв нет — проверять нечего», и прогон был зелёным,
 * не проверив ни перехода по буквам, ни карточек.
 *
 * Проверяется здесь именно **сид**, а не логика указателя: её держат
 * `authors-hub.e2e-spec.ts` и юниты сервиса на своих фикстурах. Разница
 * существенная — те спеки заводят данные сами и остались бы зелёными,
 * даже если бы сид не клал ничего.
 *
 * ⚠️ Ассерты нижней границей («хотя бы одна буква с непустым счётчиком»), а не
 * точным числом: соседние наборы идут по копии той же шаблонной базы и заводят
 * своих авторов. Точный счётчик краснел бы от чужой фикстуры, а не от поломки сида.
 */
describe('Seeded dataset (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const get = (path: string) => request(httpServerOf(app)).get(path);

  /** Версия книги приёмки по слагу и языку: блоки анализа (F03-4) и пересказа (F04-4). */
  const versionOf = (slug: string, language: Language) =>
    prisma.bookVersion.findFirstOrThrow({
      where: { book: { slug }, language },
      select: {
        id: true,
        _count: { select: { chapters: true, summaries: { where: { hasText: true } } } },
      },
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    await app.init();
  });

  /**
   * 🔴 `LEGACY-364`, разведка по решению арбитра от 03.09.2026. Набор падает
   * не тестом, а этим хуком: `Exceeded timeout of 30000 ms for a hook` при всех
   * зелёных тестах. Две версии причины уже опровергнуты (обе — в теле записи),
   * третья по догадке не пишется: держателя обязан назвать лог прогона.
   *
   * Сторож ничего не отменяет, не закрывает и не спасает — он **только печатает**
   * список живых дескрипторов на 10-й и 20-й секунде ожидания. Оба таймера
   * `unref`, поэтому сами они процесс не держат и порядок разрушения не меняют:
   * `await app.close()` остался единственным действием хука.
   *
   * ⚠️ Таймеры снимаются в `finally`, и это не уборка ради опрятности. `unref`
   * снимает удержание процесса, но не отменяет срабатывание: при быстром
   * закрытии оба всё равно напечатали бы свою строку через 10 и 20 секунд —
   * уже в контексте **следующего файла** того же воркера (`jest-e2e.json`,
   * `maxWorkers: 2`, файлы внутри воркера идут последовательно в одном
   * процессе). В логе зелёного прогона появились бы `app.close() ждёт 10000 мс`,
   * привязанные не к тому запуску, и при следующем реальном отказе разбирать
   * пришлось бы смесь достоверных и ложных срабатываний — то есть инструмент
   * соврал бы ровно там, где на него рассчитывают.
   *
   * ⚠️ `testTimeout` не поднимается и своего потолка хук не получает (`LEGACY-105`):
   * поднятый таймаут прячет голодание вместо того, чтобы его показать.
   * `--detectOpenHandles` тоже не годится — он подразумевает `--runInBand`
   * и снял бы `maxWorkers: 2`, при котором отказ только и наблюдался.
   */
  afterAll(async () => {
    const started = Date.now();
    const probe = (at: number): NodeJS.Timeout =>
      setTimeout(() => {
        console.log(
          `[LEGACY-364] app.close() ждёт ${Date.now() - started} мс, живые дескрипторы:`,
          process.getActiveResourcesInfo(),
        );
      }, at).unref();

    const probes = [probe(10_000), probe(20_000)];

    try {
      await app.close();
    } finally {
      for (const timer of probes) clearTimeout(timer);
    }
  });

  /**
   * Буква попадает в указатель только у автора, у которого есть опубликованная
   * версия книги **на том же языке**: join сводит `bv.language` с `t.language`,
   * а `listPublicLetters` добавляет `HAVING COUNT(DISTINCT bv."bookId") > 0`.
   * Поэтому одних переводов автора мало — нужна ещё и версия книги на том же языке.
   *
   * ⚠️ От разорванной связи `BookVersion.authorId` эта проверка **не** краснеет,
   * и полагаться на неё в этом нельзя: `PUBLISHED_BOOKS_JOIN` сводит автора с книгой
   * по `bv."authorId" = t."authorId" OR bv.author = t.name`, а сид кладёт строку
   * `author`, дословно равную имени перевода. Внешний ключ стережёт следующий тест.
   */
  it.each(['en', 'es', 'fr', 'pt', 'ru'])(
    'сид даёт хабу авторов непустой буквенный указатель на языке %s',
    async (lang) => {
      const res = await get(`/${lang}/authors/letters`).expect(200);
      const letters = (res.body as { items: Array<{ letter: string; count: number }> }).items;

      // ⚠️ Длина ответа здесь ничего не значит и не проверяется: `listPublicLetters`
      // собирает его из `alphabetForLanguage(lang)` и отдаёт весь алфавит целиком
      // даже на пустой базе — 30 записей на `ru`, 27 на `en`. Смысл несёт только
      // непустой счётчик: он и есть след того, что сид положил автора с книгой.
      expect(letters.filter((l) => l.count > 0).length).toBeGreaterThan(0);
    },
  );

  /**
   * 🔴 Внешний ключ `BookVersion.authorId`, а не только совпадение имён.
   *
   * С F02-1 карточки автора, как и указатель, сводят автора с книгой по `authorId`
   * **или** по имени (решение арбитра 14.10.2026, `F02 | F02-1`): иначе авторы, связанные
   * с книгами только по имени, получили бы ноль книг и `noindex`. Поэтому непустой ответ
   * сам по себе ключ больше не стережёт — сид кладёт `author`, дословно равный имени
   * перевода. Здесь у версии на время проверки имя заменяется чужим: найтись она может
   * только по ключу, и потерянный `authorId` из сида (`LEGACY-294`) краснит этот тест.
   */
  it('книги автора находятся по внешнему ключу, а не по совпадению имени', async () => {
    const translation = await prisma.authorTranslation.findFirstOrThrow({
      where: { slug: 'dzhoan-rouling', language: 'ru' },
      select: { authorId: true },
    });
    const version = await prisma.bookVersion.findFirstOrThrow({
      where: { authorId: translation.authorId, language: 'ru', status: 'published' },
      select: { id: true, bookId: true, author: true },
    });

    await prisma.bookVersion.update({
      where: { id: version.id },
      data: { author: 'Имя, которого нет у автора' },
    });
    try {
      const res = await get('/ru/authors/dzhoan-rouling/books/cards?limit=24').expect(200);
      const body = res.body as { items: Array<{ id: string }> };

      expect(body.items.map((i) => i.id)).toContain(version.bookId);
    } finally {
      await prisma.bookVersion.update({
        where: { id: version.id },
        data: { author: version.author },
      });
    }
  });

  /**
   * ⚠️ Русское имя автора в сиде — кириллическое намеренно. Латинское «J.K. Rowling»
   * своей буквы в русском алфавите не имеет и уходит в группу `#`, а на `#` ссылки
   * указатель тоже рисует — то есть проверка выше прошла бы, а перехода по букве
   * на живой странице всё равно не было бы. Здесь это и стережётся.
   */
  it('русский указатель наполнен буквой алфавита, а не только группой #', async () => {
    const res = await get('/ru/authors/letters').expect(200);
    const letters = (res.body as { items: Array<{ letter: string; count: number }> }).items;

    const named = letters.filter((l) => l.count > 0 && l.letter !== '#');
    expect(named.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 Авторы приёмки страницы автора (`F02-5`, `prisma/seed-authors.ts`). Их читает
   * `books-front/e2e/author-page.spec.ts` из образа бэкенда, и без этой проверки поломка сида
   * всплыла бы только в чужом конвейере - 404 или пустым блоком на странице фронта.
   * Проверяется то, на чём стоят критерии приёмки: полный автор с блоками и ссылками на книги
   * каталога, ненайденные слаги без ссылки, минимальный автор без блоков, «старый» без новых
   * полей и автор без перевода на язык страницы - именем без слага.
   */
  it('сид даёт авторов приёмки страницы автора в нужном составе', async () => {
    type Ref = { slug: string } | null;
    type Page = {
      name: string;
      birthDate: string | null;
      biography: string | null;
      tagline: string | null;
      facts: unknown;
      photoUrl: string | null;
      photoCredit: unknown;
      timeline: Array<{ year: number; book: Ref }>;
      influences: { influencedBy: Array<{ name: string; author: Ref }> } | null;
      notableWorks: Array<{ book: Ref }>;
      startHere: Array<{ book: Ref }>;
      awards: unknown[];
      adaptations: Array<{ book: Ref }>;
      funFacts: unknown[];
      sources: unknown[];
      quotes: unknown[];
      faq: unknown[];
      similarAuthors: Array<{ name: string; slug: string | null }>;
    };
    const page = async (lang: string, slug: string) =>
      (await get(`/${lang}/authors/${slug}`).expect(200)).body as Page;

    // Слаги по языкам: Верн, Дюма, Киплинг. Стивенсон переведён только на `en`.
    const slugs = {
      en: ['jules-verne', 'alexandre-dumas', 'rudyard-kipling'],
      ru: ['zhyul-vern', 'aleksandr-dyuma', 'redyard-kipling'],
      es: ['julio-verne', 'alejandro-dumas', 'rudyard-kipling'],
      fr: ['jules-verne', 'alexandre-dumas', 'rudyard-kipling'],
      pt: ['julio-verne', 'alexandre-dumas', 'rudyard-kipling'],
    };
    for (const [lang, [verneSlug, dumasSlug, kiplingSlug]] of Object.entries(slugs)) {
      const verne = await page(lang, verneSlug);
      expect(verne.tagline).toBeTruthy();
      expect(verne.biography).toContain('<h3>');
      expect(verne.facts).not.toBeNull();
      expect(verne.photoUrl).toBeTruthy();
      expect(verne.photoCredit).not.toBeNull();
      // Две книги каталога разрешены в ссылки, первый роман сайта не знает.
      expect(verne.notableWorks.filter((w) => w.book)).toHaveLength(2);
      expect(verne.startHere.filter((s) => s.book)).toHaveLength(2);
      expect(verne.adaptations.filter((a) => a.book)).toHaveLength(2);
      expect(verne.timeline.map((e) => e.year)).toEqual([1828, 1863, 1869, 1872, 1905]);
      expect(verne.timeline.find((e) => e.year === 1863)?.book).toBeNull();
      expect(verne.influences?.influencedBy.map((r) => r.author?.slug ?? null)).toEqual([
        null,
        dumasSlug,
        null,
      ]);
      expect(verne.awards).toHaveLength(1);
      expect(verne.funFacts).toHaveLength(3);
      expect(verne.sources).toHaveLength(2);
      expect(verne.quotes).toHaveLength(1);
      expect(verne.faq).toHaveLength(1);
      // Стивенсон без перевода на язык страницы - имя без слага; `no-such-author` пропущен.
      expect(verne.similarAuthors.map((a) => a.slug)).toEqual([
        dumasSlug,
        kiplingSlug,
        lang === 'en' ? 'robert-louis-stevenson' : null,
      ]);
    }

    const dumas = await page('ru', 'aleksandr-dyuma');
    expect(dumas).toMatchObject({
      birthDate: null,
      biography: null,
      tagline: null,
      facts: null,
      timeline: [],
      quotes: [],
      faq: [],
      similarAuthors: [],
    });

    const kipling = await page('ru', 'redyard-kipling');
    expect(kipling.biography).not.toContain('<h3>');
    expect(kipling.quotes).toHaveLength(1);
    expect(kipling.faq).toHaveLength(1);
    expect(kipling.tagline).toBeNull();
    expect(kipling.timeline).toEqual([]);
  });

  /**
   * 🔴 Сид здесь гоняется **второй раз**, своим вызовом, а не полагается на прогон
   * харнесса. Разница принципиальная: `test/setup-e2e.ts:99-106` зовёт `prisma db seed`
   * ровно один раз по шаблонной базе, и `deploy.yml` тоже сеет один раз. Проверка
   * «после одного прогона запись одна» верна и для кода без `upsert` вовсе — то есть
   * не краснеет от возврата дефекта и посадкой не является.
   *
   * Идемпотентность нужна по-настоящему: `deploy.yml` сеет `books_test` поверх уже
   * заполненной базы, а конвейер фронта — поверх своей после `migrate deploy`. Потеряй
   * сид `upsert` — второй прогон упадёт на `@@unique([language, slug])` перевода автора,
   * и заметить это было бы негде.
   *
   * ⚠️ Сид пишется в базу **этого воркера**: `test/setup-after-env-e2e.ts:35` подменяет
   * `process.env.DATABASE_URL` на его копию шаблона. Соседние наборы идут по своим копиям
   * и этим прогоном не задеваются.
   */
  it('повторный прогон сида не плодит ни авторов, ни привязок к категориям', async () => {
    const before = await prisma.bookCategory.findMany({
      where: { bookVersion: { book: { slug: 'harry-potter' } } },
      select: { bookVersionId: true, categoryId: true },
    });
    expect(before.length).toBeGreaterThan(0);

    // 🔴 `LEGACY-200`. С 08.09.2026 цепочка прав не имеет литеральных `id`, и опорой
    // идемпотентности стали ссылки самой книги, а не фиксированный ключ `upsert`.
    // У четырёх правовых моделей нет ни одного уникального ограничения, поэтому
    // регрессия в условии переиспользования не упадёт на базе — она **молча**
    // заведёт вторую цепочку, осиротив первую. Ловится только счётом строк.
    const rightsBefore = await prisma.book.findUnique({
      where: { slug: 'harry-potter' },
      select: {
        rightsIntakeId: true,
        currentRightsProfileId: true,
        approvedRightsReviewId: true,
      },
    });
    expect(rightsBefore?.rightsIntakeId).toBeDefined();
    expect(rightsBefore?.currentRightsProfileId).toBeDefined();
    expect(rightsBefore?.approvedRightsReviewId).toBeDefined();

    // 🔴 Каталог `Q1` проверяется вместе с демо-книгой, а не отдельным тестом: сид гоняется
    // здесь один раз, и вторая посадка на идемпотентность стоила бы второго прогона.
    // Считаются привязки всех пяти каталожных книг: `upsert` по составному ключу защищает
    // от дублей только пока ключ в `where` тот же самый, а опечатка в нём (перепутанные
    // `bookVersionId`/`categoryId`) удвоила бы строки на каждом пересеве - и в конвейере
    // фронта, где сид гоняется поверх уже засеянной базы, и в `deploy.yml`.
    const catalogSlugs = [
      'treasure-island',
      'the-jungle-book',
      'around-the-world-in-eighty-days',
      'the-three-musketeers',
      'twenty-thousand-leagues-under-the-sea',
    ];
    const catalogWhere = { bookVersion: { book: { slug: { in: catalogSlugs } } } };
    const catalogCategoriesBefore = await prisma.bookCategory.count({ where: catalogWhere });
    const catalogTagsBefore = await prisma.bookTag.count({ where: catalogWhere });
    // Пять книг x пять языков x три категории и один тег. Точные числа, а не нижняя
    // граница: это собственные книги сида, соседние наборы их не заводят.
    expect(catalogCategoriesBefore).toBe(75);
    expect(catalogTagsBefore).toBe(25);

    // Переводы авторов сида, в том числе авторов приёмки страницы автора (F02-5): `upsert`
    // по `(authorId, language)`, второй прогон не добавляет ни одного.
    const seedAuthorsWhere = { authorId: { startsWith: 'seed-author-' } };
    const seedTranslationsBefore = await prisma.authorTranslation.count({
      where: seedAuthorsWhere,
    });
    // Точное число, а не нижняя граница: префикс `seed-author-` у id только у авторов сида.
    // Роулинг 5, Верн 5, Дюма 5, Киплинг 5, Стивенсон 1 (`prisma/seed-authors.ts`).
    expect(seedTranslationsBefore).toBe(21);
    const authorOfCatalog = () =>
      prisma.bookVersion.findMany({
        where: { book: { slug: { in: catalogSlugs } } },
        select: { id: true, authorId: true, book: { select: { slug: true } } },
        orderBy: { id: 'asc' },
      });
    const catalogAuthorsBefore = await authorOfCatalog();
    expect(catalogAuthorsBefore).toHaveLength(25);
    // Автор каждой книги - точно, по книге: все пять языковых версий у своего автора.
    const expectedOwner: Record<string, string> = {
      'treasure-island': 'seed-author-robert-louis-stevenson',
      'the-jungle-book': 'seed-author-rudyard-kipling',
      'around-the-world-in-eighty-days': 'seed-author-jules-verne',
      'the-three-musketeers': 'seed-author-alexandre-dumas',
      'twenty-thousand-leagues-under-the-sea': 'seed-author-jules-verne',
    };
    expect(catalogAuthorsBefore.filter((v) => v.authorId !== expectedOwner[v.book.slug])).toEqual(
      [],
    );

    const intakesBefore = await prisma.rightsIntake.count();
    const profilesBefore = await prisma.rightsProfile.count();
    const reviewsBefore = await prisma.rightsReview.count();
    const importsBefore = await prisma.rightsReviewImport.count();

    // Минимальному автору «импортировали» блок между прогонами: повторный сид обязан вернуть
    // его к заданному составу (`EMPTY_PAGE` в `prisma/seed-authors.ts`), иначе приёмка
    // «минимальный автор без блоков» на непервой базе краснеет не от кода.
    await prisma.authorTranslation.update({
      where: {
        authorId_language: { authorId: 'seed-author-alexandre-dumas', language: 'ru' },
      },
      data: { tagline: 'Импортировано руками', timeline: [{ year: 1844, text: 'x' }] },
    });

    const stampBefore = await prisma.bookVersion.findFirst({
      where: { book: { slug: 'harry-potter' }, language: 'en' },
      select: { updatedAt: true },
    });

    // ⚠️ `timeout` остаётся: зависший сид иначе висел бы до лимита job'а. Теперь
    // он работает вместе с таймаутом теста (180 с ниже), а не вместо него —
    // асинхронный вызов цикл событий не держит.
    await runSeed('npx prisma db seed', {
      env: { ...process.env },
      timeout: 120_000,
    });

    // 🔴 Положительный контроль: без него тест не отличает «сид отработал по базе
    // этого воркера» от «сид ушёл в другую базу». Раскладка баз по воркерам уже один
    // раз не доезжала до дочернего процесса; перестань `DATABASE_URL` передаваться —
    // сид ушёл бы в дев-базу из `.env`, а спека осталась бы зелёной, и посадка
    // на неидемпотентный сид краснеть перестала бы.
    const stampAfter = await prisma.bookVersion.findFirst({
      where: { book: { slug: 'harry-potter' }, language: 'en' },
      select: { updatedAt: true },
    });
    expect(stampBefore?.updatedAt).toBeDefined();
    expect(stampAfter?.updatedAt.getTime()).toBeGreaterThan(stampBefore!.updatedAt.getTime());

    const res = await get(`/ru/authors?search=${encodeURIComponent('Роулинг')}&limit=100`).expect(
      200,
    );
    const body = res.body as { items: Array<{ name: string }> };
    expect(body.items.filter((a) => a.name === 'Джоан Роулинг')).toHaveLength(1);
    expect(await prisma.authorTranslation.count({ where: seedAuthorsWhere })).toBe(
      seedTranslationsBefore,
    );
    expect(await authorOfCatalog()).toEqual(catalogAuthorsBefore);
    expect(
      await prisma.authorTranslation.findUnique({
        where: {
          authorId_language: { authorId: 'seed-author-alexandre-dumas', language: 'ru' },
        },
        select: { tagline: true, timeline: true },
      }),
    ).toEqual({ tagline: null, timeline: null });

    // 🔴 Второй прогон не должен ни добавлять привязок, ни перевешивать их на другую
    // языковую версию. До 02.09.2026 версия у книги была одна, и `book.versions[0]`
    // был однозначен; с пятью версиями `include: { versions: true }` порядка не задаёт,
    // и категории уезжали то на `fr`, то на `pt`, а `BookCategory` рос до десяти строк.
    const after = await prisma.bookCategory.findMany({
      where: { bookVersion: { book: { slug: 'harry-potter' } } },
      select: { bookVersionId: true, categoryId: true },
    });
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((r) => r.bookVersionId)).size).toBe(1);

    const carrier = await prisma.bookVersion.findUnique({
      where: { id: after[0].bookVersionId },
      select: { language: true },
    });
    expect(carrier?.language).toBe('en');

    // 🔴 `LEGACY-200`. Проверяются обе половины: цепочка та же самая (ссылки книги
    // не переехали на новые строки) и новых строк не появилось вовсе. Одного счётчика
    // мало — сид мог бы создать новую цепочку и перевесить книгу на неё, оставив
    // старую висеть; одних ссылок мало — они остались бы прежними и в случае, когда
    // рядом заведена вторая, никем не используемая цепочка.
    const rightsAfter = await prisma.book.findUnique({
      where: { slug: 'harry-potter' },
      select: {
        rightsIntakeId: true,
        currentRightsProfileId: true,
        approvedRightsReviewId: true,
      },
    });
    expect(rightsAfter).toEqual(rightsBefore);

    expect(await prisma.rightsIntake.count()).toBe(intakesBefore);
    expect(await prisma.rightsProfile.count()).toBe(profilesBefore);
    expect(await prisma.rightsReview.count()).toBe(reviewsBefore);
    expect(await prisma.rightsReviewImport.count()).toBe(importsBefore);

    expect(await prisma.bookCategory.count({ where: catalogWhere })).toBe(catalogCategoriesBefore);
    expect(await prisma.bookTag.count({ where: catalogWhere })).toBe(catalogTagsBefore);
    // Каждая каталожная книга осталась при своей цепочке: счётчики правовых моделей выше
    // уже проверены, но они не сказали бы, что ссылки шести книг не съехали на одну.
    const catalogBooks = await prisma.book.findMany({
      where: { slug: { in: catalogSlugs } },
      select: { slug: true, rightsIntakeId: true, currentRightsProfileId: true },
    });
    expect(catalogBooks).toHaveLength(catalogSlugs.length);
    expect(new Set(catalogBooks.map((b) => b.rightsIntakeId)).size).toBe(catalogSlugs.length);
    expect(new Set(catalogBooks.map((b) => b.currentRightsProfileId)).size).toBe(
      catalogSlugs.length,
    );
  }, 180_000);

  /**
   * Что сид кладёт под гейт SEO на пути PR (`Q1`, `LEGACY-016`).
   *
   * 🔴 Смоук-прогон `books-front/scripts/seo-audit.mjs` требует, чтобы каждый из четырёх
   * хабов (`categories`, `genres`, `collections`, `tags`) отрисовал в серверном HTML
   * хотя бы одну ссылку на термин. Хаб рисует только **линкуемый** термин, а линкуемость
   * (`books-front/lib/seo/taxonomy-linkable.ts:55-74`) требует одновременно видимости,
   * непустого счётчика книг на языке страницы и `autoIndexable`. До 08.09.2026 сид давал
   * две категории с переводом только на `en` и ни одного тега — четыре хаба из пяти
   * проверяемых оказывались пусты, и гейт краснел бы на составе сида, а не на регрессии.
   *
   * Проверяется здесь именно **сид**, а не логика листингов: их держат свои спеки
   * на своих фикстурах и остались бы зелёными, даже если бы сид не клал ничего.
   *
   * ⚠️ Ассерты нижней границей, а не точным числом: соседние наборы идут по копии той же
   * шаблонной базы и заводят свои термины.
   */
  describe.each(['en', 'es', 'fr', 'pt', 'ru'])('каталог для гейта SEO, язык %s', (lang) => {
    /**
     * 🔴 Условие линкуемости повторяет фронтовое целиком
     * (`books-front/lib/seo/taxonomy-linkable.ts:55-74`): видимость, индексируемость,
     * непустой счётчик книг на языке страницы и `autoIndexable`. Плюс перевод на этот язык -
     * его в предикате нет, но без него хаб ссылки не нарисует, потому что берёт из перевода
     * адрес; ассерт без этого условия зеленел бы на сиде без переводов.
     *
     * ⚠️ `isVisible` и `indexable` проверяются, хотя сид их не задаёт и живёт на умолчаниях
     * схемы: оба поля правятся из админки (`category.service.ts:195-196`), и скрытый там
     * термин оставил бы спеку зелёной при пустом хабе.
     */
    const linkableIn = (
      items: Array<{
        key?: string;
        booksCount?: number;
        autoIndexable?: boolean;
        indexable?: boolean;
        isVisible?: boolean;
        translations?: Array<{ language: string; slug: string }>;
      }>,
    ) =>
      items.filter(
        (t) =>
          t.isVisible !== false &&
          t.indexable !== false &&
          (t.booksCount ?? 0) > 0 &&
          t.autoIndexable === true &&
          Boolean(t.translations?.find((tr) => tr.language === lang)?.slug),
      );

    /**
     * 🔴 Дерево, а не плоский список: хабы читают именно `GET /categories/tree?lang=&type=`
     * (`books-front/app/[lang]/categories/page.tsx:46` и соседние, через
     * `books-front/api/endpoints/public.ts:448`). Спека на `GET /:lang/categories`
     * проверяла бы **вторую** проекцию языка: `CategoryService.list` и `getTree` держат
     * её двумя копиями кода (`category.service.ts:157-172` и `:989-1005`), и разъехавшись,
     * они оставили бы спеку зелёной при пустом хабе - тот же класс отказа, что `LEGACY-294`.
     */
    type TreeNode = Parameters<typeof linkableIn>[0][number] & { children?: TreeNode[] };
    const flatten = (nodes: TreeNode[]): TreeNode[] =>
      nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);

    /**
     * ⚠️ Ключ термина проверяется поимённо, а не «хоть один линкуемый». Старые `fantasy`
     * и `bestsellers` имеют `en`-перевод и книгу от демо-книги, поэтому снятый вызов
     * `seedSeoCatalog()` оставил бы `en/genre` и `en/collection` зелёными, а посадка
     * краснела бы 18 случаями из 20 вместо всех двадцати.
     */
    it.each([
      ['category', 'world-literature'],
      ['genre', 'adventure'],
      ['collection', 'school-reading'],
    ])('сид даёт хабу %s линкуемый термин %s', async (type, key) => {
      const res = await get(`/categories/tree?lang=${lang}&type=${type}`).expect(200);

      expect(
        linkableIn(flatten((res.body as { items: TreeNode[] }).items)).map((t) => t.key),
      ).toContain(key);
    });

    it('сид даёт хабу tags линкуемый термин classics', async () => {
      const res = await get(`/${lang}/tags?limit=100`).expect(200);
      const body = res.body as { items: Parameters<typeof linkableIn>[0] };

      expect(linkableIn(body.items).map((t) => t.key)).toContain('classics');
    });
  });

  /**
   * 🔴 Индексируемость обязана быть **заслужена данными**, а не унаследована умолчанием.
   *
   * `CategoryTranslation.autoIndexable` и `TagTranslation.autoIndexable` объявлены
   * `@default(true)` (`prisma/schema.prisma:750,791`), и сид, пишущий переводы напрямую,
   * получает `true` не написав ни строки. Термин с одной книгой выглядел бы в хабе так же,
   * как термин с пятью, — ровно до первого вызова пересчёта: `resolveAutoIndexable`
   * закрывает термин при `bookCount <= 2` (`seo/indexability/taxonomyIndexability.ts:19-37`),
   * и хабы опустели бы молча, уже после мержа, на первой же публикации версии через админку
   * (`book-version.service.ts:1203`).
   *
   * Поэтому тест не читает состояние, а **вызывает пересчёт** и смотрит, что термины
   * сида его пережили: пять опубликованных версий на язык — это и есть порог открытия.
   */
  it('пересчёт индексируемости оставляет термины сида открытыми', async () => {
    const indexability = app.get(TaxonomyIndexabilityService);

    const categories = await prisma.category.findMany({
      where: { key: { in: ['world-literature', 'adventure', 'school-reading'] } },
      select: { id: true, key: true },
    });
    expect(categories).toHaveLength(3);

    const tag = await prisma.tag.findUnique({ where: { key: 'classics' }, select: { id: true } });
    expect(tag).not.toBeNull();

    // 🔴 Сначала — состояние, которое оставил сам сид. `bookCount` он пишет сам
    // (пересчёт из сида не зовётся), а карта сайта строит из этого поля кластер
    // `hreflang`: нулевой кэш оставил бы все адреса терминов без `xhtml:link`,
    // и проверка кластера не могла бы покраснеть.
    const seededCategoryCounts = await prisma.categoryTranslation.findMany({
      where: { categoryId: { in: categories.map((c) => c.id) } },
      select: { bookCount: true },
    });
    expect(seededCategoryCounts).toHaveLength(15);
    for (const t of seededCategoryCounts) expect(t.bookCount).toBeGreaterThanOrEqual(5);

    const seededTagCounts = await prisma.tagTranslation.findMany({
      where: { tagId: tag!.id },
      select: { bookCount: true },
    });
    expect(seededTagCounts).toHaveLength(5);
    for (const t of seededTagCounts) expect(t.bookCount).toBeGreaterThanOrEqual(5);

    await indexability.recomputeForTerms(
      categories.map((c) => c.id),
      [tag!.id],
    );

    const categoryTranslations = await prisma.categoryTranslation.findMany({
      where: { categoryId: { in: categories.map((c) => c.id) } },
      select: {
        language: true,
        autoIndexable: true,
        bookCount: true,
        category: { select: { key: true } },
      },
    });
    // Пять языков на каждую из трёх категорий — недосозданный язык виден по длине.
    expect(categoryTranslations).toHaveLength(15);
    for (const t of categoryTranslations) {
      expect({ term: t.category.key, lang: t.language, open: t.autoIndexable }).toEqual({
        term: t.category.key,
        lang: t.language,
        open: true,
      });
      expect(t.bookCount).toBeGreaterThanOrEqual(5);
    }

    const tagTranslations = await prisma.tagTranslation.findMany({
      where: { tagId: tag!.id },
      select: { language: true, autoIndexable: true, bookCount: true },
    });
    expect(tagTranslations).toHaveLength(5);
    for (const t of tagTranslations) {
      expect({ lang: t.language, open: t.autoIndexable }).toEqual({ lang: t.language, open: true });
      expect(t.bookCount).toBeGreaterThanOrEqual(5);
    }
  }, 60_000);

  /**
   * F03-4, решение арбитра `F03 | F03-4` (В1): книги приёмки анализа пишутся сидом мимо DTO,
   * а `hasCore` - литералом (функция ядра в `src/`, сиду в образе недоступна). Здесь литерал
   * сверяется с `computeAnalysisCore` и с ядром, которое насчитал бы импорт (`PUT ?dryRun=true`),
   * а копия списка полей - с `BOOK_ANALYSIS_BLOCK_KEYS`: иначе сид засеял бы запись, которую
   * импорт отбил бы, страницу с ложным ядром или не сбросил бы новый блок при повторном прогоне.
   */
  describe('книги приёмки анализа (F03-4)', () => {
    const books = analysisAcceptanceBooks();
    let adminAccess: string;
    const nodeEnvBefore = process.env.NODE_ENV;

    afterAll(() => {
      // Присваивание `undefined` дало бы строку "undefined": незаданную переменную снимаем.
      if (nodeEnvBefore === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnvBefore;
    });

    beforeAll(async () => {
      // `X-Geo-Country` читается только при NODE_ENV=test (LEGACY-208), а ConfigService берёт
      // его из окружения на каждый запрос: выставляется на этот блок и возвращается после него.
      process.env.NODE_ENV = 'test';
      const email = `seed_analysis_${Date.now()}@example.com`;
      const reg = await request(httpServerOf(app))
        .post('/auth/register')
        .send({ email, password: 'password123' })
        .expect(201);
      adminAccess = (reg.body as { accessToken: string }).accessToken;
      await grantStaffRoles(app, email);
    });

    it('копия полей анализа в сиде = блоки импорта, текст и Json по колонкам базы', async () => {
      expect([...ANALYSIS_FIELDS].sort()).toEqual([...BOOK_ANALYSIS_BLOCK_KEYS].sort());
      // В полном анализе заполнены все поля: тип значения из базы и есть тип колонки.
      const full = await versionOf(ANALYSIS_ACCEPTANCE.full, Language.en);
      const row = await prisma.bookAnalysis.findUniqueOrThrow({
        where: { bookVersionId: full.id },
      });
      for (const field of ANALYSIS_FIELDS) {
        const value: unknown = row[field];
        expect({ field, text: typeof value === 'string' }).toEqual({
          field,
          text: ANALYSIS_TEXT_FIELDS.has(field),
        });
        expect({ field, empty: value === null }).toEqual({ field, empty: false });
      }
    });

    it.each(
      books.flatMap((b) =>
        b.versions.filter((v) => v.analysis).map((v) => [b.slug, v.language, v] as const),
      ),
    )('%s/%s: ядро литералом = computeAnalysisCore = ядро импорта', async (slug, language, v) => {
      const version = await versionOf(slug, language);
      const row = await prisma.bookAnalysis.findUniqueOrThrow({
        where: { bookVersionId: version.id },
      });
      expect(row.hasCore).toBe(v.analysis!.hasCore);
      expect(computeAnalysisCore(row as unknown as StoredBookAnalysis).hasCore).toBe(row.hasCore);
      expect(version._count.chapters).toBe(v.chapters.length);
      expect(version._count.summaries).toBe(v.summary ? 1 : 0);

      const dry = await request(httpServerOf(app))
        .put(`/versions/${version.id}/analysis?dryRun=true`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ language, ...v.analysis!.blocks })
        .expect(200);
      const body = dry.body as { hasCore: boolean; warnings: Array<{ code: string }> };
      expect(body.hasCore).toBe(v.analysis!.hasCore);
      // Импорт сливает тело с записью сида, поэтому ядро считается и по одним блокам набора.
      expect(computeAnalysisCore(v.analysis!.blocks as StoredBookAnalysis).hasCore).toBe(
        v.analysis!.hasCore,
      );
      // Ссылки на главы попадают в главы сида; у версии без глав - все мимо, это и проверяется.
      const missingChapters = body.warnings.filter((w) => w.code === 'chapter_not_found');
      expect(missingChapters.length > 0).toBe(v.chapters.length === 0);
    });

    it('повторный сид приводит книги приёмки к набору: лишнее снято, правка сброшена', async () => {
      const slugs = books.map((b) => b.slug);
      const versions = books.flatMap((b) => b.versions);
      const where = { bookVersion: { book: { slug: { in: slugs } } } };

      // «Грязь» поверх засеянного: глава и пересказ вне набора, лишнее гео-правило, ручная правка
      // анализа и выключенное правило набора.
      const minimal = await versionOf(ANALYSIS_ACCEPTANCE.minimal, Language.en);
      const twoLangs = await versionOf(ANALYSIS_ACCEPTANCE.twoLangs, Language.en);
      const full = await versionOf(ANALYSIS_ACCEPTANCE.full, Language.en);
      await prisma.chapter.create({
        data: { bookVersionId: minimal.id, number: 99, title: 'stray', content: 'stray' },
      });
      await prisma.bookSummary.create({
        data: { bookVersionId: twoLangs.id, summary: '<p>stray</p>', hasText: true },
      });
      await prisma.geoBlockRule.create({
        data: {
          bookVersionId: twoLangs.id,
          scope: 'TEXT_READER',
          countryCode: 'US',
          accessPolicy: 'BLOCK',
          sourceFinalStatus: 'BLOCKED',
          isActive: true,
          generatedFrom: 'E2E_TEST',
        },
      });
      // Лишнее правило на версии с правилом набора - ветка «кроме правила набора».
      await prisma.geoBlockRule.create({
        data: {
          bookVersionId: full.id,
          scope: 'TEXT_READER',
          countryCode: 'US',
          accessPolicy: 'BLOCK',
          sourceFinalStatus: 'BLOCKED',
          isActive: true,
          generatedFrom: 'E2E_TEST',
        },
      });
      await prisma.bookAnalysis.update({
        where: { bookVersionId: minimal.id },
        data: { context: 'stray' },
      });
      const twoLangsEs = await versionOf(ANALYSIS_ACCEPTANCE.twoLangs, Language.es);
      await prisma.bookAnalysis.create({ data: { bookVersionId: twoLangsEs.id, hasCore: true } });
      const minimalBook = await prisma.book.findUniqueOrThrow({
        where: { slug: ANALYSIS_ACCEPTANCE.minimal },
        select: { id: true },
      });
      const strayVersion = await prisma.bookVersion.create({
        data: {
          bookId: minimalBook.id,
          language: Language.fr,
          title: 'stray',
          slug: ANALYSIS_ACCEPTANCE.minimal,
          author: 'stray',
          description: 'stray',
          coverImageUrl: 'https://example.com/cover.jpg',
          type: 'text',
          isFree: true,
        },
        select: { id: true },
      });
      await prisma.geoBlockRule.updateMany({
        where: { bookVersionId: full.id },
        data: { isActive: false, reasonRu: 'stray' },
      });
      const fullBook = await prisma.book.findUniqueOrThrow({
        where: { slug: ANALYSIS_ACCEPTANCE.full },
        select: { id: true },
      });
      await prisma.geoBlockRule.create({
        data: {
          bookId: fullBook.id,
          scope: 'ENTIRE_BOOK',
          countryCode: ANALYSIS_ACCEPTANCE_GEO_COUNTRY,
          accessPolicy: 'BLOCK',
          sourceFinalStatus: 'BLOCKED',
          isActive: true,
          generatedFrom: 'E2E_TEST',
        },
      });

      await runSeed('npx prisma db seed', { env: { ...process.env }, timeout: 120_000 });

      expect(
        await prisma.geoBlockRule.count({ where: { bookId: fullBook.id, bookVersionId: null } }),
      ).toBe(0);

      const minimalAnalysis = await prisma.bookAnalysis.findUniqueOrThrow({
        where: { bookVersionId: minimal.id },
        select: { context: true },
      });
      expect(minimalAnalysis.context).toBeNull();
      expect(await prisma.bookVersion.count({ where: { id: strayVersion.id } })).toBe(0);
      expect(await prisma.bookAnalysis.count({ where: { bookVersionId: twoLangsEs.id } })).toBe(0);
      const rules = await prisma.geoBlockRule.findMany({
        where,
        select: { bookVersionId: true, countryCode: true, isActive: true, reasonRu: true },
      });
      expect(rules).toEqual([
        {
          bookVersionId: full.id,
          countryCode: ANALYSIS_ACCEPTANCE_GEO_COUNTRY,
          isActive: true,
          reasonRu: null,
        },
      ]);
      expect(await prisma.chapter.count({ where })).toBe(
        versions.reduce((n, v) => n + v.chapters.length, 0),
      );
      expect(await prisma.bookAnalysis.count({ where })).toBe(
        versions.filter((v) => v.analysis).length,
      );
      expect(await prisma.bookSummary.count({ where })).toBe(
        versions.filter((v) => v.summary).length,
      );
    }, 180_000);

    it('публичные ответы: счётчик анализов, номера глав, гео-правило читалки', async () => {
      const analysesOf = async (lang: Language, slug: string) => {
        const res = await get(`/${lang}/books/${slug}/overview`).expect(200);
        const { versions } = res.body as {
          versions: Array<{ language: string; _count: { analyses: number } }>;
        };
        return versions.find((x) => x.language === lang)?._count.analyses;
      };
      const counts = await Promise.all(
        books.flatMap((b) =>
          b.versions.map(async (v) => ({
            key: `${b.slug}/${v.language}`,
            count: await analysesOf(v.language, b.slug),
          })),
        ),
      );
      expect(counts).toEqual(
        books.flatMap((b) =>
          b.versions.map((v) => ({
            key: `${b.slug}/${v.language}`,
            count: v.analysis?.hasCore ? 1 : 0,
          })),
        ),
      );

      const chapterNumbersOf = async (slug: string, language: Language) => {
        const { id } = await versionOf(slug, language);
        const res = await get(`/versions/${id}/analysis`).expect(200);
        return (res.body as { chapterNumbers: number[] }).chapterNumbers;
      };
      expect(await chapterNumbersOf(ANALYSIS_ACCEPTANCE.full, Language.en)).toEqual([1, 2, 3, 4]);
      expect(await chapterNumbersOf(ANALYSIS_ACCEPTANCE.minimal, Language.en)).toEqual([1, 2, 3]);
      expect(await chapterNumbersOf(ANALYSIS_ACCEPTANCE.noChapters, Language.en)).toEqual([]);

      // Читалка `en` закрыта в стране правила и только там; анализ там же открыт (D7).
      const full = await versionOf(ANALYSIS_ACCEPTANCE.full, Language.en);
      const fullRu = await versionOf(ANALYSIS_ACCEPTANCE.full, Language.ru);
      const chapters = (id: string, country: string) =>
        get(`/versions/${id}/chapters`).set('X-Geo-Country', country);
      await chapters(full.id, ANALYSIS_ACCEPTANCE_GEO_COUNTRY).expect(451);
      await chapters(full.id, 'US').expect(200);
      await chapters(fullRu.id, ANALYSIS_ACCEPTANCE_GEO_COUNTRY).expect(200);
      // Страна неизвестна при активном правиле - отказ (fail-closed, geo-block-rule.service.ts):
      // так читалку `en` видит и CI фронта, где страна до бэкенда не доходит.
      await get(`/versions/${full.id}/chapters`).expect(451);
      await get(`/versions/${full.id}/analysis`)
        .set('X-Geo-Country', ANALYSIS_ACCEPTANCE_GEO_COUNTRY)
        .expect(200);
    });
  });

  describe('книги приёмки вариантов пересказа (F04-4)', () => {
    const books = summaryAcceptanceBooks();
    const published = books.flatMap((b) =>
      b.versions.filter((v) => v.status !== 'draft').map((v) => [b.slug, v.language, v] as const),
    );

    it.each(published)(
      '%s/%s: счётчики обзора, очень краткий, разделы и даты как в наборе',
      async (slug, language, v) => {
        const overview = await get(`/${language}/books/${v.slug ?? slug}/overview`).expect(200);
        const { versions } = overview.body as {
          versions: Array<{
            language: string;
            _count: { summaries: number; summarySections: number };
          }>;
        };
        const count = versions.find((x) => x.language === language)!._count;
        expect(count.summaries).toBe(v.summary ? 1 : 0);
        // Разделы без полного пересказа не публикуются (`product.md` §3).
        expect(count.summarySections).toBe(v.summary ? v.sections.length : 0);

        const { id } = await versionOf(slug, language);
        if (v.summary) {
          const summary = await get(`/versions/${id}/summary`).expect(200);
          const body = summary.body as {
            brief: string | null;
            briefHasText: boolean;
            updatedAt: string;
          };
          expect(body.briefHasText).toBe(v.brief);
          expect(body.brief).toBe(v.brief ? briefText(language) : null);
          expect(body.updatedAt).toBe(SUMMARY_ACCEPTANCE_SUMMARY_DATE.toISOString());
        }

        const list = await get(`/versions/${id}/summary-sections`).expect(200);
        const sections = (list.body as { sections: Array<{ number: number; title: string }> })
          .sections;
        expect(sections.map((s) => [s.number, s.title])).toEqual(
          v.summary ? v.sections.map((_, i) => [i + 1, sectionTitle(language, i + 1)]) : [],
        );
        for (const [index, seeded] of v.sections.entries()) {
          const number = index + 1;
          const page = get(`/versions/${id}/summary-sections/${number}`);
          if (!v.summary) {
            await page.expect(404);
            continue;
          }
          const res = await page.expect(200);
          const body = res.body as {
            text: string;
            readerChapter: number | null;
            readerChapterExists: boolean;
            contentDate: string;
          };
          expect(body.text).toBe(sectionText(language, number));
          expect(body.readerChapter).toBe(seeded.readerChapter);
          expect(body.readerChapterExists).toBe(
            seeded.readerChapter !== null && v.chapters.includes(seeded.readerChapter),
          );
          // Дата адреса - позднейшая из правки текста и смены номера (`tech.md` T6).
          const edited = (seeded.updatedAt ?? SUMMARY_ACCEPTANCE_SUMMARY_DATE).getTime();
          expect(new Date(body.contentDate).getTime()).toBe(
            Math.max(edited, seeded.movedAt?.getTime() ?? edited),
          );
        }
      },
    );

    it('черновик скрыт от анонима: ни обзора, ни разделов', async () => {
      const { id } = await versionOf(SUMMARY_ACCEPTANCE.draft, Language.en);
      const overview = await get(`/en/books/${SUMMARY_ACCEPTANCE.draft}/overview`).expect(200);
      expect((overview.body as { versions: unknown[] }).versions).toEqual([]);
      await get(`/versions/${id}/summary-sections`).expect(404);
      await get(`/versions/${id}/summary-sections/1`).expect(404);
      await get(`/versions/${id}/summary`).expect(404);
    });

    it('карта сайта разделов: только открытые версии со своими номерами и датой адреса', async () => {
      type Item = { slug: string; sections: Array<{ number: number; lastmod: string }> };
      const items: Item[] = [];
      for (let page = 1; ; page += 1) {
        const res = await get('/en/summary-sections/sitemap')
          .query({ page, limit: 50 })
          .expect(200);
        const body = res.body as { items: Item[]; pagination: { totalPages: number } };
        items.push(...body.items);
        if (page >= body.pagination.totalPages) break;
      }
      const bySlug = new Map(items.map((item) => [item.slug, item.sections]));
      // Слаг версии равен слагу книги приёмки; `noindex`, черновик, без полного, без разделов - нет.
      for (const present of [
        SUMMARY_ACCEPTANCE.full,
        SUMMARY_ACCEPTANCE.sectionsOnly,
        SUMMARY_ACCEPTANCE.noChapters,
      ]) {
        expect([present, bySlug.has(present)]).toEqual([present, true]);
      }
      for (const absent of [
        SUMMARY_ACCEPTANCE.onlyFull,
        SUMMARY_ACCEPTANCE.briefOnly,
        SUMMARY_ACCEPTANCE.noFull,
        SUMMARY_ACCEPTANCE.noindex,
        SUMMARY_ACCEPTANCE.draft,
      ]) {
        expect([absent, bySlug.has(absent)]).toEqual([absent, false]);
      }
      const full = bySlug.get(SUMMARY_ACCEPTANCE.full)!;
      expect(full.map((s) => s.number)).toEqual([1, 2, 3]);
      expect(new Date(full[1].lastmod).getTime()).toBe(
        SUMMARY_ACCEPTANCE_SECTION_MOVED_DATE.getTime(),
      );
    });

    it('повторный сид приводит книги приёмки к набору: лишнее снято, правка сброшена', async () => {
      const full = await versionOf(SUMMARY_ACCEPTANCE.full, Language.en);
      const briefOnly = await versionOf(SUMMARY_ACCEPTANCE.briefOnly, Language.en);
      const noFull = await versionOf(SUMMARY_ACCEPTANCE.noFull, Language.en);
      const onlyFullBook = await prisma.book.findUniqueOrThrow({
        where: { slug: SUMMARY_ACCEPTANCE.onlyFull },
        select: { id: true },
      });
      // «Грязь» поверх засеянного: лишний раздел, чужой пересказ, правка текста, лишняя версия.
      await prisma.bookSummarySection.create({
        data: { bookVersionId: briefOnly.id, number: 1, title: 'stray', text: '<p>stray</p>' },
      });
      await prisma.bookSummary.create({
        data: { bookVersionId: noFull.id, summary: '<p>stray</p>', hasText: true },
      });
      await prisma.bookSummarySection.update({
        where: { bookVersionId_number: { bookVersionId: full.id, number: 1 } },
        data: { title: 'stray', readerChapter: 3 },
      });
      // Даты адреса раздела, на которых стоят `dateModified` и `lastmod`, - тоже из набора.
      await prisma.bookSummarySection.update({
        where: { bookVersionId_number: { bookVersionId: full.id, number: 2 } },
        data: { updatedAt: new Date(), movedAt: null },
      });
      // Отрицательный номер - след оборванного сдвига (`CHECK` на номер нет).
      await prisma.bookSummarySection.create({
        data: { bookVersionId: full.id, number: -1, title: 'stray', text: '<p>stray</p>' },
      });
      await prisma.bookSummary.update({
        where: { bookVersionId: full.id },
        data: { brief: '<p>stray</p>' },
      });
      const strayVersion = await prisma.bookVersion.create({
        data: {
          bookId: onlyFullBook.id,
          language: Language.fr,
          title: 'stray',
          slug: SUMMARY_ACCEPTANCE.onlyFull,
          author: 'stray',
          description: 'stray',
          coverImageUrl: 'https://example.com/cover.jpg',
          type: 'text',
          isFree: true,
        },
        select: { id: true },
      });
      // Редакторский noindex: снят руками с книги набора и поставлен на книгу вне его.
      const noindex = await prisma.bookVersion.findFirstOrThrow({
        where: { book: { slug: SUMMARY_ACCEPTANCE.noindex }, language: Language.en },
        select: { id: true, seoId: true },
      });
      await prisma.seo.update({ where: { id: noindex.seoId! }, data: { robots: null } });
      const straySeo = await prisma.seo.create({ data: { robots: 'noindex' } });
      await prisma.bookVersion.update({ where: { id: full.id }, data: { seoId: straySeo.id } });
      try {
        // Гео-правила на книгу и на версию, лишняя глава у версии без текста, черновик опубликован руками.
        const fullBook = await prisma.book.findUniqueOrThrow({
          where: { slug: SUMMARY_ACCEPTANCE.full },
          select: { id: true },
        });
        const geoRule = {
          scope: 'TEXT_READER' as const,
          countryCode: 'GB',
          accessPolicy: 'BLOCK' as const,
          sourceFinalStatus: 'BLOCKED' as const,
          isActive: true,
          generatedFrom: 'E2E_TEST',
        };
        await prisma.geoBlockRule.create({ data: { ...geoRule, bookId: fullBook.id } });
        await prisma.geoBlockRule.create({ data: { ...geoRule, bookVersionId: full.id } });
        const noChapters = await versionOf(SUMMARY_ACCEPTANCE.noChapters, Language.en);
        await prisma.chapter.create({
          data: { bookVersionId: noChapters.id, number: 1, title: 'stray', content: 'stray' },
        });
        const draft = await versionOf(SUMMARY_ACCEPTANCE.draft, Language.en);
        await prisma.bookVersion.update({ where: { id: draft.id }, data: { status: 'published' } });

        await runSeed('npx prisma db seed', { env: { ...process.env }, timeout: 120_000 });

        const robotsOf = async (id: string) =>
          (
            await prisma.bookVersion.findUniqueOrThrow({
              where: { id },
              select: { seo: { select: { robots: true } } },
            })
          ).seo?.robots ?? null;
        expect(await robotsOf(noindex.id)).toBe('noindex, follow');
        expect(await robotsOf(full.id)).toBeNull();
        expect(
          await prisma.geoBlockRule.count({
            where: { OR: [{ bookId: fullBook.id }, { bookVersion: { bookId: fullBook.id } }] },
          }),
        ).toBe(0);
        expect(await prisma.chapter.count({ where: { bookVersionId: noChapters.id } })).toBe(0);
        const draftAfter = await prisma.bookVersion.findUniqueOrThrow({
          where: { id: draft.id },
          select: { status: true },
        });
        expect(draftAfter.status).toBe('draft');
        expect(
          await prisma.bookSummarySection.count({ where: { bookVersionId: briefOnly.id } }),
        ).toBe(0);
        expect(await prisma.bookSummary.count({ where: { bookVersionId: noFull.id } })).toBe(0);
        expect(await prisma.bookVersion.count({ where: { id: strayVersion.id } })).toBe(0);
        const first = await prisma.bookSummarySection.findUniqueOrThrow({
          where: { bookVersionId_number: { bookVersionId: full.id, number: 1 } },
          select: { title: true, readerChapter: true },
        });
        expect(first).toEqual({ title: sectionTitle(Language.en, 1), readerChapter: 1 });
        const seededSecond = books
          .find((b) => b.slug === SUMMARY_ACCEPTANCE.full)!
          .versions.find((v) => v.language === Language.en)!.sections[1];
        const second = await prisma.bookSummarySection.findUniqueOrThrow({
          where: { bookVersionId_number: { bookVersionId: full.id, number: 2 } },
          select: { updatedAt: true, movedAt: true },
        });
        expect(second).toEqual({
          updatedAt: seededSecond.updatedAt,
          movedAt: seededSecond.movedAt,
        });
        const summary = await prisma.bookSummary.findUniqueOrThrow({
          where: { bookVersionId: full.id },
          select: { brief: true },
        });
        expect(summary.brief).toBe(briefText(Language.en));

        const where = { bookVersion: { book: { slug: { in: books.map((b) => b.slug) } } } };
        const versions = books.flatMap((b) => b.versions);
        expect(await prisma.bookSummarySection.count({ where })).toBe(
          versions.reduce((n, v) => n + v.sections.length, 0),
        );
        expect(await prisma.bookSummary.count({ where })).toBe(
          versions.filter((v) => v.summary).length,
        );
      } finally {
        // Чужой `Seo` теста снимается тестом же и при падении: сид чужие строки `Seo` не отвязывает.
        await prisma.bookVersion.update({ where: { id: full.id }, data: { seoId: null } });
        await prisma.seo.delete({ where: { id: straySeo.id } });
      }
    }, 180_000);
  });
});
