import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookType, Language } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { markBookRightsFreshForTests } from './helpers/rights-fresh';
import { httpServerOf } from './http-server';
import { PAGINATION_MAX_LIMIT } from '../src/shared/dto/pagination.dto';

/**
 * `LEGACY-090` / `LEGACY-091`. Публичные маршруты книг и таксономий отдавали
 * версии через `include` без выборки полей и без фильтра статуса.
 *
 * Замер на живом API 10.08.2026: **66 полей на версию, 29 из них — правовой
 * контур** (`rightsPendingCountryCodes`, `rightsContentHashInput`,
 * `rightsGeoBlockVerifiedByUserId` и прочее). Черновики при этом ехали вместе с
 * опубликованной книгой: `status: 'published'` в `where` отбирал **книгу**, а не
 * её версии.
 *
 * ⚠️ Проверки ниже смотрят на **весь** ответ, а не на отдельные поля: дефект был
 * именно в том, что наружу шла целая модель, и перечисление «плохих» полей
 * повторило бы ту же ошибку в тесте.
 */
describe('Draft and rights exposure (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rightsContentHashService: RightsContentHashService;

  let adminToken: string;
  let readerToken: string;

  let bookSlug: string;
  let bookId: string;
  let publishedVersionId: string;
  let publishedVersionSlug: string;
  let draftVersionId: string;
  let categorySlug: string;
  let tagSlug: string;

  const http = () => httpServerOf(app);

  const registerOrLogin = async (email: string, password = 'password123'): Promise<string> => {
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) return (reg.body as { accessToken: string }).accessToken;
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return (login.body as { accessToken: string }).accessToken;
  };

  /** Все ключи, встречающиеся в ответе на любой глубине. */
  const allKeys = (value: unknown, acc: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(value)) {
      value.forEach((v) => allKeys(v, acc));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        acc.add(k);
        allKeys(v, acc);
      }
    }
    return acc;
  };

  const rightsKeys = (body: unknown): string[] =>
    [...allKeys(body)].filter((k) => k.toLowerCase().startsWith('rights'));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    rightsContentHashService = moduleRef.get(RightsContentHashService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
    adminToken = await registerOrLogin('admin@example.com');
    readerToken = await registerOrLogin(`reader_${Date.now()}@example.com`);

    const stamp = Date.now();
    bookSlug = `exposure-${stamp}`;
    const bookWithRights = await createBookWithRights(prisma, bookSlug);
    bookId = bookWithRights.book.id;

    const makeVersion = async (language: Language, title: string): Promise<string> => {
      const res = await request(http())
        .post(`/books/${bookWithRights.book.id}/versions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          language,
          title,
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/cover.jpg',
          type: BookType.text,
          isFree: true,
        })
        .expect(201);
      return (res.body as { id: string }).id;
    };

    publishedVersionId = await makeVersion(Language.en, 'Published Title');
    // 🔴 Черновик на другом языке той же книги — ровно тот случай, что утекал:
    // книга опубликована, перевод ещё нет.
    draftVersionId = await makeVersion(Language.ru, 'DRAFT TITLE NOT FOR PUBLIC');

    categorySlug = `exposure-cat-${stamp}`;
    const category = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'genre',
        name: 'Exposure Genre',
        slug: categorySlug,
        key: categorySlug,
      })
      .expect(201);
    const categoryId = (category.body as { id: string }).id;

    await prisma.categoryTranslation.create({
      data: { categoryId, language: Language.en, name: 'Exposure Genre', slug: categorySlug },
    });

    for (const versionId of [publishedVersionId, draftVersionId]) {
      await request(http())
        .post(`/versions/${versionId}/categories`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ categoryId })
        .expect(201);
    }

    tagSlug = `exposure-tag-${stamp}`;
    const tag = await request(http())
      .post('/tags')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Exposure Tag', slug: tagSlug, key: tagSlug })
      .expect(201);
    const tagId = (tag.body as { id: string }).id;
    await prisma.tagTranslation.create({
      data: { tagId, language: Language.en, name: 'Exposure Tag', slug: tagSlug },
    });
    await prisma.bookTag.create({ data: { tagId, bookVersionId: publishedVersionId } });

    await markBookRightsFreshForTests(prisma, bookWithRights.book.id, rightsContentHashService);

    await request(http())
      .patch(`/versions/${publishedVersionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // `overview` адресуется слагом версии: слаг книги-контейнера уводит маршрут
    // в 301 на канонический адрес перевода, и проверка мерила бы редирект.
    const published = await request(http()).get(`/versions/${publishedVersionId}`).expect(200);
    publishedVersionSlug = (published.body as { slug: string | null }).slug ?? bookSlug;
  });

  afterAll(async () => {
    if (bookSlug) {
      await cleanupBookWithRights(prisma, bookSlug);
    }
    await app.close();
  });

  describe('LEGACY-090 — правовой контур наружу', () => {
    it('категория не отдаёт ни одного правового поля', async () => {
      const res = await request(http()).get(`/en/categories/${categorySlug}/books`).expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
    });

    /**
     * ⚠️ Отдельный тест, а не дубль предыдущего: `/categories/:slug/books` без
     * языкового префикса обслуживается **другим методом**
     * (`getBySlugWithBooks`), объявлен в `CategoryController` как
     * backward-compatible и живёт своей жизнью. Первая мутационная проверка это
     * и показала: правка второго метода не роняла ни одного теста, потому что
     * ни один туда не ходил.
     */
    it('категория без языкового префикса тоже не отдаёт правовых полей', async () => {
      const res = await request(http()).get(`/categories/${categorySlug}/books`).expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('DRAFT TITLE NOT FOR PUBLIC');
    });

    it('список книг не отдаёт ни одного правового поля', async () => {
      const res = await request(http()).get('/en/books?limit=5').expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
    });

    it('тег не отдаёт ни одного правового поля', async () => {
      const res = await request(http()).get(`/en/tags/${tagSlug}/books`).expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
    });

    /**
     * 🔴 Эти два маршрута не попали в обход 10.08.2026: тот шёл по `include:
     * versions` внутри сервисов книг и таксономий, а версии отдаёт ещё и
     * собственный модуль. Свежая проверка живого API (`LEGACY-065`) показала на
     * обоих те же 29 правовых полей.
     *
     * ⚠️ Урок не про эти строки, а про метод: обход по коду видит только те
     * места, которые ищущий догадался перечислить. Спрашивать надо у API.
     */
    it('список версий книги не отдаёт правовых полей', async () => {
      const res = await request(http()).get(`/books/${bookId}/versions`).expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('DRAFT TITLE NOT FOR PUBLIC');
    });

    it('версия по id не отдаёт правовых полей', async () => {
      const res = await request(http()).get(`/versions/${publishedVersionId}`).expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
      expect((res.body as { title: string }).title).toBe('Published Title');
    });

    it('книга по слагу не отдаёт ни одного правового поля', async () => {
      const res = await request(http()).get(`/books/slug/${bookSlug}`).expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
    });

    /**
     * 🔴 Маршрут, которого здесь не было до 11.08.2026 — и именно он остался
     * дырявым, когда все перечисленные выше уже были закрыты. Замер живого API:
     * **6.1 МБ, 66 полей на версию, 29 правовых**, включая
     * `rightsContentHashInput` на 1.18 МБ (`LEGACY-090`, `LEGACY-046`).
     *
     * ⚠️ Это самая посещаемая публичная страница: фронт зовёт `overview` на
     * каждой отрисовке карточки книги. Причина пропуска — обход шёл по
     * `include: versions` в сервисах книг и таксономий, а `getOverview` в тот
     * перечень не попал.
     */
    it('страница книги не отдаёт ни одного правового поля', async () => {
      const res = await request(http()).get(`/books/${publishedVersionSlug}/overview`).expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
    });

    it('языковая форма того же маршрута тоже чиста', async () => {
      const res = await request(http())
        .get(`/en/books/${publishedVersionSlug}/overview`)
        .expect(200);

      expect(rightsKeys(res.body)).toEqual([]);
    });

    // Служебные ключи выбираются ради работы метода и обязаны сниматься на
    // выходе: иначе белый список превращается в «почти белый».
    it('страница книги не отдаёт внутренних ключей версии', async () => {
      const res = await request(http()).get(`/books/${publishedVersionSlug}/overview`).expect(200);

      const version = (res.body as { versions: Record<string, unknown>[] }).versions[0];
      expect(version).not.toHaveProperty('seoId');
      expect(version).not.toHaveProperty('primaryCategoryId');
    });

    /**
     * Зеркало предыдущей проверки. Без него правка «убрать лишнее» однажды
     * уберёт и нужное: страница книги рендерит редакционную обвязку, которой
     * нет в карточках, и её отсутствие проявилось бы пустыми блоками, а не
     * упавшим тестом.
     */
    it('страница книги сохраняет поля, ради которых она и существует', async () => {
      const res = await request(http()).get(`/books/${publishedVersionSlug}/overview`).expect(200);

      const version = (res.body as { versions: Record<string, unknown>[] }).versions[0];
      for (const field of [
        'id',
        'title',
        'author',
        'slug',
        'language',
        'status',
        'type',
        'coverImageUrl',
        'coverUrl',
        'coverAlt',
        'description',
        'shortDescription',
        'originalTitle',
        'originalLanguage',
        'copyrightStatus',
        'authorPageUrl',
        'alternativeTitles',
        'themes',
        'characters',
        'quotes',
        'faq',
        'symbols',
        'firstPublishedYear',
        'editionPublishedYear',
        '_count',
      ]) {
        expect(version).toHaveProperty(field);
      }
    });

    // Выдача обязана остаться пригодной: лечится объём ответа, а не маршрут.
    it('оставляет поля, на которых держатся карточки', async () => {
      const res = await request(http()).get(`/en/categories/${categorySlug}/books`).expect(200);

      const version = (res.body as { data: { versions: Record<string, unknown>[] }[] }).data[0]
        .versions[0];
      for (const field of ['id', 'title', 'author', 'slug', 'language', 'status', 'type']) {
        expect(version).toHaveProperty(field);
      }
    });
  });

  describe('LEGACY-090 — черновики', () => {
    it('категория не показывает черновой перевод опубликованной книги', async () => {
      const res = await request(http()).get(`/en/categories/${categorySlug}/books`).expect(200);

      // 🔴 `status: 'published'` в `where` отбирает книгу, а не её версии.
      expect(JSON.stringify(res.body)).not.toContain('DRAFT TITLE NOT FOR PUBLIC');
    });

    it('саммари черновика не читается анонимом, но открыто редактору', async () => {
      await request(http())
        .put(`/versions/${draftVersionId}/summary`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ summary: 'Editorial draft summary' })
        .expect(200);

      // Адрес угадывать не нужно: id версии приходит в любом админском ответе.
      await request(http()).get(`/versions/${draftVersionId}/summary`).expect(404);

      // Вошедший ≠ редактор.
      await request(http())
        .get(`/versions/${draftVersionId}/summary`)
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(404);

      const editor = await request(http())
        .get(`/versions/${draftVersionId}/summary`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((editor.body as { summary: string }).summary).toBe('Editorial draft summary');
    });

    /**
     * 🔴 `GET /books/:id` и `GET /books/slug/:slug` фильтра статуса не имели
     * вовсе, и это было записано в коде как осознанное решение: маршрут
     * обслуживает админский переключатель версий. Верно наполовину — маршрут
     * действительно админский, но **анонимный** (`LEGACY-090`).
     *
     * ⚠️ Лечится ответ, а не доступ: фильтр «только published» сделал бы
     * переключатель версий у редактора вечно пустым.
     */
    it('книга по id не показывает черновик анониму, но показывает редактору', async () => {
      const anon = await request(http()).get(`/books/${bookId}`).expect(200);
      expect(JSON.stringify(anon.body)).not.toContain('DRAFT TITLE NOT FOR PUBLIC');

      // Вошедший ≠ редактор.
      const reader = await request(http())
        .get(`/books/${bookId}`)
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200);
      expect(JSON.stringify(reader.body)).not.toContain('DRAFT TITLE NOT FOR PUBLIC');

      const editor = await request(http())
        .get(`/books/${bookId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(JSON.stringify(editor.body)).toContain('DRAFT TITLE NOT FOR PUBLIC');
    });

    it('книга по слагу — то же самое', async () => {
      const anon = await request(http()).get(`/books/slug/${bookSlug}`).expect(200);
      expect(JSON.stringify(anon.body)).not.toContain('DRAFT TITLE NOT FOR PUBLIC');

      const editor = await request(http())
        .get(`/books/slug/${bookSlug}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(JSON.stringify(editor.body)).toContain('DRAFT TITLE NOT FOR PUBLIC');
    });

    /**
     * Ответ теперь зависит от `Authorization`, поэтому общему кэшу его отдавать
     * нельзя: иначе черновик, однажды загруженный редактором, раздастся
     * анонимам по тому же URL (`LEGACY-088`, `LEGACY-101`).
     */
    it('ответ этих маршрутов не кэшируется как публичный', async () => {
      const res = await request(http()).get(`/books/${bookId}`).expect(200);

      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('саммари опубликованной версии остаётся публичным', async () => {
      await request(http())
        .put(`/versions/${publishedVersionId}/summary`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ summary: 'Public summary' })
        .expect(200);

      const res = await request(http()).get(`/versions/${publishedVersionId}/summary`).expect(200);
      expect((res.body as { summary: string }).summary).toBe('Public summary');
    });
  });

  describe('LEGACY-093 — публичный каталог и админский список разведены', () => {
    it('административный список закрыт гвардом', async () => {
      await request(http()).get('/books?limit=5').expect(401);
    });

    it('редактор видит в нём черновики', async () => {
      const res = await request(http())
        .get('/books?limit=100')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(JSON.stringify(res.body)).toContain('DRAFT TITLE NOT FOR PUBLIC');
    });

    it('обычному пользователю административный список не открывается', async () => {
      await request(http())
        .get('/books?limit=5')
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(403);
    });

    /**
     * 🔴 Публичная витрина больше не сообщает, какие переводы готовятся.
     * До 10.08.2026 фильтр «только published» существовал **тремя копиями на
     * клиенте** — в каталоге, в карте сайта и в мапперах карточек, — потому что
     * сервер его не соблюдал и каждый потребитель договаривался сам.
     */
    it('публичный список отдаёт книги без черновиков', async () => {
      const res = await request(http()).get('/en/books?limit=100').expect(200);

      expect(JSON.stringify(res.body)).not.toContain('DRAFT TITLE NOT FOR PUBLIC');
      expect((res.body as { data: unknown[] }).data.length).toBeGreaterThan(0);
    });

    /**
     * ⚠️ `meta.total` считается тем же `where`, что и выборка. Расхождение не
     * дало бы ошибки — по этому числу карта сайта решает, сколько файлов
     * запрашивать, и лишние страницы молча отвечали бы 404 при живом индексе,
     * который их перечисляет.
     */
    it('total публичного списка согласован с выдачей', async () => {
      // `LEGACY-298`: маршрут зажат `PAGINATION_MAX_LIMIT`, `?limit=1000` теперь
      // отбивается 400. Тестовый каталог этого набора укладывается в потолок,
      // поэтому равенство `total === data.length` продолжает проверяться на
      // единственной странице.
      const page = await request(http()).get(`/en/books?limit=${PAGINATION_MAX_LIMIT}`).expect(200);
      const body = page.body as { data: unknown[]; meta: { total: number } };

      expect(body.meta.total).toBe(body.data.length);
    });
  });

  describe('LEGACY-091 — маршрут объявлен один раз', () => {
    /**
     * 🔴 Пока путь объявляли два контроллера, побеждал порядок модулей — и
     * побеждала копия без `LangParamPipe` и без `PublicCacheInterceptor`.
     * Оба признака ниже и есть доказательство, какая реализация жива.
     *
     * ⚠️ Ожидается именно **404**, а не 400: `LangParamPipe` отвечает
     * «маршрута нет», чтобы не подтверждать структуру путей неизвестному
     * языку. Важен не конкретный код, а то, что мусорный префикс больше не
     * роняет обработчик в 500, как это было на живом проде 10.08.2026.
     */
    it('мусорный язык не роняет маршрут в 500', async () => {
      await request(http()).get(`/xx/categories/${categorySlug}/books`).expect(404);
    });

    it('ответ снова кэшируется как публичный', async () => {
      const res = await request(http()).get(`/en/categories/${categorySlug}/books`).expect(200);

      expect(res.headers['cache-control']).toContain('public');
    });
  });
});
