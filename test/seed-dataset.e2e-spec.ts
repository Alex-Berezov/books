import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

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
      const letters = res.body as Array<{ letter: string; count: number }>;

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
   * Карточки книг автора идут строго по ключу: `BookService.findCardsByAuthor` фильтрует
   * `where: { authorId, language, status: 'published' }` и запасного пути по имени
   * не имеет — в отличие от буквенного указателя, который сводит автора с книгой ещё
   * и по `bv.author = t.name`. Поэтому потерянный `authorId` оставил бы указатель
   * зелёным, а страницу автора — пустой: `LEGACY-294` вернулся бы наполовину и молча.
   */
  it('книги автора находятся по внешнему ключу, а не по совпадению имени', async () => {
    const res = await get('/ru/authors/dzhoan-rouling/books/cards?limit=24').expect(200);
    const body = res.body as { items: unknown[] };

    expect(body.items.length).toBeGreaterThan(0);
  });

  /**
   * ⚠️ Русское имя автора в сиде — кириллическое намеренно. Латинское «J.K. Rowling»
   * своей буквы в русском алфавите не имеет и уходит в группу `#`, а на `#` ссылки
   * указатель тоже рисует — то есть проверка выше прошла бы, а перехода по букве
   * на живой странице всё равно не было бы. Здесь это и стережётся.
   */
  it('русский указатель наполнен буквой алфавита, а не только группой #', async () => {
    const res = await get('/ru/authors/letters').expect(200);
    const letters = res.body as Array<{ letter: string; count: number }>;

    const named = letters.filter((l) => l.count > 0 && l.letter !== '#');
    expect(named.length).toBeGreaterThan(0);
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
    const body = res.body as { data: Array<{ name: string }> };
    expect(body.data.filter((a) => a.name === 'Джоан Роулинг')).toHaveLength(1);

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
  }, 180_000);
});
