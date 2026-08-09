import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SlugRedirectService } from '../src/modules/slug-redirect/slug-redirect.service';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';

/**
 * LEGACY-062. Слаг таксономии — индексируемый публичный URL, и до этой правки
 * `update()` перезаписывал его на месте: прошлое значение исчезало без следа, старый
 * адрес немедленно начинал отдавать 404, накопленные поисковые сигналы не переносились.
 *
 * Проверки идут на настоящей базе: дефекты этого класса живут в форме запроса и в
 * порядке шагов внутри транзакции, а не в логике вокруг них.
 */
describe('Slug redirects (LEGACY-062) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redirects: SlugRedirectService;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const stamp = Date.now();

  /**
   * Книги заводятся фикстурой прав, а часть посадок им слаг **меняет** — то есть
   * `cleanupBookWithRights` по исходному слагу книгу уже не найдёт. Поэтому
   * запоминается и id (по нему удаляется сама книга), и исходный слаг (из него
   * фикстура вывела id-шники прав).
   */
  const createdBooks: { fixtureSlug: string; id: string }[] = [];
  const createdPageIds: string[] = [];
  const createdAuthorIds: string[] = [];

  const newBook = async (fixtureSlug: string): Promise<string> => {
    const created = await createBookWithRights(prisma, fixtureSlug);
    createdBooks.push({ fixtureSlug, id: created.book.id });
    return created.book.id;
  };

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    redirects = moduleRef.get(SlugRedirectService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const password = 'password123';
    const reg = await request(http())
      .post('/auth/register')
      .send({ email: 'admin@example.com', password });
    if (reg.status === 201) {
      adminAccess = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: 'admin@example.com', password })
        .expect(200);
      adminAccess = (login.body as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    await prisma.slugRedirect.deleteMany({ where: { oldSlug: { contains: `sr-${stamp}` } } });
    if (createdPageIds.length > 0) {
      await prisma.page.deleteMany({ where: { id: { in: createdPageIds } } });
    }
    if (createdAuthorIds.length > 0) {
      await prisma.author.deleteMany({ where: { id: { in: createdAuthorIds } } });
    }
    for (const book of createdBooks) {
      await prisma.bookVersion.deleteMany({ where: { bookId: book.id } });
      await prisma.book.deleteMany({ where: { id: book.id } });
      await cleanupBookWithRights(prisma, book.fixtureSlug);
    }
    await app.close();
  });

  it('records a redirect when a category translation slug changes', async () => {
    const created = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ type: 'genre', name: `SR ${stamp}`, slug: `sr-${stamp}-base`, key: `sr-${stamp}` })
      .expect(201);
    const categoryId = (created.body as { id: string }).id;

    await request(http())
      .post(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ language: 'en', name: 'Old name', slug: `sr-${stamp}-old` })
      .expect(201);

    await request(http())
      .patch(`/categories/${categoryId}/translations/en`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: `sr-${stamp}-new` })
      .expect(200);

    const resolved = await redirects.resolve('category', 'en', `sr-${stamp}-old`);
    expect(resolved).toBe(`sr-${stamp}-new`);

    // Публичный маршрут отдаёт то же самое — им пользуется фронт при 404.
    const res = await request(http())
      .get(`/en/slug-redirect?entityType=category&slug=sr-${stamp}-old`)
      .expect(200);
    expect((res.body as { newSlug: string | null }).newSlug).toBe(`sr-${stamp}-new`);

    await prisma.categoryTranslation.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
  });

  it('answers newSlug: null for a slug nobody retired', async () => {
    // Не 404: отсутствие редиректа не должно быть неотличимо от отказа сети.
    const res = await request(http())
      .get(`/en/slug-redirect?entityType=category&slug=never-existed-${stamp}`)
      .expect(200);
    expect((res.body as { newSlug: string | null }).newSlug).toBeNull();
  });

  it('collapses a chain so an old address needs one hop, not two', async () => {
    // A→B, затем B→C. Без схлопывания браузер шёл бы A→B→C, а Google учитывает
    // ограниченное число звеньев.
    await redirects.record({
      entityType: 'tag',
      language: 'en',
      oldSlug: `sr-${stamp}-a`,
      newSlug: `sr-${stamp}-b`,
    });
    await redirects.record({
      entityType: 'tag',
      language: 'en',
      oldSlug: `sr-${stamp}-b`,
      newSlug: `sr-${stamp}-c`,
    });

    expect(await redirects.resolve('tag', 'en', `sr-${stamp}-a`)).toBe(`sr-${stamp}-c`);
    expect(await redirects.resolve('tag', 'en', `sr-${stamp}-b`)).toBe(`sr-${stamp}-c`);
  });

  it('never leaves a redirect pointing at itself when a slug is swapped back', async () => {
    // A→B, затем B→A. Наивная реализация оставила бы A→A — бесконечный переход.
    await redirects.record({
      entityType: 'tag',
      language: 'ru',
      oldSlug: `sr-${stamp}-x`,
      newSlug: `sr-${stamp}-y`,
    });
    await redirects.record({
      entityType: 'tag',
      language: 'ru',
      oldSlug: `sr-${stamp}-y`,
      newSlug: `sr-${stamp}-x`,
    });

    const selfPointing = await prisma.slugRedirect.findMany({
      where: { entityType: 'tag', language: 'ru', oldSlug: { contains: `sr-${stamp}` } },
    });
    for (const row of selfPointing) expect(row.oldSlug).not.toBe(row.newSlug);

    // Адрес, снова ставший живым, никуда не уводит.
    expect(await redirects.resolve('tag', 'ru', `sr-${stamp}-x`)).toBeNull();
  });

  /**
   * Базовый слаг — отдельный путь, и его легко было пропустить: редиректы сначала
   * писались только для переводов. Между тем именно базовый слаг правит
   * `CategoryModal`, а публичный URL резолвится по слагу перевода **с фолбэком на
   * базовый** — то есть его смена ломает адрес во всех языках сразу.
   */
  it('records a redirect for every language when the base slug changes', async () => {
    const created = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        type: 'collection',
        name: `SR base ${stamp}`,
        slug: `sr-${stamp}-base-old`,
        key: `sr-${stamp}-base`,
      })
      .expect(201);
    const categoryId = (created.body as { id: string }).id;

    await request(http())
      .patch(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      // `key` передаётся явно: без него сервис выводит его из слага (LEGACY-068).
      .send({ slug: `sr-${stamp}-base-new`, key: `sr-${stamp}-base` })
      .expect(200);

    for (const language of ['en', 'ru', 'es', 'fr', 'pt'] as const) {
      expect(await redirects.resolve('category', language, `sr-${stamp}-base-old`)).toBe(
        `sr-${stamp}-base-new`,
      );
    }

    await prisma.category.delete({ where: { id: categoryId } });
  });

  it('keeps languages apart', async () => {
    await redirects.record({
      entityType: 'tag',
      language: 'fr',
      oldSlug: `sr-${stamp}-shared`,
      newSlug: `sr-${stamp}-fr`,
    });
    expect(await redirects.resolve('tag', 'es', `sr-${stamp}-shared`)).toBeNull();
  });

  /**
   * Список типов задан в одном месте — `SLUG_REDIRECT_ENTITY_TYPES`, — и из него же
   * DTO выводит `@IsIn`. Значит расширение списка автоматически открывает новые типы
   * на публичном резолве, и проверять надо ровно это.
   *
   * 🔴 Контрольный вход — обязательная половина посадки. Без него тест одинаково
   * зелёный и когда типы добавлены, и когда валидация снята целиком: «принимает
   * book» само по себе ничего не доказывает, если принимается вообще всё.
   */
  it('accepts the entity types added to the list — and still rejects one that is not on it', async () => {
    for (const entityType of ['book', 'author', 'page'] as const) {
      const res = await request(http())
        .get(`/en/slug-redirect?entityType=${entityType}&slug=sr-${stamp}-unknown`)
        .expect(200);
      expect((res.body as { newSlug: string | null }).newSlug).toBeNull();
    }

    await request(http())
      .get(`/en/slug-redirect?entityType=nonsense&slug=sr-${stamp}-unknown`)
      .expect(400);
  });

  /**
   * Базовый слаг книги участвует в резолве публичного адреса как фолбэк, когда у
   * версии слага нет. Он не привязан к языку, а `SlugRedirect` — привязан, поэтому
   * одна смена обязана оставить пять записей: запись «без языка» не сработала бы
   * ни в одном из них.
   */
  it('records a redirect for every language when the base book slug changes', async () => {
    const oldSlug = `sr-${stamp}-book-old`;
    const newSlug = `sr-${stamp}-book-new`;
    const bookId = await newBook(oldSlug);

    await request(http())
      .patch(`/books/${bookId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: newSlug })
      .expect(200);

    const rows = await prisma.slugRedirect.findMany({ where: { entityType: 'book', oldSlug } });
    expect(rows).toHaveLength(5);
    for (const language of ['en', 'ru', 'es', 'fr', 'pt'] as const) {
      expect(await redirects.resolve('book', language, oldSlug)).toBe(newSlug);
    }
  });

  it('writes nothing when a book is patched without a slug', async () => {
    // Контроль к посадке выше: пять строк должны появляться от смены слага, а не от
    // самого факта PATCH. Иначе история засорялась бы на каждом сохранении формы.
    const fixtureSlug = `sr-${stamp}-book-untouched`;
    const bookId = await newBook(fixtureSlug);

    await request(http())
      .patch(`/books/${bookId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({})
      .expect(200);

    expect(await prisma.slugRedirect.count({ where: { oldSlug: fixtureSlug } })).toBe(0);
  });

  /**
   * Слаг версии — публичный адрес книги **в одном языке**, и языков у книги пять.
   * Запись обязана лечь под язык версии: под чужим она не сработает, под всеми
   * сразу — уведёт с живых адресов других языков.
   */
  it('records a redirect under the version language when a book version slug changes', async () => {
    const oldSlug = `sr-${stamp}-version-old`;
    const newSlug = `sr-${stamp}-version-new`;
    const bookId = await newBook(`sr-${stamp}-version-book`);

    const created = await request(http())
      .post(`/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        language: 'ru',
        title: 'Версия',
        author: 'Автор',
        description: 'Описание',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: 'text',
        isFree: true,
        slug: oldSlug,
      })
      .expect(201);
    const versionId = (created.body as { id: string }).id;

    await request(http())
      .patch(`/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: newSlug })
      .expect(200);

    const rows = await prisma.slugRedirect.findMany({ where: { oldSlug } });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe('book');
    expect(rows[0].language).toBe('ru');
    expect(rows[0].newSlug).toBe(newSlug);

    // Другие языки книги свои адреса не меняли — редиректа там быть не должно.
    expect(await redirects.resolve('book', 'en', oldSlug)).toBeNull();

    // Контроль: правка, не трогающая слаг, историю не пишет.
    await request(http())
      .patch(`/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ title: 'Другое название' })
      .expect(200);
    expect(await prisma.slugRedirect.count({ where: { oldSlug: newSlug } })).toBe(0);
  });

  /**
   * Слаг страницы стал обычным редактируемым полем с тех пор, как системные страницы
   * ищутся по неизменяемому `systemKey`. Именно поэтому его смена обязана оставлять
   * редирект: функционально она больше ничего не ломает, и потеря адреса прошла бы
   * незамеченной до падения трафика.
   */
  it('records a redirect under the page language when a page slug changes', async () => {
    const oldSlug = `sr-${stamp}-page-old`;
    const newSlug = `sr-${stamp}-page-new`;

    const created = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: oldSlug, title: 'Page title', type: 'generic', content: 'Body' })
      .expect(201);
    const pageId = (created.body as { id: string }).id;
    createdPageIds.push(pageId);

    await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: newSlug })
      .expect(200);

    const rows = await prisma.slugRedirect.findMany({ where: { oldSlug } });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe('page');
    expect(rows[0].language).toBe('en');
    expect(rows[0].newSlug).toBe(newSlug);

    // Контроль: форма админки шлёт `slug` в каждом запросе, в том числе когда его не
    // меняли. Реакция на присутствие поля, а не на смену значения, засорила бы историю
    // и — хуже — переписала бы цепочки на пустом месте.
    await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: newSlug, title: 'Другой заголовок' })
      .expect(200);
    expect(await prisma.slugRedirect.count({ where: { oldSlug: newSlug } })).toBe(0);
  });

  it('records a page redirect under the OLD language when slug and language change together', async () => {
    // Резолв идёт по паре (язык, старый слаг), а старый адрес жил под старым языком.
    // Запись под новым выглядит интуитивнее — и не сработала бы нигде: по старому
    // адресу приходят из индекса, где он проиндексирован в прежнем языке.
    const oldSlug = `sr-${stamp}-page-lang-old`;
    const newSlug = `sr-${stamp}-page-lang-new`;

    const created = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: oldSlug, title: 'Moved page', type: 'generic', content: 'Body' })
      .expect(201);
    const pageId = (created.body as { id: string }).id;
    createdPageIds.push(pageId);

    await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: newSlug, language: 'ru' })
      .expect(200);

    expect(await redirects.resolve('page', 'en', oldSlug)).toBe(newSlug);
    expect(await redirects.resolve('page', 'ru', oldSlug)).toBeNull();
  });

  /**
   * У автора базового слага нет вовсе — адрес `/{lang}/author/{slug}` существует
   * только на уровне перевода. Плюс переводы при обновлении удаляются и создаются
   * заново: старый слаг исчезает в том же `deleteMany`, где появляется новый, и
   * прочитать его после удаления уже не у чего.
   */
  it('records a redirect when an author translation slug changes', async () => {
    const oldSlug = `sr-${stamp}-author-old`;
    const newSlug = `sr-${stamp}-author-new`;

    const created = await request(http())
      .post('/admin/authors')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ translations: [{ language: 'fr', slug: oldSlug, name: 'Auteur test' }] })
      .expect(201);
    const authorId = (created.body as { id: string }).id;
    createdAuthorIds.push(authorId);

    await request(http())
      .put(`/admin/authors/${authorId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ translations: [{ language: 'fr', slug: newSlug, name: 'Auteur test' }] })
      .expect(200);

    const rows = await prisma.slugRedirect.findMany({ where: { oldSlug } });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe('author');
    expect(rows[0].language).toBe('fr');
    expect(rows[0].newSlug).toBe(newSlug);

    // Контроль: переводы пересоздаются на каждом сохранении, поэтому «перевод трогали»
    // и «адрес сменился» — разные события, и путать их нельзя.
    await request(http())
      .put(`/admin/authors/${authorId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ translations: [{ language: 'fr', slug: newSlug, name: 'Auteur renommé' }] })
      .expect(200);
    expect(await prisma.slugRedirect.count({ where: { oldSlug: newSlug } })).toBe(0);
  });

  /**
   * 🔴 Главная посадка на транзакционность.
   *
   * Запись истории и сама смена слага обязаны быть одной операцией. Вынести
   * `record()` из транзакции — правка в один аргумент (не передать `tx`), и она не
   * роняет ни одну посадку выше: в успешном сценарии результат тот же. Ломается она
   * только на неудачном обновлении — и ломается молча, оставляя редирект со ЖИВОГО
   * адреса на несуществующий. Посетитель и краулер при этом уводятся со страницы,
   * которая на самом деле открывается.
   *
   * Занятый чужой слаг выбран потому, что `BookService.update` предварительной
   * проверки уникальности не делает: `update` падает уже ПОСЛЕ вызова `record`,
   * то есть ровно в том окне, ради которого транзакция и заведена.
   */
  it('leaves no redirect behind when the slug update itself fails', async () => {
    const victimSlug = `sr-${stamp}-tx-victim`;
    const occupiedSlug = `sr-${stamp}-tx-occupied`;
    const victimId = await newBook(victimSlug);
    await newBook(occupiedSlug);

    const res = await request(http())
      .patch(`/books/${victimId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: occupiedSlug });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Слаг не сменился — значит и записи о его смене быть не должно ни одной.
    const victim = await prisma.book.findUnique({ where: { id: victimId } });
    expect(victim?.slug).toBe(victimSlug);
    expect(await prisma.slugRedirect.count({ where: { oldSlug: victimSlug } })).toBe(0);
  });

  /**
   * Схлопывание цепочек и уборка самоссылок работают по составному ключу
   * `(entityType, language, oldSlug)`. Проверка только на таксономии не поймала бы
   * регресс, при котором тип из ключа выпал: у категорий и тегов слаги в тестах
   * разные, а вот книга и категория с одинаковым слагом — обычное дело.
   */
  it('collapses chains and clears cycles for books, without touching other entity types', async () => {
    const a = `sr-${stamp}-bk-a`;
    const b = `sr-${stamp}-bk-b`;
    const c = `sr-${stamp}-bk-c`;

    await redirects.record({ entityType: 'book', language: 'es', oldSlug: a, newSlug: b });
    await redirects.record({ entityType: 'book', language: 'es', oldSlug: b, newSlug: c });

    // Цепочка: один переход, а не два — Google учитывает ограниченное число звеньев.
    expect(await redirects.resolve('book', 'es', a)).toBe(c);
    expect(await redirects.resolve('book', 'es', b)).toBe(c);

    // Слаг занят заново: книга вернулась на `a`. Редирект `a → …` обязан исчезнуть —
    // адрес снова живой, и уводить с него значило бы прятать существующую страницу.
    // Цепочка при этом переписывается на новую конечную точку, а не рвётся.
    await redirects.record({ entityType: 'book', language: 'es', oldSlug: c, newSlug: a });
    expect(await redirects.resolve('book', 'es', a)).toBeNull();
    expect(await redirects.resolve('book', 'es', b)).toBe(a);
    expect(await redirects.resolve('book', 'es', c)).toBe(a);
    const rows = await prisma.slugRedirect.findMany({
      where: { entityType: 'book', language: 'es', oldSlug: { contains: `sr-${stamp}-bk-` } },
    });
    for (const row of rows) expect(row.oldSlug).not.toBe(row.newSlug);

    // Тип сущности — часть ключа: у категории с тем же слагом своя история.
    expect(await redirects.resolve('category', 'es', a)).toBeNull();
  });
});
