/* eslint-disable @typescript-eslint/no-unsafe-member-access -- тело ответа supertest типизировано как any */
import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Language } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WorldMentionsSchedulerService } from '../src/modules/book-world/world-mentions-scheduler.service';
import { WORLD_BEACON_LIMIT } from '../src/common/guards/world-beacon-rate-limit.guard';
import { createBookFixture } from './helpers/book-fixture';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F08-3a: бэкенд публичных страниц мира книги (`books-app-docs/features/F08-book-wiki/batches.md` F08-3;
 * решения арбитра `F08 | F08-3` Q1-Q5 в `decisions-log.md`): карта сайта мира, счётчики и отчёт,
 * первая глава в списке читателя, `editor.isListed`.
 *
 * Сущности заводятся записью в базу с готовым `isListed`: публичные ручки читают колонку, а как
 * она считается, держит `book-world.e2e-spec.ts`.
 */
describe('BookWorld public e2e (F08-3a)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userAccess: string;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const createVersion = async (
    bookId: string,
    language: Language,
    over: { status?: 'published' | 'draft'; noindex?: boolean; slug?: string | null } = {},
  ) => {
    const seo = over.noindex
      ? await prisma.seo.create({ data: { robots: 'noindex, follow' } })
      : null;
    return prisma.bookVersion.create({
      data: {
        bookId,
        language,
        slug: over.slug === undefined ? `world-${language}-${unique()}` : over.slug,
        title: 'Version For World',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: over.status ?? 'published',
        ...(seo ? { seoId: seo.id } : {}),
      },
    });
  };

  const entity = (
    bookVersionId: string,
    key: string,
    over: {
      isListed?: boolean;
      isIndexable?: boolean;
      updatedAt?: Date;
      mentionFirst?: number;
    } = {},
  ) =>
    prisma.bookWorldEntity.create({
      data: {
        bookVersionId,
        key,
        type: 'character',
        name: key,
        hasCore: true,
        isListed: over.isListed ?? true,
        isIndexable: over.isIndexable ?? true,
        mentionFirst: over.mentionFirst ?? null,
        ...(over.updatedAt ? { updatedAt: over.updatedAt } : {}),
      },
    });

  type Alternate = { language: string; slug: string };
  type SitemapItem = {
    slug: string;
    lastmod: string;
    alternates: Alternate[];
    entities: { key: string; lastmod: string; alternates: Alternate[] }[];
  };

  /** Элемент карты языка по слагу версии: обход страниц, пока не найден или страницы не кончились. */
  const sitemapItem = async (lang: Language, slug: string): Promise<SitemapItem | undefined> => {
    for (let page = 1; page < 50; page++) {
      const res = await request(http()).get(`/${lang}/world/sitemap?page=${page}`).expect(200);
      const found = (res.body.items as SitemapItem[]).find((i) => i.slug === slug);
      if (found) return found;
      if (page >= res.body.pagination.totalPages) return undefined;
    }
    return undefined;
  };

  const beacon = (body: Record<string, unknown>, ua = 'Mozilla/5.0') =>
    request(http()).post('/world/beacon').set('User-Agent', ua).send(body);

  const statRows = (bookVersionId: string) =>
    prisma.worldDailyStat.findMany({ where: { bookVersionId }, orderBy: { event: 'asc' } });

  const register = async (email: string) => {
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) return reg.body.accessToken as string;
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return login.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    // Пересчёт присутствия здесь не нужен и не должен переписывать заведённые руками колонки.
    await moduleRef.get(WorldMentionsSchedulerService).onModuleDestroy();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // Сервер слушает порт (только loopback): supertest к неслушающему серверу поднимает его на первый
    // запрос и закрывает после первого ответа — одновременные запросы набора рвались бы `ECONNRESET`.
    await app.listen(0, '127.0.0.1');
    userAccess = await register(`user_world_public_${Date.now()}@example.com`);
    adminAccess = await register('admin@example.com');
    await grantStaffRoles(app, 'admin@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  it('карта: общая страница всегда, сущности — только isIndexable; кластер — языки без noindex и черновиков (Q1, Q4, Q10)', async () => {
    const book = await createBookFixture(prisma, `world-map-${unique()}`);
    const en = await createVersion(book.id, 'en');
    const ru = await createVersion(book.id, 'ru');
    const fr = await createVersion(book.id, 'fr', { noindex: true });
    const es = await createVersion(book.id, 'es', { status: 'draft' });
    const early = new Date('2026-11-01T00:00:00Z');
    const late = new Date('2026-11-10T00:00:00Z');
    await entity(en.id, 'oblomov', { updatedAt: early });
    // Не индексируется, но страница есть — двигает дату общей страницы (Q12).
    await entity(en.id, 'zakhar', { isIndexable: false, updatedAt: late });
    await entity(en.id, 'olga', { isListed: false });
    await entity(ru.id, 'oblomov');
    await entity(ru.id, 'zakhar');
    await entity(fr.id, 'oblomov');
    await entity(es.id, 'oblomov');

    const item = await sitemapItem('en', en.slug!);
    expect(item).toBeDefined();
    expect(new Date(item!.lastmod).toISOString()).toBe(late.toISOString());
    expect(item!.alternates).toEqual([
      { language: 'en', slug: en.slug },
      { language: 'ru', slug: ru.slug },
    ]);
    expect(item!.entities).toEqual([
      {
        key: 'oblomov',
        lastmod: early.toISOString(),
        alternates: [
          { language: 'en', slug: en.slug },
          { language: 'ru', slug: ru.slug },
        ],
      },
    ]);
    // Своя карта русской версии: zakhar там индексируется, а в кластере нет en (там он noindex).
    const ruItem = await sitemapItem('ru', ru.slug!);
    expect(ruItem!.entities.find((e) => e.key === 'zakhar')!.alternates).toEqual([
      { language: 'ru', slug: ru.slug },
    ]);
    // Книга с noindex и черновик в карту не идут вовсе (Q4).
    expect(await sitemapItem('fr', fr.slug!)).toBeUndefined();
    expect(await sitemapItem('es', es.slug!)).toBeUndefined();
  });

  it('hreflang страниц = кластер карты: список и сущность отдают те же alternates; noindex и isIndexable=false — пусто (F08-3a)', async () => {
    const book = await createBookFixture(prisma, `world-alt-${unique()}`);
    const en = await createVersion(book.id, 'en');
    const ru = await createVersion(book.id, 'ru');
    const fr = await createVersion(book.id, 'fr', { noindex: true });
    await entity(en.id, 'oblomov');
    await entity(en.id, 'zakhar', { isIndexable: false });
    await entity(ru.id, 'oblomov');
    await entity(fr.id, 'oblomov');
    const item = await sitemapItem('en', en.slug!);
    const list = await request(http()).get(`/versions/${en.id}/world`).expect(200);
    expect(list.body.alternates).toEqual(item!.alternates);
    const page = await request(http()).get(`/versions/${en.id}/world/oblomov`).expect(200);
    expect(page.body.alternates).toEqual(
      item!.entities.find((e) => e.key === 'oblomov')!.alternates,
    );
    expect(page.body.alternates).toEqual([
      { language: 'en', slug: en.slug },
      { language: 'ru', slug: ru.slug },
    ]);
    const hidden = await request(http()).get(`/versions/${en.id}/world/zakhar`).expect(200);
    expect(hidden.body.alternates).toEqual([]);
    // Страница версии с редакторским noindex есть, но вне hreflang (Q4).
    const closed = await request(http()).get(`/versions/${fr.id}/world/oblomov`).expect(200);
    expect(closed.body.alternates).toEqual([]);
    // Ответ записи несёт тот же кластер, что и список (вкладка заменяет им кэш списка).
    const saved = await request(http())
      .put(`/versions/${en.id}/world`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ language: 'en', entities: [{ key: 'oblomov', type: 'character' }] })
      .expect(200);
    expect(saved.body.world.alternates).toEqual(list.body.alternates);
  });

  it('карта: версия без публичных сущностей не идёт; версия без слага не попадает в кластер', async () => {
    const book = await createBookFixture(prisma, `world-map-empty-${unique()}`);
    const hidden = await createVersion(book.id, 'pt');
    await entity(hidden.id, 'oblomov', { isListed: false });
    expect(await sitemapItem('pt', hidden.slug!)).toBeUndefined();
    const en = await createVersion(book.id, 'en');
    await entity(en.id, 'oblomov');
    const noSlug = await createVersion(book.id, 'ru', { slug: null });
    await entity(noSlug.id, 'oblomov');
    const item = await sitemapItem('en', en.slug!);
    expect(item!.alternates).toEqual([{ language: 'en', slug: en.slug }]);
  });

  it('карта: limit сверх потолка 400, огромный page — пустая страница', async () => {
    await request(http()).get('/en/world/sitemap?limit=51').expect(400);
    const res = await request(http()).get('/en/world/sitemap?page=10000').expect(200);
    expect(res.body.items).toEqual([]);
    // Публичный кэш: ответ не зависит ни от страны, ни от роли (как карта разделов пересказа).
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('s-maxage=300');
  });

  it('список читателя отдаёт первую главу присутствия; редактор — isListed (Q2, Q3)', async () => {
    const book = await createBookFixture(prisma, `world-first-${unique()}`);
    const v = await createVersion(book.id, 'en');
    await entity(v.id, 'oblomov', { mentionFirst: 2 });
    await entity(v.id, 'olga', { isListed: false });
    const reader = await request(http()).get(`/versions/${v.id}/world`).expect(200);
    expect(reader.body.entities).toEqual([
      expect.objectContaining({ key: 'oblomov', mentionFirst: 2 }),
    ]);
    expect(reader.body.entities[0]).not.toHaveProperty('editor');
    const editor = await request(http())
      .get(`/versions/${v.id}/world`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const listed = Object.fromEntries(
      (editor.body.entities as { key: string; editor: { isListed: boolean } }[]).map((e) => [
        e.key,
        e.editor.isListed,
      ]),
    );
    expect(listed).toEqual({ oblomov: true, olga: false });
  });

  it('миграция заполняет первую главу у строк, посчитанных до колонки; повторный накат безопасен', async () => {
    const book = await createBookFixture(prisma, `world-backfill-${unique()}`);
    const v = await createVersion(book.id, 'en');
    await prisma.bookWorldEntity.create({
      data: {
        bookVersionId: v.id,
        key: 'counted',
        type: 'character',
        name: 'Counted',
        mentions: { chapters: [3, 5], first: 3 },
      },
    });
    await prisma.bookWorldEntity.create({
      data: {
        bookVersionId: v.id,
        key: 'odd',
        type: 'character',
        name: 'Odd',
        mentions: { chapters: [], first: null },
      },
    });
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        'prisma',
        'migrations',
        '20261116120000_f08_world_public',
        'migration.sql',
      ),
      'utf8',
    );
    const update = sql.slice(sql.indexOf('UPDATE "BookWorldEntity"'));
    const statement = update.slice(0, update.indexOf(';') + 1);
    await prisma.$executeRawUnsafe(statement);
    await prisma.$executeRawUnsafe(statement);
    const rows = await prisma.bookWorldEntity.findMany({
      where: { bookVersionId: v.id },
      orderBy: { key: 'asc' },
      select: { key: true, mentionFirst: true },
    });
    expect(rows).toEqual([
      { key: 'counted', mentionFirst: 3 },
      { key: 'odd', mentionFirst: null },
    ]);
  });

  it('beacon: 204, агрегат дня растёт; общая страница — пустой ключ; в строке нет посетителя (Q5)', async () => {
    const book = await createBookFixture(prisma, `world-beacon-${unique()}`);
    const v = await createVersion(book.id, 'en');
    await entity(v.id, 'oblomov');
    await beacon({ bookVersionId: v.id, key: 'oblomov', event: 'view' }).expect(204);
    await beacon({ bookVersionId: v.id, key: 'oblomov', event: 'view' }).expect(204);
    await beacon({ bookVersionId: v.id, event: 'to_reader' }).expect(204);
    await beacon({ bookVersionId: v.id, event: 'to_reader' }).expect(204);
    // Ключ-пустая строка во входе — 400, а не запись общей страницы (решение арбитра Q5a).
    await beacon({ bookVersionId: v.id, key: '', event: 'to_reader' }).expect(400);
    const rows = await statRows(v.id);
    expect(rows.map((r) => ({ key: r.key, event: r.event, count: r.count }))).toEqual([
      { key: 'oblomov', event: 'view', count: 2 },
      { key: '', event: 'to_reader', count: 2 },
    ]);
    // Схема строки — только агрегат: ни адреса, ни пользователя, ни агента.
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['bookVersionId', 'count', 'day', 'event', 'id', 'key'].sort(),
    );
  });

  // Гонка — 12 одновременных запросов к ручке. Сервер набора слушает порт (`app.listen(0)` в
  // `beforeAll`): иначе supertest поднимает свой сервер на первый запрос и закрывает его после
  // первого ответа, и остальные запросы рвутся `ECONNRESET` (прогон ci.yml 43910868382).
  it('beacon: одновременные первые события дня — все 204, одна строка с полным счётом', async () => {
    const book = await createBookFixture(prisma, `world-beacon-race-${unique()}`);
    const v = await createVersion(book.id, 'en');
    await entity(v.id, 'oblomov');
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        beacon({ bookVersionId: v.id, key: 'oblomov', event: 'to_world' }),
      ),
    );
    // Не 204 — со статусом и телом ответа в сообщении.
    expect(
      responses.filter((r) => r.status !== 204).map((r) => `${r.status} ${JSON.stringify(r.body)}`),
    ).toEqual([]);
    const rows = await statRows(v.id);
    expect(rows.map((r) => ({ key: r.key, event: r.event, count: r.count }))).toEqual([
      { key: 'oblomov', event: 'to_world', count: 12 },
    ]);
  });

  it('beacon: бот — 204 без записи; непубличная сущность и черновик — 404; мусор в теле — 400', async () => {
    const book = await createBookFixture(prisma, `world-beacon-deny-${unique()}`);
    const v = await createVersion(book.id, 'en');
    await entity(v.id, 'oblomov');
    await entity(v.id, 'olga', { isListed: false });
    await beacon({ bookVersionId: v.id, event: 'view' }, 'Googlebot/2.1').expect(204);
    await beacon({ bookVersionId: v.id, event: 'view' }, 'HeadlessChrome/120').expect(204);
    expect(await statRows(v.id)).toEqual([]);
    await beacon({ bookVersionId: v.id, key: 'olga', event: 'view' }).expect(404);
    await beacon({ bookVersionId: v.id, key: 'nobody', event: 'view' }).expect(404);
    const draft = await createVersion(book.id, 'ru', { status: 'draft' });
    await entity(draft.id, 'oblomov');
    await beacon({ bookVersionId: draft.id, event: 'view' }).expect(404);
    await beacon({ bookVersionId: v.id, event: 'click' }).expect(400);
    await beacon({ bookVersionId: v.id, key: 'Bad Key', event: 'view' }).expect(400);
    await beacon({ bookVersionId: v.id, event: 'view', ip: '1.2.3.4' }).expect(400);
    await beacon({ bookVersionId: 'not-a-uuid', event: 'view' }).expect(400);
    expect(await statRows(v.id)).toEqual([]);
  });

  it('отчёт: без токена 401, user 403, admin 200 с суммами за окно; days вне пределов — 400', async () => {
    const book = await createBookFixture(prisma, `world-report-${unique()}`);
    const v = await createVersion(book.id, 'en');
    const today = new Date(new Date().toISOString().slice(0, 10));
    const old = new Date(today.getTime() - 40 * 86_400_000);
    await prisma.worldDailyStat.createMany({
      data: [
        { day: today, bookVersionId: v.id, key: 'oblomov', event: 'view', count: 3 },
        {
          day: new Date(today.getTime() - 86_400_000),
          bookVersionId: v.id,
          key: 'oblomov',
          event: 'view',
          count: 2,
        },
        { day: today, bookVersionId: v.id, key: '', event: 'engaged', count: 1 },
        { day: old, bookVersionId: v.id, key: 'oblomov', event: 'view', count: 100 },
      ],
    });
    await request(http()).get('/admin/world/stats').expect(401);
    await request(http())
      .get('/admin/world/stats')
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(403);
    const res = await request(http())
      .get(`/admin/world/stats?bookVersionId=${v.id}&days=30`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(res.body.to).toBe(today.toISOString().slice(0, 10));
    expect(res.body.isTruncated).toBe(false);
    // Общая страница наружу — key: null (решение арбитра Q5a); язык и слаг версии — §14 п.1.
    const where = { bookVersionId: v.id, language: 'en', slug: v.slug };
    expect(res.body.items).toEqual([
      { ...where, key: null, event: 'engaged', count: 1 },
      { ...where, key: 'oblomov', event: 'view', count: 5 },
    ]);
    // Отчёт — личный ответ администратора: не в общий кэш.
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['cache-control']).not.toContain('public');
    await request(http())
      .get('/admin/world/stats?days=0')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);
    await request(http())
      .get('/admin/world/stats?days=367')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);
  });

  // Последним: ограничитель держит корзину адреса до конца окна, а адрес у всех запросов спеки один.
  it(`beacon: сверх ${WORLD_BEACON_LIMIT.points} событий в окно с одного адреса — 429`, async () => {
    const book = await createBookFixture(prisma, `world-beacon-limit-${unique()}`);
    const v = await createVersion(book.id, 'en');
    await entity(v.id, 'oblomov');
    const codes: number[] = [];
    for (let i = 0; i <= WORLD_BEACON_LIMIT.points; i++) {
      codes.push((await beacon({ bookVersionId: v.id, event: 'view' })).status);
    }
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 204).length).toBeLessThanOrEqual(WORLD_BEACON_LIMIT.points);
    const counted = (await statRows(v.id)).reduce((sum, r) => sum + r.count, 0);
    expect(counted).toBe(codes.filter((c) => c === 204).length);
  });
});
