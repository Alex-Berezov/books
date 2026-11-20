/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- тело ответа supertest типизировано как any */
import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookType, Language, RoleName } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import {
  WORLD_PAIRS,
  computeWorldListed,
  pairMembersIn,
} from '../src/modules/book-world/world-public';
import {
  WorldMentionsService,
  type WorldRecountOutcome,
} from '../src/modules/book-world/world-mentions.service';
import { WorldMentionsSchedulerService } from '../src/modules/book-world/world-mentions-scheduler.service';
import { BOOK_WORLD_LIMITS } from '../src/modules/book-world/dto/book-world-blocks.dto';
import { createBookFixture } from './helpers/book-fixture';
import { createBookWithRights } from './helpers/book-with-rights';
import { markBookRightsFreshForTests } from './helpers/rights-fresh';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F08-1: ручки мира книги (`books-app-docs/features/F08-book-wiki/tech.md` §2-§3, `batches.md` F08-1
 * «Посадка»; решения арбитра `F08 | F08-1` R1-R8, PM-3, PM-5 в `decisions-log.md`).
 */
type Body = Record<string, unknown>;

const MENTIONS_MISSING =
  'mentions: the entity is not found in any chapter yet; the page will not be published';

describe('BookWorld e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rightsContentHash: RightsContentHashService;
  let worldMentions: WorldMentionsService;
  let userAccess: string;
  let adminAccess: string;
  let managerAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** Главы версии: абзацы через `<p>` — их и сверяет дословность цитат. */
  const seedChapters = async (versionId: string, chapters: Record<number, string[]>) => {
    for (const [number, paragraphs] of Object.entries(chapters)) {
      await prisma.chapter.create({
        data: {
          bookVersionId: versionId,
          number: Number(number),
          title: `Chapter ${number}`,
          content: paragraphs.map((p) => `<p>${p}</p>`).join(''),
        },
      });
    }
  };

  const TEXT: Record<number, string[]> = {
    1: ['He lay on the sofa all morning.', 'Zakhar grumbled in the hall.'],
    2: ['The letter from the estate was still unread.', 'Olga sang Casta diva.'],
    3: ['He went to bed and dreamed of his childhood.'],
  };

  const createVersion = async (
    over: { language?: Language; status?: 'published' | 'draft'; chapters?: boolean } = {},
  ) => {
    const slug = `book-world-${unique()}`;
    const book = await createBookFixture(prisma, slug);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: over.language ?? 'en',
        title: 'Version For World',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: over.status ?? 'published',
      },
    });
    if (over.chapters !== false) await seedChapters(version.id, TEXT);
    return { bookSlug: slug, versionId: version.id };
  };

  /** Герой с полным ядром кроме присутствия (его считает `F08-2`); цитаты — дословно из `TEXT`. */
  const hero = (key = 'oblomov', over: Body = {}): Body => ({
    key,
    type: 'character',
    name: 'Ilya Oblomov',
    role: 'main',
    short: 'A landowner who rarely leaves his sofa.',
    character: 'Kind, dreamy and idle.',
    arc: { from: 'A dreamer on the sofa', to: 'A dreamer at rest' },
    scenes: [
      { chapter: 1, title: 'Morning', text: 'He does not get up.' },
      { chapter: 3, title: 'The dream', text: 'He dreams of his childhood.' },
    ],
    quotes: [
      { text: 'He lay on the sofa all morning.', chapter: 1, interpretation: 'Idleness.' },
      {
        text: 'The letter from the estate was still unread.',
        chapter: 2,
        interpretation: 'Neglect.',
      },
      { text: 'dreamed of his childhood', chapter: 3, interpretation: 'Memory.' },
    ],
    ...over,
  });

  const put = (versionId: string, body: Body, query = '', token = adminAccess) =>
    request(http())
      .put(`/versions/${versionId}/world${query}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const putEntity = (versionId: string, key: string, body: Body, query = '', token = adminAccess) =>
    request(http())
      .put(`/versions/${versionId}/world/${key}${query}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const flags = (versionId: string, key: string, body: Body, token = adminAccess) =>
    request(http())
      .patch(`/versions/${versionId}/world/${key}/flags`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const markRead = (versionId: string, key: string, body: Body, token = adminAccess) =>
    request(http())
      .post(`/versions/${versionId}/world/${key}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const remove = (versionId: string, key: string, token = adminAccess) =>
    request(http())
      .delete(`/versions/${versionId}/world/${key}`)
      .set('Authorization', `Bearer ${token}`);

  const row = (versionId: string, key: string) =>
    prisma.bookWorldEntity.findUniqueOrThrow({
      where: { bookVersionId_key: { bookVersionId: versionId, key } },
    });

  /** R1: после каждой записи столбец `isListed` равен `computeWorldListed` от строки в базе. */
  const expectListedConsistent = async (versionId: string) => {
    const rows = await prisma.bookWorldEntity.findMany({ where: { bookVersionId: versionId } });
    expect(rows.length).toBeGreaterThan(0);
    // Пара (F08-8c, Q3): оба героя ключа на сайте — по тем же строкам базы.
    const listedCharacters = new Set(
      rows.filter((r) => r.type === 'character' && r.isListed).map((r) => r.key),
    );
    for (const r of rows) {
      const hasListedMembers =
        r.type === 'pair' ? pairMembersIn(r.key, listedCharacters) : undefined;
      expect({ key: r.key, isListed: r.isListed }).toEqual({
        key: r.key,
        isListed: computeWorldListed({ ...r, hasListedMembers }),
      });
    }
  };

  /**
   * Присутствие — настоящим подсчётом `F08-2`: имя сущности дописывается отдельным абзацем в главы
   * `chapters` версии (цитаты `TEXT` остаются дословными), затем пересчёт версии. Фоновый
   * планировщик посчитал бы то же самое — подготовка не расходится с ним.
   */
  const presence = new Map<string, Map<string, { name: string; chapters: number[] }>>();
  const setMentions = async (versionId: string, key: string, chapters: number[]) => {
    const byKey =
      presence.get(versionId) ?? new Map<string, { name: string; chapters: number[] }>();
    byKey.set(key, { name: (await row(versionId, key)).name, chapters });
    presence.set(versionId, byKey);
    for (const [number, paragraphs] of Object.entries(TEXT)) {
      const names = [...byKey.values()]
        .filter((e) => e.chapters.includes(Number(number)))
        .map((e) => e.name);
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: versionId, number: Number(number) } },
        data: { content: [...paragraphs, ...names].map((p) => `<p>${p}</p>`).join('') },
      });
    }
    await expect(worldMentions.recountVersion(versionId)).resolves.toMatchObject({
      status: 'done',
    });
  };

  /** «Прочитано» последнего текста импорта (R9: импорт — текст модели, без отметки не на сайте). */
  const readLatest = async (versionId: string, key: string) => {
    const { autoTextAt } = await row(versionId, key);
    await markRead(versionId, key, { autoTextAt: autoTextAt?.toISOString() ?? null }).expect(200);
  };

  /**
   * Сущность на сайте: импорт, присутствие (его пишет `F08-2`), запись без изменений пересчитывает
   * ядро, «прочитано» — `isListed`.
   */
  const makeListed = async (versionId: string, key = 'oblomov', body: Body = hero(key)) => {
    await put(versionId, { language: 'en', entities: [body] }).expect(200);
    await setMentions(versionId, key, [1, 2, 3]);
    await put(versionId, { language: 'en', entities: [{ key, type: 'character' }] }).expect(200);
    await readLatest(versionId, key);
    expect((await row(versionId, key)).isListed).toBe(true);
  };

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
    rightsContentHash = moduleRef.get(RightsContentHashService);
    worldMentions = moduleRef.get(WorldMentionsService);
    // Пересчёт в спеке зовётся руками: фоновый такт планировщика не должен забирать строки
    // очереди между подготовкой теста и его вызовом.
    await moduleRef.get(WorldMentionsSchedulerService).onModuleDestroy();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    userAccess = await register(`user_world_${Date.now()}@example.com`);
    adminAccess = await register('admin@example.com');
    await grantStaffRoles(app, 'admin@example.com');
    const managerEmail = `cm_world_${Date.now()}@example.com`;
    managerAccess = await register(managerEmail);
    await grantStaffRoles(app, managerEmail, [RoleName.content_manager]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('эталоны ru/en сохраняются: 200; ядро по присутствию — после пересчёта очереди (F08-2, R2)', async () => {
    const book = await createBookFixture(prisma, `book-world-ref-${unique()}`);
    for (const language of [Language.ru, Language.en]) {
      const body = JSON.parse(
        readFileSync(join(__dirname, 'fixtures', `example-world.${language}.json`), 'utf8'),
      ) as { language: Language; entities: { quotes: { text: string; chapter: number }[] }[] };
      const version = await prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language,
          title: 'Reference',
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'published',
        },
      });
      // Главы засеяны текстом, где каждая цитата эталона стоит дословно в своей главе.
      const chapters: Record<number, string[]> = {};
      for (const n of [1, 2, 3, 4, 5, 6]) chapters[n] = [`Chapter ${n} opening.`];
      for (const q of body.entities.flatMap((e) => e.quotes)) {
        chapters[q.chapter] = [...(chapters[q.chapter] ?? []), q.text];
      }
      await seedChapters(version.id, chapters);

      const res = await put(version.id, body);
      expect({ language, status: res.status, body: res.status === 200 ? null : res.body }).toEqual({
        language,
        status: 200,
        body: null,
      });
      // F08-2 (R2): запись присутствие не считает — у новых сущностей ядра нет только из-за него.
      for (const [i, e] of (res.body.entities as Body[]).entries()) {
        expect(e).toMatchObject({ created: true, hasCore: false });
        expect(e.warnings).toEqual([
          { code: 'core_incomplete', path: `entities.${i}.mentions`, message: MENTIONS_MISSING },
        ]);
      }
      // Пересчёт по тексту глав — это строки цитат эталона. Имя Сони стоит в её цитате
      // («Сонечка», «Sonia»): ядро полное. Имени Раскольникова в его цитатах нет.
      await drain(version.id);
      const sonya = await row(version.id, 'sonya');
      expect(sonya.hasCore).toBe(true);
      expect((sonya.mentions as { chapters: number[] }).chapters).toContain(4);
      const raskolnikov = await row(version.id, 'raskolnikov');
      expect(raskolnikov.hasCore).toBe(false);
      expect(raskolnikov.coreMissing).toEqual(['mentions']);
      await expectListedConsistent(version.id);

      // F08-8c: эталон пары (`prompts/example-world-pair.{ru,en}.json`) — вторым импортом, когда
      // герои уже в мире; заводится связью героев в анализе. Его цитаты — из эталона героев.
      const pairBody = JSON.parse(
        readFileSync(join(__dirname, 'fixtures', `example-world-pair.${language}.json`), 'utf8'),
      ) as { language: Language; entities: Body[] };
      await prisma.bookAnalysis.create({
        data: {
          bookVersionId: version.id,
          characters: [
            {
              key: 'raskolnikov',
              name: 'R',
              role: 'main',
              relations: [{ to: 'sonya', label: 'x' }],
            },
          ],
        },
      });
      const pairRes = await put(version.id, pairBody);
      expect({
        language,
        status: pairRes.status,
        body: pairRes.status === 200 ? null : pairRes.body,
      }).toEqual({
        language,
        status: 200,
        body: null,
      });
      // Ядру пары не хватает только общих глав: имени Раскольникова в тексте глав эталона нет.
      expect(pairRes.body.entities[0]).toMatchObject({
        key: 'raskolnikov--sonya',
        created: true,
        hasCore: false,
      });
      expect(pairRes.body.entities[0].warnings.map((w: { path: string }) => w.path)).toEqual([
        'entities.0.mentions',
      ]);
    }
  });

  it('неизвестный relations.0.to — 400 с путём', async () => {
    const { versionId } = await createVersion();
    const res = await put(versionId, {
      language: 'en',
      entities: [hero('oblomov', { relations: [{ to: 'nobody', label: 'friend' }] })],
    }).expect(400);
    expect(res.body.message).toEqual([
      'entities.0.relations.0.to: unknown entity or character key "nobody"',
    ]);
  });

  it('связь на героя анализа без сущности мира проходит (R7)', async () => {
    const { versionId } = await createVersion();
    await prisma.bookAnalysis.create({
      data: { bookVersionId: versionId, characters: [{ key: 'olga', name: 'Olga', role: 'main' }] },
    });
    await put(versionId, {
      language: 'en',
      entities: [hero('oblomov', { relations: [{ to: 'olga', label: 'loves' }] })],
    }).expect(200);
  });

  it('DELETE: ссылка на ключ, который есть и у героя анализа, удалению не мешает', async () => {
    const { versionId } = await createVersion();
    await prisma.bookAnalysis.create({
      data: { bookVersionId: versionId, characters: [{ key: 'olga', name: 'Olga', role: 'main' }] },
    });
    await put(versionId, {
      language: 'en',
      entities: [
        hero('olga', { name: 'Olga' }),
        hero('oblomov', { relations: [{ to: 'olga', label: 'loves' }] }),
      ],
    }).expect(200);
    await remove(versionId, 'olga').expect(204);
  });

  it('глава не из версии — 400 с путём (R4), и в dryRun', async () => {
    const { versionId } = await createVersion();
    const body = {
      language: 'en',
      entities: [hero('oblomov', { scenes: [{ chapter: 9, title: 'T', text: 'S' }] })],
    };
    for (const query of ['', '?dryRun=true']) {
      const res = await put(versionId, body, query).expect(400);
      expect(res.body.message).toEqual([
        'entities.0.scenes.0.chapter: chapter 9 is not in this version',
      ]);
    }
  });

  it('цитата не дословно в своей главе — 400 с путём (R8): импорт версии, dryRun и PUT сущности', async () => {
    const { versionId } = await createVersion();
    const quotes = [
      { text: 'He lay on the sofa all morning.', chapter: 1, interpretation: 'i' },
      // Дословно есть, но в главе 1, а не 2.
      { text: 'Zakhar grumbled in the hall.', chapter: 2, interpretation: 'i' },
    ];
    for (const query of ['', '?dryRun=true']) {
      const res = await put(
        versionId,
        { language: 'en', entities: [hero('oblomov', { quotes })] },
        query,
      ).expect(400);
      expect(res.body.message).toEqual([
        'entities.0.quotes.1.text: the quote is not found verbatim in chapter 2',
      ]);
    }
    const res = await putEntity(versionId, 'oblomov', {
      language: 'en',
      ...hero('oblomov', { quotes }),
    }).expect(400);
    expect(res.body.message).toEqual([
      'quotes.1.text: the quote is not found verbatim in chapter 2',
    ]);
    expect(await prisma.bookWorldEntity.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('язык JSON не язык версии — 400; type ≠ character — 400', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'ru', entities: [hero()] }).expect(400);
    const res = await put(versionId, {
      language: 'en',
      entities: [hero('x', { type: 'place' })],
    }).expect(400);
    expect(JSON.stringify(res.body.message)).toContain('entities.0.type');
  });

  it('новая сущность без имени — 400 с путём; дубль ключа — 400', async () => {
    const { versionId } = await createVersion();
    const noName = await put(versionId, {
      language: 'en',
      entities: [{ key: 'zakhar', type: 'character' }],
    }).expect(400);
    expect(noName.body.message).toEqual(['entities.0.name: name is required for a new entity']);
    const dup = await put(versionId, { language: 'en', entities: [hero('a'), hero('a')] }).expect(
      400,
    );
    expect(dup.body.message).toEqual(['entities.1.key: duplicate key "a"']);
  });

  it('слияние: поля нет — прежнее, null — очищено, список заменён, сущность вне тела жива', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [hero('oblomov', { appearance: 'Plump.' }), hero('zakhar', { name: 'Zakhar' })],
    }).expect(200);
    await put(versionId, {
      language: 'en',
      entities: [
        {
          key: 'oblomov',
          type: 'character',
          appearance: null,
          scenes: [{ chapter: 2, title: 'Letter', text: 'He ignores the letter.' }],
        },
      ],
    }).expect(200);
    const res = await request(http())
      .get(`/versions/${versionId}/world/oblomov`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(res.body.entity.short).toBe('A landowner who rarely leaves his sofa.');
    expect(res.body.entity.appearance).toBeNull();
    expect(res.body.entity.scenes).toEqual([
      { chapter: 2, title: 'Letter', text: 'He ignores the letter.' },
    ]);
    expect(res.body.entity.quotes).toHaveLength(3);
    expect((await row(versionId, 'zakhar')).name).toBe('Zakhar');
    await expectListedConsistent(versionId);
  });

  it('PUT сущности: ключ тела ≠ адресу — 400; неверный ключ адреса — 404; запись и isListed', async () => {
    const { versionId } = await createVersion();
    await putEntity(versionId, 'oblomov', { language: 'en', ...hero('zakhar') }).expect(400);
    await putEntity(versionId, 'A_b', { language: 'en', type: 'character', name: 'X' }).expect(404);
    const fields = hero();
    delete fields.key;
    const res = await putEntity(versionId, 'oblomov', { language: 'en', ...fields }).expect(200);
    expect(res.body.entity.key).toBe('oblomov');
    expect(res.body.entity.editor.missing).toEqual(['mentions']);
    expect(res.body.warnings).toEqual([
      { code: 'core_incomplete', path: 'mentions', message: MENTIONS_MISSING },
    ]);
    await expectListedConsistent(versionId);
  });

  it('черновик версии: аноним 404, редактор 200', async () => {
    const { versionId } = await createVersion({ status: 'draft' });
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    await request(http()).get(`/versions/${versionId}/world`).expect(404);
    await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(404);
    const editor = await request(http())
      .get(`/versions/${versionId}/world`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(editor.body.entities.map((e: Body) => e.key)).toEqual(['oblomov']);
    await request(http())
      .get(`/versions/${versionId}/world/oblomov`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
  });

  it('непубличная сущность: аноним 404 и не в списке, редактор видит с отметками', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(404);
    await request(http())
      .get(`/versions/${versionId}/world/oblomov`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(404);
    const list = await request(http()).get(`/versions/${versionId}/world`).expect(200);
    // F08-3a: без публичных сущностей и кластер hreflang пуст.
    expect(list.body).toEqual({ language: 'en', entities: [], alternates: [] });
    const editor = await request(http())
      .get(`/versions/${versionId}/world/oblomov`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    // Импорт — текст модели (R9): `autoTextAt` есть, отметки «прочитано» нет.
    expect(editor.body.entity.editor).toMatchObject({ isVisible: true, readAt: null });
    expect(editor.body.entity.editor.autoTextAt).toBe(
      (await row(versionId, 'oblomov')).autoTextAt?.toISOString(),
    );
  });

  it('публичная сущность: читателю без служебных полей, firstPublishedAt ставит запись (R2)', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    expect((await row(versionId, 'oblomov')).firstPublishedAt).toBeInstanceOf(Date);

    const res = await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200);
    expect(res.body.language).toBe('en');
    expect(res.body.chapterNumbers).toEqual([1, 2, 3]);
    expect(Object.keys(res.body.entity).sort()).toEqual(
      [
        'key',
        'type',
        'name',
        'role',
        'short',
        'hasCore',
        'isIndexable',
        // F08-3: «впервые — глава N» колонкой (решение арбитра Q2).
        'mentionFirst',
        'updatedAt',
        'aliases',
        'profile',
        'appearance',
        'character',
        'arc',
        'scenes',
        'relations',
        'quotes',
        'critique',
        'prototypes',
        'adaptations',
        // F08-8c: поля пары — один тип ответа на все сущности, у героя они null.
        'compare',
        'bonds',
        'differences',
        'conclusion',
        'faq',
        'sources',
        'mentions',
        'createdAt',
      ].sort(),
    );
    expect(res.body.entity.hasCore).toBe(true);
    expect(res.body.entity.mentions).toEqual({
      chapters: [1, 2, 3],
      first: 1,
      perChapter: [
        { chapter: 1, count: 1 },
        { chapter: 2, count: 1 },
        { chapter: 3, count: 1 },
      ],
      coPresence: [],
    });
    const list = await request(http()).get(`/versions/${versionId}/world`).expect(200);
    expect(list.body.entities).toHaveLength(1);
    expect(list.body.entities[0].editor).toBeUndefined();
    await expectListedConsistent(versionId);
  });

  it('второстепенный герой: на сайте только от WORLD_MIN_CHAPTERS глав (PM-3)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [hero('olga', { role: 'secondary' })],
    }).expect(200);
    await setMentions(versionId, 'olga', [1, 2]);
    await readLatest(versionId, 'olga');
    expect((await row(versionId, 'olga')).isListed).toBe(false);
    await setMentions(versionId, 'olga', [1, 2, 3]);
    await flags(versionId, 'olga', { isIndexable: true }).expect(200);
    expect((await row(versionId, 'olga')).isListed).toBe(true);
    await expectListedConsistent(versionId);
  });

  it('обзор книги: _count.worldEntities и worldKeys — только isListed', async () => {
    const { versionId, bookSlug } = await createVersion();
    await makeListed(versionId, 'oblomov');
    await put(versionId, { language: 'en', entities: [hero('zakhar', { name: 'Zakhar' })] }).expect(
      200,
    );
    await flags(versionId, 'oblomov', { isIndexable: false }).expect(200);
    const ov = await request(http()).get(`/en/books/${bookSlug}/overview`).expect(200);
    expect(ov.body.versions[0]._count.worldEntities).toBe(1);
    expect(ov.body.versions[0].worldKeys).toEqual([
      { key: 'oblomov', type: 'character', name: 'Ilya Oblomov', isIndexable: false },
    ]);
    expect(ov.body.versions[0].worldEntities).toBeUndefined();

    await flags(versionId, 'oblomov', { isVisible: false }).expect(200);
    const hidden = await request(http()).get(`/en/books/${bookSlug}/overview`).expect(200);
    expect(hidden.body.versions[0]._count.worldEntities).toBe(0);
    expect(hidden.body.versions[0].worldKeys).toEqual([]);
    await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(404);
    await expectListedConsistent(versionId);
  });

  it('flags: пустое тело — 400; isListed пересчитан', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    await flags(versionId, 'oblomov', {}).expect(400);
    const res = await flags(versionId, 'oblomov', { isVisible: false }).expect(200);
    expect(res.body.editor.isVisible).toBe(false);
    expect((await row(versionId, 'oblomov')).isListed).toBe(false);
    await expectListedConsistent(versionId);
  });

  it('DELETE: после firstPublishedAt — 409 WORLD_ENTITY_PUBLISHED даже скрытой', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    const live = await remove(versionId, 'oblomov').expect(409);
    expect(live.body.code).toBe('WORLD_ENTITY_PUBLISHED');
    await flags(versionId, 'oblomov', { isVisible: false }).expect(200);
    const hidden = await remove(versionId, 'oblomov').expect(409);
    expect(hidden.body.code).toBe('WORLD_ENTITY_PUBLISHED');
    expect(await row(versionId, 'oblomov')).toBeTruthy();
  });

  it('DELETE: публична сейчас без firstPublishedAt — 409; на неё ссылаются — 409; иначе 204', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    await prisma.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId: versionId, key: 'oblomov' } },
      data: { firstPublishedAt: null },
    });
    expect((await remove(versionId, 'oblomov').expect(409)).body.code).toBe(
      'WORLD_ENTITY_PUBLISHED',
    );

    await put(versionId, {
      language: 'en',
      entities: [
        hero('zakhar', { name: 'Zakhar' }),
        hero('anisya', { name: 'Anisya', relations: [{ to: 'zakhar', label: 'wife' }] }),
      ],
    }).expect(200);
    const referenced = await remove(versionId, 'zakhar').expect(409);
    expect(referenced.body).toMatchObject({
      code: 'WORLD_ENTITY_REFERENCED',
      referencedBy: ['anisya'],
    });
    await remove(versionId, 'anisya').expect(204);
    await remove(versionId, 'zakhar').expect(204);
    await remove(versionId, 'zakhar').expect(404);
    await expectListedConsistent(versionId);
  });

  it('публикация версии ставит firstPublishedAt сущностям на сайте (R2)', async () => {
    const slug = `book-world-pub-${unique()}`;
    const withRights = await createBookWithRights(prisma, slug);
    const created = await request(http())
      .post(`/books/${withRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        language: Language.en,
        title: 'World Publish',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const versionId = created.body.id as string;
    await seedChapters(versionId, TEXT);
    await makeListed(versionId);
    await put(versionId, { language: 'en', entities: [hero('zakhar', { name: 'Zakhar' })] }).expect(
      200,
    );
    // Черновик: на сайте её нет, `firstPublishedAt` запись не ставит.
    expect((await row(versionId, 'oblomov')).firstPublishedAt).toBeNull();
    const beforePublish = (await row(versionId, 'oblomov')).updatedAt;

    await markBookRightsFreshForTests(prisma, withRights.book.id, rightsContentHash);
    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect((await row(versionId, 'oblomov')).firstPublishedAt).toBeInstanceOf(Date);
    // Отметка первого показа — не правка сущности: `updatedAt` (сверка вкладки) прежний.
    expect((await row(versionId, 'oblomov')).updatedAt).toEqual(beforePublish);
    expect((await row(versionId, 'zakhar')).firstPublishedAt).toBeNull();
    expect((await remove(versionId, 'oblomov').expect(409)).body.code).toBe(
      'WORLD_ENTITY_PUBLISHED',
    );
  });

  it('«прочитано»: content_manager 403, без текста модели 409 AUTO_TEXT_NONE, устаревший 409, иначе 200', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    await markRead(versionId, 'oblomov', { autoTextAt: null }, managerAccess).expect(403);
    // Текста модели нет: импорт его ставит всегда (R9), поэтому «нет» — подготовкой данных.
    await prisma.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId: versionId, key: 'oblomov' } },
      data: { autoTextAt: null },
    });
    const none = await markRead(versionId, 'oblomov', { autoTextAt: null }).expect(409);
    expect(none.body.code).toBe('AUTO_TEXT_NONE');

    const autoTextAt = new Date('2026-11-14T10:00:00.000Z');
    await setMentions(versionId, 'oblomov', [1]);
    await prisma.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId: versionId, key: 'oblomov' } },
      data: { autoTextAt },
    });
    // Запись без изменений пересчитала ядро, `autoTextAt` не тронут: ядро полное, текст не прочитан.
    await put(versionId, {
      language: 'en',
      entities: [{ key: 'oblomov', type: 'character' }],
    }).expect(200);
    expect((await row(versionId, 'oblomov')).isListed).toBe(false);

    const stale = await markRead(versionId, 'oblomov', {
      autoTextAt: '2026-11-14T09:00:00.000Z',
    }).expect(409);
    expect(stale.body.code).toBe('WORLD_TEXT_CHANGED');
    expect((await markRead(versionId, 'oblomov', { autoTextAt: null }).expect(409)).body.code).toBe(
      'WORLD_TEXT_CHANGED',
    );
    await markRead(versionId, 'oblomov', { autoTextAt: 'yesterday' }).expect(400);

    const ok = await markRead(versionId, 'oblomov', {
      autoTextAt: autoTextAt.toISOString(),
    }).expect(200);
    expect(new Date(ok.body.editor.readAt).getTime()).toBeGreaterThanOrEqual(autoTextAt.getTime());
    expect((await row(versionId, 'oblomov')).isListed).toBe(true);
    expect((await row(versionId, 'oblomov')).autoTextAt).toEqual(autoTextAt);
    await expectListedConsistent(versionId);
  });

  it('R9: импорт ставит autoTextAt изменённым сущностям; без изменений и флаги — не трогают', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    const first = await row(versionId, 'oblomov');
    expect(first.autoTextAt).toBeInstanceOf(Date);
    await setMentions(versionId, 'oblomov', [1, 2, 3]);
    await put(versionId, {
      language: 'en',
      entities: [{ key: 'oblomov', type: 'character' }],
    }).expect(200);
    // Полное ядро, но текст импорта не прочитан — не на сайте.
    expect((await row(versionId, 'oblomov')).isListed).toBe(false);

    await readLatest(versionId, 'oblomov');
    const read = await row(versionId, 'oblomov');
    expect(read.isListed).toBe(true);
    expect(read.autoTextAt).toEqual(first.autoTextAt);

    // Импорт без изменений (то же тело целиком) и флаги — autoTextAt прежний, на сайте.
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    await flags(versionId, 'oblomov', { isIndexable: false }).expect(200);
    const same = await row(versionId, 'oblomov');
    expect(same.autoTextAt).toEqual(first.autoTextAt);
    expect(same.isListed).toBe(true);

    // Импорт с изменением — новый autoTextAt позже отметки, readAt прежний, не на сайте.
    await putEntity(versionId, 'oblomov', {
      language: 'en',
      type: 'character',
      short: 'Changed.',
    }).expect(200);
    const changed = await row(versionId, 'oblomov');
    expect(changed.autoTextAt!.getTime()).toBeGreaterThan(read.readAt!.getTime());
    expect(changed.readAt).toEqual(read.readAt);
    expect(changed.isListed).toBe(false);
    await expectListedConsistent(versionId);
  });

  it('dryRun: 200, world=null, в базе пусто, autoTextAt не поставлен', async () => {
    const { versionId } = await createVersion();
    const res = await put(versionId, { language: 'en', entities: [hero()] }, '?dryRun=true').expect(
      200,
    );
    expect(res.body.world).toBeNull();
    expect(res.body.entities).toEqual([
      {
        key: 'oblomov',
        created: true,
        hasCore: false,
        warnings: [
          { code: 'core_incomplete', path: 'entities.0.mentions', message: MENTIONS_MISSING },
        ],
      },
    ]);
    const one = await putEntity(
      versionId,
      'oblomov',
      { language: 'en', type: 'character', name: 'X' },
      '?dryRun=true',
    ).expect(200);
    expect(one.body.entity).toBeNull();
    expect(await prisma.bookWorldEntity.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('entities: [] — 200, ничего не пишется, world — текущий набор', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    const before = await row(versionId, 'oblomov');
    const res = await put(versionId, { language: 'en', entities: [] }).expect(200);
    expect(res.body.entities).toEqual([]);
    expect(res.body.world.entities.map((e: Body) => e.key)).toEqual(['oblomov']);
    expect((await row(versionId, 'oblomov')).updatedAt).toEqual(before.updatedAt);
  });

  it('имя существующей сущности не очищается — 400 «name cannot be cleared»', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    const res = await put(versionId, {
      language: 'en',
      entities: [{ key: 'oblomov', type: 'character', name: null }],
    }).expect(400);
    expect(res.body.message).toEqual(['entities.0.name: name cannot be cleared']);
  });

  it('GET: Cache-Control private, no-store и Vary у списка и страницы; строка списка — только сводка', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    const headersOf = (res: request.Response) => ({
      cache: res.headers['cache-control'],
      varyAuthorization: String(res.headers.vary).includes('Authorization'),
    });
    const expected = { cache: 'private, no-store', varyAuthorization: true };
    expect(
      headersOf(await request(http()).get(`/versions/${versionId}/world`).expect(200)),
    ).toEqual(expected);
    expect(
      headersOf(await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200)),
    ).toEqual(expected);
    const list = await request(http()).get(`/versions/${versionId}/world`).expect(200);
    expect(Object.keys(list.body.entities[0]).sort()).toEqual(
      [
        'key',
        'type',
        'name',
        'role',
        'short',
        'hasCore',
        'isIndexable',
        'mentionFirst',
        'updatedAt',
        // F08-5a: формы имени для перелинковки — только читателю (решение арбитра `F08 | F08-5` Q2).
        'forms',
      ].sort(),
    );
    const editor = await request(http())
      .get(`/versions/${versionId}/world`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    // F08-2: в строке списка редактору — число глав присутствия (колонка), без Json `mentions`.
    expect(Object.keys(editor.body.entities[0].editor).sort()).toEqual(
      [
        // F08-3: публичность без версии — ссылка вкладки на страницу (решение арбитра Q3).
        'isListed',
        'isVisible',
        'readAt',
        'autoTextAt',
        'firstPublishedAt',
        'missing',
        'mentionChapters',
      ].sort(),
    );
    expect(editor.body.entities[0].editor.missing).toEqual([]);
    expect(editor.body.entities[0].editor.mentionChapters).toBe(3);
  });

  it('роли записи: без токена 401, user 403, content_manager 200', async () => {
    const { versionId } = await createVersion();
    const body = { language: 'en', entities: [hero()] };
    await request(http()).put(`/versions/${versionId}/world`).send(body).expect(401);
    await put(versionId, body, '', userAccess).expect(403);
    await put(versionId, body, '', managerAccess).expect(200);
    await putEntity(
      versionId,
      'oblomov',
      { language: 'en', type: 'character' },
      '',
      userAccess,
    ).expect(403);
    await flags(versionId, 'oblomov', { isIndexable: false }, userAccess).expect(403);
    await flags(versionId, 'oblomov', { isIndexable: false }, managerAccess).expect(200);
    await remove(versionId, 'oblomov', userAccess).expect(403);
    await markRead(versionId, 'oblomov', { autoTextAt: null }, userAccess).expect(403);
    await request(http()).delete(`/versions/${versionId}/world/oblomov`).expect(401);
  });

  it('сверка версии (R6): устаревший expectedUpdatedAt 409, expectedAbsent при сущностях 409, оба — 400', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }, '?expectedAbsent=true').expect(
      200,
    );
    const seen = (await row(versionId, 'oblomov')).updatedAt.toISOString();
    await put(versionId, { language: 'en', entities: [hero('zakhar', { name: 'Zakhar' })] }).expect(
      200,
    );

    const body = {
      language: 'en',
      entities: [{ key: 'oblomov', type: 'character', short: 'New.' }],
    };
    const stale = await put(versionId, body, `?expectedUpdatedAt=${seen}`).expect(409);
    expect(stale.body.code).toBe('RECORD_CHANGED');
    const absent = await put(versionId, body, '?expectedAbsent=true').expect(409);
    expect(absent.body.code).toBe('RECORD_CHANGED');
    await put(versionId, body, `?expectedAbsent=true&expectedUpdatedAt=${seen}`).expect(400);

    const latest = (await row(versionId, 'zakhar')).updatedAt.toISOString();
    await put(versionId, body, `?expectedUpdatedAt=${latest}`).expect(200);
    expect((await row(versionId, 'oblomov')).updatedAt.toISOString()).not.toBe(seen);
  });

  it('сверка при исчезнувшей строке: expectedUpdatedAt, а сущности (или всех сущностей) нет — 409', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    const seen = (await row(versionId, 'oblomov')).updatedAt.toISOString();
    await remove(versionId, 'oblomov').expect(204);
    const entity = await putEntity(
      versionId,
      'oblomov',
      { language: 'en', ...hero() },
      `?expectedUpdatedAt=${seen}`,
    ).expect(409);
    expect(entity.body.code).toBe('RECORD_CHANGED');
    const version = await put(
      versionId,
      { language: 'en', entities: [hero()] },
      `?expectedUpdatedAt=${seen}`,
    ).expect(409);
    expect(version.body.code).toBe('RECORD_CHANGED');
    expect(await prisma.bookWorldEntity.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('R6: «прочитано» и флаги не сдвигают updatedAt; сверка вкладки видит только правки текста', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero()] }).expect(200);
    const seen = (await row(versionId, 'oblomov')).updatedAt;

    await readLatest(versionId, 'oblomov');
    await flags(versionId, 'oblomov', { isIndexable: false }).expect(200);
    expect((await row(versionId, 'oblomov')).updatedAt).toEqual(seen);

    // Вкладка А после своего флага сохраняет с прежним `expectedUpdatedAt` — проходит.
    const edit = { language: 'en', type: 'character', short: 'Edited by A.' };
    await putEntity(versionId, 'oblomov', edit, `?expectedUpdatedAt=${seen.toISOString()}`).expect(
      200,
    );
    const afterA = (await row(versionId, 'oblomov')).updatedAt;

    // Б сохранил текст, А поставила флаг и сохраняет с прежним `expectedUpdatedAt` — 409.
    await putEntity(versionId, 'oblomov', {
      language: 'en',
      type: 'character',
      short: 'By B.',
    }).expect(200);
    await flags(versionId, 'oblomov', { isIndexable: true }).expect(200);
    const conflict = await putEntity(
      versionId,
      'oblomov',
      edit,
      `?expectedUpdatedAt=${afterA.toISOString()}`,
    ).expect(409);
    expect(conflict.body.code).toBe('RECORD_CHANGED');
    expect((await row(versionId, 'oblomov')).short).toBe('By B.');
  });

  it(`предел ${BOOK_WORLD_LIMITS.entities} сущностей после слияния: 101-я — 400 с путём`, async () => {
    const { versionId } = await createVersion();
    await prisma.bookWorldEntity.createMany({
      data: Array.from({ length: BOOK_WORLD_LIMITS.entities }, (_, i) => ({
        bookVersionId: versionId,
        key: `h${i}`,
        type: 'character' as const,
        name: `Hero ${i}`,
      })),
    });
    const res = await put(versionId, { language: 'en', entities: [hero('extra')] }).expect(400);
    expect(res.body.message).toEqual([
      `entities: the version would hold ${BOOK_WORLD_LIMITS.entities + 1} entities, at most ${BOOK_WORLD_LIMITS.entities}`,
    ]);
    await put(versionId, { language: 'en', entities: [hero('h0')] }).expect(200);
    expect(await prisma.bookWorldEntity.count({ where: { bookVersionId: versionId } })).toBe(
      BOOK_WORLD_LIMITS.entities,
    );
  });

  it('сверка версии по числу сущностей: удалили A, max(updatedAt) прежний — 409; с expectedAbsent — 400', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero('a', { name: 'A' })] }).expect(200);
    await put(versionId, { language: 'en', entities: [hero('b', { name: 'B' })] }).expect(200);
    const t2 = (await row(versionId, 'b')).updatedAt.toISOString();
    await remove(versionId, 'a').expect(204);

    const body = { language: 'en', entities: [hero('c', { name: 'C' })] };
    const stale = await put(versionId, body, `?expectedUpdatedAt=${t2}&expectedCount=2`).expect(
      409,
    );
    expect(stale.body.code).toBe('RECORD_CHANGED');
    await put(versionId, body, '?expectedAbsent=true&expectedCount=0').expect(400);
    await put(versionId, body, `?expectedUpdatedAt=${t2}&expectedCount=1`).expect(200);
  });

  it('повторный импорт того же JSON не пишет: updatedAt прежний, вторая вкладка сохраняет без 409', async () => {
    const { versionId } = await createVersion();
    const body = { language: 'en', entities: [hero()] };
    await put(versionId, body).expect(200);
    const seen = (await row(versionId, 'oblomov')).updatedAt;
    await put(versionId, body).expect(200);
    await putEntity(versionId, 'oblomov', { language: 'en', ...hero() }).expect(200);
    expect((await row(versionId, 'oblomov')).updatedAt).toEqual(seen);

    await putEntity(
      versionId,
      'oblomov',
      { language: 'en', type: 'character', short: 'From the second tab.' },
      `?expectedUpdatedAt=${seen.toISOString()}`,
    ).expect(200);
    expect((await row(versionId, 'oblomov')).short).toBe('From the second tab.');
  });

  // ---- F08-2: формы имени и присутствие по главам (`batches.md` F08-2 «Посадка»; Q1–Q4) ----

  const chapterId = async (versionId: string, number: number) =>
    (
      await prisma.chapter.findUniqueOrThrow({
        where: { bookVersionId_number: { bookVersionId: versionId, number } },
        select: { id: true },
      })
    ).id;
  const pending = (versionId: string) =>
    prisma.worldMentionsPending.findUnique({ where: { bookVersionId: versionId } });
  /** Очередь общая на набор: проходы, пока строка версии не снята (проход берёт старшие пять). */
  const drain = async (versionId: string) => {
    for (let i = 0; i < 100 && (await pending(versionId)); i++) {
      await worldMentions.recountPending(0);
    }
  };

  it('F08-2: запись ставит версию в очередь; присутствие по формам имени считает пересчёт (R2)', async () => {
    const { versionId } = await createVersion();
    const res = await put(versionId, {
      language: 'en',
      entities: [hero('olga', { name: 'Olga', aliases: ['Olga Ilyinskaya'] })],
    }).expect(200);
    expect(res.body.entities[0].hasCore).toBe(false);
    expect((await row(versionId, 'olga')).mentions).toBeNull();
    expect(await pending(versionId)).not.toBeNull();
    await drain(versionId);
    const saved = await row(versionId, 'olga');
    expect(saved.mentions).toMatchObject({ chapters: [2], first: 2, perChapter: { '2': 1 } });
    expect(saved.mentionsAt).toBeInstanceOf(Date);
    expect(saved.mentionChapters).toBe(1);
    expect(saved.hasCore).toBe(true);
  });

  it('F08-2: правка во время пересчёта не теряется — generation растёт, строка остаётся (R1)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero('olga', { name: 'Olga' })] }).expect(
      200,
    );
    const before = (await pending(versionId))!;
    const real = worldMentions.recountVersion.bind(worldMentions);
    const spy = jest.spyOn(worldMentions, 'recountVersion').mockImplementationOnce(async (id) => {
      const outcome: WorldRecountOutcome = await real(id);
      // Правка главы, закоммиченная между подсчётом и снятием строки.
      await request(http())
        .patch(`/chapters/${await chapterId(versionId, 1)}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ content: '<p>Olga came back.</p>' })
        .expect(200);
      return outcome;
    });
    try {
      await worldMentions.recountPending(0);
    } finally {
      spy.mockRestore();
    }
    const after = await pending(versionId);
    expect(after).not.toBeNull();
    // Номер постановки — из последовательности базы: только растёт.
    expect(after!.generation).toBeGreaterThan(before.generation);
    await drain(versionId);
    expect((await row(versionId, 'olga')).mentions).toMatchObject({ chapters: [1, 2] });
  });

  it('F08-2: неудачный пересчёт откладывается нарастающей паузой; новая правка сбрасывает её (R3)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero('olga', { name: 'Olga' })] }).expect(
      200,
    );
    const spy = jest
      .spyOn(worldMentions, 'recountVersion')
      .mockRejectedValue(new Error('broken version'));
    try {
      for (const attempts of [1, 2]) {
        await prisma.worldMentionsPending.update({
          where: { bookVersionId: versionId },
          data: { dirtyAt: new Date(Date.now() - 60_000) },
        });
        await worldMentions.recountPending(0);
        const row = (await pending(versionId))!;
        expect(row.attempts).toBe(attempts);
        // 15 с · 2^(attempts-1) вперёд от часов базы.
        const ahead = row.dirtyAt.getTime() - Date.now();
        expect(ahead).toBeGreaterThan(15_000 * 2 ** (attempts - 1) - 5_000);
        expect(ahead).toBeLessThan(15_000 * 2 ** (attempts - 1) + 5_000);
      }
      // Потолок паузы — час, и после многих попыток подряд степень не переполняется.
      await prisma.worldMentionsPending.update({
        where: { bookVersionId: versionId },
        data: { dirtyAt: new Date(Date.now() - 60_000), attempts: 2000 },
      });
      await worldMentions.recountPending(0);
      const capped = (await pending(versionId))!;
      expect(capped.attempts).toBe(2001);
      const ahead = capped.dirtyAt.getTime() - Date.now();
      expect(ahead).toBeGreaterThan(3_600_000 - 5_000);
      expect(ahead).toBeLessThan(3_600_000 + 5_000);
    } finally {
      spy.mockRestore();
    }
    await request(http())
      .patch(`/chapters/${await chapterId(versionId, 1)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ content: '<p>Olga again.</p>' })
      .expect(200);
    expect((await pending(versionId))!.attempts).toBe(0);
  });

  it('F08-2: проход берёт только осевшие строки: свежая и отложенная ждут (часы базы)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero('olga', { name: 'Olga' })] }).expect(
      200,
    );
    // Строка только что поставлена: при осадке 10 с проход её не берёт.
    await worldMentions.recountPending(10_000);
    expect(await pending(versionId)).not.toBeNull();
    expect((await row(versionId, 'olga')).mentions).toBeNull();
    // Отложенная после сбоя (dirtyAt в будущем) не берётся и без осадки.
    await prisma.worldMentionsPending.update({
      where: { bookVersionId: versionId },
      data: { dirtyAt: new Date(Date.now() + 60_000) },
    });
    await worldMentions.recountPending(0);
    expect(await pending(versionId)).not.toBeNull();
    // Осела — берётся.
    await prisma.worldMentionsPending.update({
      where: { bookVersionId: versionId },
      data: { dirtyAt: new Date(Date.now() - 60_000) },
    });
    await drain(versionId);
    expect(await pending(versionId)).toBeNull();
    expect((await row(versionId, 'olga')).mentions).not.toBeNull();
  });

  it('F08-2: сдвиг во время подсчёта перепоставляет строку на осадку без роста попыток (R3a)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero('olga', { name: 'Olga' })] }).expect(
      200,
    );
    await prisma.worldMentionsPending.update({
      where: { bookVersionId: versionId },
      data: { dirtyAt: new Date(Date.now() - 60_000), attempts: 3 },
    });
    const before = (await pending(versionId))!;
    const spy = jest
      .spyOn(worldMentions, 'recountVersion')
      .mockResolvedValue({ status: 'retry' } satisfies WorldRecountOutcome);
    try {
      await worldMentions.recountPending(0);
    } finally {
      spy.mockRestore();
    }
    const after = (await pending(versionId))!;
    expect(after.attempts).toBe(3);
    expect(after.generation).toBe(before.generation);
    // Осадка от часов базы «сейчас», а не пауза вперёд.
    expect(Math.abs(after.dirtyAt.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('F08-2: миграция ставит в очередь версии, у которых сущности мира уже есть (R5)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', entities: [hero('olga', { name: 'Olga' })] }).expect(
      200,
    );
    await prisma.worldMentionsPending.deleteMany({ where: { bookVersionId: versionId } });
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        'prisma',
        'migrations',
        '20261115120000_f08_world_mentions_pending',
        'migration.sql',
      ),
      'utf8',
    );
    const insert = sql.slice(sql.indexOf('INSERT INTO "WorldMentionsPending"'));
    expect(insert).toContain('ON CONFLICT');
    await prisma.$executeRawUnsafe(insert.slice(0, insert.indexOf(';') + 1));
    expect(await pending(versionId)).not.toBeNull();
    // Повторный накат ничего не ломает.
    await prisma.$executeRawUnsafe(insert.slice(0, insert.indexOf(';') + 1));
  });

  it('F08-2: исключение формы снимает ложное присутствие, autoTextAt не двигает (Q4)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [hero('letter', { name: 'Letter' })],
    }).expect(200);
    await drain(versionId);
    const before = await row(versionId, 'letter');
    expect(before.mentions).toMatchObject({ chapters: [2] });
    await putEntity(versionId, 'letter', {
      language: 'en',
      type: 'character',
      aliasExclusions: ['letter'],
    }).expect(200);
    await drain(versionId);
    const after = await row(versionId, 'letter');
    expect(after.mentions).toMatchObject({ chapters: [] });
    expect(after.aliasExclusions).toEqual(['letter']);
    expect(after.autoTextAt).toEqual(before.autoTextAt);
    expect(after.coreMissing).toContain('mentions');

    const editor = await request(http())
      .get(`/versions/${versionId}/world/letter`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(editor.body.entity.editor.aliasExclusions).toEqual(['letter']);
    expect(editor.body.entity.editor.stale).toEqual([]);
  });

  it('F08-8a: исключённые главы у формы — форма не считается в этих главах, поле видит только редактор', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [hero('letter', { name: 'Letter' })],
    }).expect(200);
    await drain(versionId);
    const before = await row(versionId, 'letter');
    expect(before.mentions).toMatchObject({ chapters: [2] });

    const saved = await putEntity(versionId, 'letter', {
      language: 'en',
      type: 'character',
      aliasChapterExclusions: [
        { form: 'LETTER', chapters: [2] },
        { form: 'letter', chapters: [9999] },
        { form: 'Nobody', chapters: [1] },
      ],
    }).expect(200);
    expect(saved.body.recountQueued).toBe(true);
    await drain(versionId);
    const after = await row(versionId, 'letter');
    expect(after.mentions).toMatchObject({ chapters: [], first: null });
    expect(after.aliasChapterExclusions).toEqual([
      { form: 'LETTER', chapters: [2, 9999] },
      { form: 'Nobody', chapters: [1] },
    ]);
    expect(after.autoTextAt).toEqual(before.autoTextAt);

    const editor = await request(http())
      .get(`/versions/${versionId}/world/letter`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(editor.body.entity.editor.aliasChapterExclusions).toEqual(after.aliasChapterExclusions);

    // Запись только о форме, которой нет, пересчёт не ставит (S7).
    const stray = await putEntity(versionId, 'letter', {
      language: 'en',
      type: 'character',
      aliasChapterExclusions: [
        { form: 'LETTER', chapters: [2, 9999] },
        { form: 'Nobody', chapters: [1, 3] },
      ],
    }).expect(200);
    expect(stray.body.recountQueued).toBe(false);

    // Снятие исключения возвращает главу.
    await putEntity(versionId, 'letter', {
      language: 'en',
      type: 'character',
      aliasChapterExclusions: null,
    }).expect(200);
    await drain(versionId);
    expect((await row(versionId, 'letter')).mentions).toMatchObject({ chapters: [2] });
  });

  it('F08-8a: импорт версии несёт исключённые главы: поле записано, пересчёт его учёл', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [
        hero('letter', {
          name: 'Letter',
          aliasChapterExclusions: [{ form: 'Letter', chapters: [2] }],
        }),
      ],
    }).expect(200);
    await drain(versionId);
    const after = await row(versionId, 'letter');
    expect(after.aliasChapterExclusions).toEqual([{ form: 'Letter', chapters: [2] }]);
    expect(after.mentions).toMatchObject({ chapters: [] });
  });

  it('F08-8a: повторы формы сливаются — предел глав считается после слияния, 400 с путём поля', async () => {
    const { versionId } = await createVersion();
    const half = BOOK_WORLD_LIMITS.chapterExclusionChapters;
    const res = await put(versionId, {
      language: 'en',
      entities: [
        hero('letter', {
          name: 'Letter',
          aliasChapterExclusions: [
            { form: 'Letter', chapters: Array.from({ length: half }, (_, i) => i + 1) },
            { form: 'LETTER', chapters: Array.from({ length: half }, (_, i) => half + i + 1) },
          ],
        }),
      ],
    }).expect(400);
    expect(JSON.stringify(res.body)).toContain('entities.0.aliasChapterExclusions');
  });

  it.each([
    ['дробная глава', [{ form: 'Letter', chapters: [1.5] }]],
    ['глава 0', [{ form: 'Letter', chapters: [0] }]],
    ['глава больше предела', [{ form: 'Letter', chapters: [BOOK_WORLD_LIMITS.chapter + 1] }]],
    ['пустой список глав', [{ form: 'Letter', chapters: [] }]],
    ['пустая форма', [{ form: '  ', chapters: [1] }]],
    ['лишний ключ', [{ form: 'Letter', chapters: [1], note: 'x' }]],
    [
      'записей больше предела',
      Array.from({ length: BOOK_WORLD_LIMITS.chapterExclusions + 1 }, (_, i) => ({
        form: `Form${i}`,
        chapters: [1],
      })),
    ],
    [
      'глав в записи больше предела',
      [
        {
          form: 'Letter',
          chapters: Array.from(
            { length: BOOK_WORLD_LIMITS.chapterExclusionChapters + 1 },
            (_, i) => i + 1,
          ),
        },
      ],
    ],
  ])('F08-8a: исключённые главы — 400 на мусор: %s', async (_label, aliasChapterExclusions) => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [hero('letter', { name: 'Letter', aliasChapterExclusions })],
    }).expect(400);
  });

  it('F08-2: правка главы ставит задачу; пересчёт обновляет mentions с прежним updatedAt, вкладка без 409', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    await prisma.worldMentionsPending.deleteMany({ where: { bookVersionId: versionId } });
    const seen = await row(versionId, 'oblomov');

    await request(http())
      .patch(`/chapters/${await chapterId(versionId, 2)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ content: `<p>The letter from the estate was still unread.</p>` })
      .expect(200);
    expect(await pending(versionId)).not.toBeNull();
    await drain(versionId);
    expect(await pending(versionId)).toBeNull();
    const after = await row(versionId, 'oblomov');
    expect(after.mentions).toMatchObject({ chapters: [1, 3], first: 1 });
    expect(after.updatedAt).toEqual(seen.updatedAt);
    expect(after.isListed).toBe(true);

    await putEntity(
      versionId,
      'oblomov',
      { language: 'en', type: 'character', short: 'After the recount.' },
      `?expectedUpdatedAt=${seen.updatedAt.toISOString()}`,
    ).expect(200);
  });

  it('F08-2: герой исчез из всех глав — ядро падает, страница уходит с сайта', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    await setMentions(versionId, 'oblomov', []);
    const after = await row(versionId, 'oblomov');
    expect(after.mentions).toMatchObject({ chapters: [], first: null });
    expect(after.hasCore).toBe(false);
    expect(after.coreMissing).toContain('mentions');
    expect(after.isListed).toBe(false);
    await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(404);
    await expectListedConsistent(versionId);
  });

  it('F08-2: удалённая глава — цитата и сцена в stale, ядро падает; редактор видит флаг (Q2)', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId);
    await request(http())
      .delete(`/chapters/${await chapterId(versionId, 3)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await drain(versionId);
    const after = await row(versionId, 'oblomov');
    // В колонке — ключи по содержанию (S1); редактору ниже — пути от текущих блоков.
    expect((after.mentions as { stale: string[] }).stale).toHaveLength(2);
    expect(after.hasCore).toBe(false);
    expect(after.isListed).toBe(false);
    // Данные не удаляются (Q2): цитата и сцена на месте, редактор видит пути.
    const editor = await request(http())
      .get(`/versions/${versionId}/world/oblomov`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(editor.body.entity.quotes).toHaveLength(3);
    expect(editor.body.entity.scenes).toHaveLength(2);
    expect(editor.body.entity.editor.stale).toEqual(['quotes.2', 'scenes.1']);
  });

  it('F08-2: цитата, которой нет дословно, не отдаётся читателю, но страница с ядром остаётся (Q2)', async () => {
    const { versionId } = await createVersion();
    await makeListed(
      versionId,
      'oblomov',
      hero('oblomov', {
        quotes: [
          ...(hero().quotes as Body[]),
          { text: 'Zakhar grumbled in the hall.', chapter: 1, interpretation: 'Servant.' },
        ],
      }),
    );
    await request(http())
      .patch(`/chapters/${await chapterId(versionId, 1)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ content: '<p>He lay on the sofa all morning.</p><p>Ilya Oblomov</p>' })
      .expect(200);
    await drain(versionId);
    expect((await row(versionId, 'oblomov')).isListed).toBe(true);

    const reader = await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200);
    expect(reader.body.entity.quotes.map((q: Body) => q.text)).not.toContain(
      'Zakhar grumbled in the hall.',
    );
    expect(reader.body.entity.quotes).toHaveLength(3);
    expect(reader.body.entity.editor).toBeUndefined();
    expect(reader.body.entity).not.toHaveProperty('aliasExclusions');
    expect(reader.body.entity).not.toHaveProperty('aliasChapterExclusions');
  });

  it('F08-2: удаление несошедшейся цитаты не прячет соседнюю — stale по содержанию, без пересчёта (S1)', async () => {
    const { versionId } = await createVersion();
    const quotes = hero().quotes as Body[];
    const zakhar = { text: 'Zakhar grumbled in the hall.', chapter: 1, interpretation: 'Servant.' };
    await makeListed(versionId, 'oblomov', hero('oblomov', { quotes: [zakhar, ...quotes] }));
    // Глава 1 без строки Захара: его цитата — несошедшаяся, ядро держат три остальные.
    await request(http())
      .patch(`/chapters/${await chapterId(versionId, 1)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ content: '<p>He lay on the sofa all morning.</p><p>Ilya Oblomov</p>' })
      .expect(200);
    await drain(versionId);
    expect((await row(versionId, 'oblomov')).isListed).toBe(true);
    const before = await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200);
    expect(before.body.entity.quotes.map((q: Body) => q.text)).toEqual(quotes.map((q) => q.text));

    // Редактор убирает несошедшуюся цитату: бывшая quotes.1 становится quotes.0 и видна сразу.
    await putEntity(versionId, 'oblomov', { language: 'en', type: 'character', quotes }).expect(
      200,
    );
    await readLatest(versionId, 'oblomov');
    const saved = await row(versionId, 'oblomov');
    expect(saved.hasCore).toBe(true);
    expect(saved.isListed).toBe(true);
    const reader = await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200);
    expect(reader.body.entity.quotes.map((q: Body) => q.text)).toEqual(quotes.map((q) => q.text));
  });

  it('F08-2: сцена и этап пути из удалённой главы не отдаются читателю; служебное присутствие наружу не идёт (Q2)', async () => {
    const { versionId } = await createVersion();
    await makeListed(
      versionId,
      'oblomov',
      hero('oblomov', {
        arc: {
          from: 'A dreamer on the sofa',
          to: 'A dreamer at rest',
          stages: [{ title: 'Dream', text: 'He dreams.', chapter: 3 }],
        },
        scenes: [
          { chapter: 1, title: 'Morning', text: 'He does not get up.' },
          { chapter: 2, title: 'The letter', text: 'He does not read it.' },
          { chapter: 3, title: 'The dream', text: 'He dreams of his childhood.' },
        ],
        quotes: [
          { text: 'He lay on the sofa all morning.', chapter: 1, interpretation: 'Idleness.' },
          { text: 'Zakhar grumbled in the hall.', chapter: 1, interpretation: 'Servant.' },
          {
            text: 'The letter from the estate was still unread.',
            chapter: 2,
            interpretation: 'Neglect.',
          },
        ],
      }),
    );
    await request(http())
      .delete(`/chapters/${await chapterId(versionId, 3)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await drain(versionId);
    const after = await row(versionId, 'oblomov');
    expect((after.mentions as { stale: string[] }).stale).toHaveLength(2);
    expect(after.isListed).toBe(true);
    const editorView = await request(http())
      .get(`/versions/${versionId}/world/oblomov`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(editorView.body.entity.editor.stale).toEqual(['arc.stages.0', 'scenes.2']);

    const reader = await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200);
    expect(reader.body.entity.scenes.map((x: Body) => x.chapter)).toEqual([1, 2]);
    expect(reader.body.entity.arc.stages).toEqual([]);
    expect(Object.keys(reader.body.entity.mentions).sort()).toEqual(
      ['chapters', 'coPresence', 'first', 'perChapter'].sort(),
    );
    expect(reader.body.entity.editor).toBeUndefined();
  });

  it('F08-2: recountQueued и editor.recountPending — по строке очереди, не по mentionsAt (S5)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [hero('olga', { name: 'Olga' })],
    }).expect(200);
    await drain(versionId);
    const page = () =>
      request(http())
        .get(`/versions/${versionId}/world/olga`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);
    expect((await page()).body.entity.editor.recountPending).toBe(false);

    // Правка, которая не меняет вход подсчёта (R4, S2): очереди нет, метки нет.
    const quiet = await putEntity(versionId, 'olga', {
      language: 'en',
      type: 'character',
      short: 'Not a presence input.',
    }).expect(200);
    expect(quiet.body.recountQueued).toBe(false);
    expect(quiet.body.entity.editor.recountPending).toBe(false);
    expect(await pending(versionId)).toBeNull();

    // Новая форма имени, которой в тексте нет: очередь стоит, после пересчёта mentions прежние,
    // mentionsAt не двигается (Q4), а recountPending снимается.
    const mentionsAt = (await row(versionId, 'olga')).mentionsAt;
    expect(mentionsAt).toBeInstanceOf(Date);
    const loud = await putEntity(versionId, 'olga', {
      language: 'en',
      type: 'character',
      aliases: ['Olga Sergeyevna'],
    }).expect(200);
    expect(loud.body.recountQueued).toBe(true);
    expect(loud.body.entity.editor.recountPending).toBe(true);
    expect((await page()).body.entity.editor.recountPending).toBe(true);
    await drain(versionId);
    expect((await row(versionId, 'olga')).mentionsAt).toEqual(mentionsAt);
    expect((await page()).body.entity.editor.recountPending).toBe(false);

    const dry = await putEntity(
      versionId,
      'olga',
      { language: 'en', type: 'character', aliases: ['Olga I.'] },
      '?dryRun=true',
    ).expect(200);
    expect(dry.body.recountQueued).toBe(false);
  });

  it('F08-2: удаление сущности ставит версию в очередь (coPresence соседей, Q3)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      entities: [hero('oblomov'), hero('zakhar', { name: 'Zakhar' })],
    }).expect(200);
    await prisma.worldMentionsPending.deleteMany({ where: { bookVersionId: versionId } });
    await remove(versionId, 'zakhar').expect(204);
    expect(await pending(versionId)).not.toBeNull();
  });

  it('F08-2: coPresence — героям, читателю только публичные соседи (Q3)', async () => {
    const { versionId } = await createVersion();
    await makeListed(versionId, 'oblomov');
    await put(versionId, {
      language: 'en',
      entities: [hero('olga', { name: 'Olga', role: 'secondary' })],
    }).expect(200);
    await setMentions(versionId, 'oblomov', [1, 2, 3]);
    expect((await row(versionId, 'oblomov')).mentions).toMatchObject({
      coPresence: { olga: [2] },
    });
    const reader = await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200);
    // Ольга — второстепенная в одной главе: не на сайте, её ключа читатель не видит.
    expect((await row(versionId, 'olga')).isListed).toBe(false);
    expect(reader.body.entity.mentions.coPresence).toEqual([]);

    // Ольга на сайте (главная, прочитана) — читатель видит её в coPresence Обломова.
    await putEntity(versionId, 'olga', { language: 'en', type: 'character', role: 'main' }).expect(
      200,
    );
    await drain(versionId);
    await readLatest(versionId, 'olga');
    expect((await row(versionId, 'olga')).isListed).toBe(true);
    const shown = await request(http()).get(`/versions/${versionId}/world/oblomov`).expect(200);
    expect(shown.body.entity.mentions.coPresence).toEqual([{ key: 'olga', chapters: [2] }]);
    const editor = await request(http())
      .get(`/versions/${versionId}/world/oblomov`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(editor.body.entity.mentions.coPresence).toEqual([{ key: 'olga', chapters: [2] }]);
  });

  it('F08-2: правка главы версии без мира в очередь не ставит', async () => {
    const { versionId } = await createVersion();
    await request(http())
      .patch(`/chapters/${await chapterId(versionId, 1)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ content: '<p>Changed.</p>' })
      .expect(200);
    expect(await pending(versionId)).toBeNull();
  });

  describe('F08-8c: пара героев (решения арбитра `F08 | F08-8c` Q1-Q4, Q6)', () => {
    // Рубильник пар (`F08 | F08-8c-1` R2) включён по умолчанию с `F08-8c-2`; выключенное положение —
    // отдельным тестом ниже, он возвращает включённое.
    afterAll(() => {
      WORLD_PAIRS.public = true;
    });
    /** Пара с полным ядром кроме общих глав (их пишет пересчёт); цитаты — дословно из `TEXT`. */
    const pair = (key: string, over: Body = {}): Body => ({
      key,
      type: 'pair',
      name: 'Oblomov and Olga',
      short: 'Two ways to live.',
      compare: [1, 2, 3, 1].map((chapter, i) => ({
        feature: `Feature ${i}`,
        a: `Oblomov ${i}`,
        chapterA: chapter,
        b: `Olga ${i}`,
        chapterB: 2,
      })),
      bonds: 'Love.',
      differences: 'Will.',
      quotes: [
        {
          text: 'Olga sang Casta diva.',
          chapter: 2,
          speakerKey: 'oblomov',
          aboutKey: 'olga',
          interpretation: 'Her voice.',
        },
      ],
      conclusion: 'Will against dream.',
      ...over,
    });
    const heroes = (versionId: string) =>
      put(versionId, {
        language: 'en',
        entities: [
          hero('oblomov'),
          hero('olga', { name: 'Olga' }),
          hero('zakhar', { name: 'Zakhar' }),
        ],
      }).expect(200);
    const related = (versionId: string) =>
      prisma.bookAnalysis.create({
        data: {
          bookVersionId: versionId,
          characters: [
            {
              key: 'olga',
              name: 'Olga',
              role: 'main',
              relations: [{ to: 'oblomov', label: 'loves' }],
            },
          ],
        },
      });
    const message = (res: { body: { message: unknown } }) => JSON.stringify(res.body.message);

    it('ключ: не по алфавиту, один герой, не герой версии, два «--» — 400 с путём key', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      for (const [key, text] of [
        ['olga--oblomov', 'alphabetical order'],
        ['olga--olga', 'two different characters'],
        ['oblomov--stolz', '\\"stolz\\" is not a character of this version'],
        ['oblomov---olga', 'two character keys joined by one'],
      ]) {
        const res = await put(versionId, { language: 'en', entities: [pair(key)] }).expect(400);
        expect(message(res)).toContain(`entities.0.key: `);
        expect(message(res)).toContain(text);
      }
      // Тот же ключ одной сущностью: путь без префикса тела.
      const one = await putEntity(versionId, 'olga--oblomov', {
        ...pair('olga--oblomov'),
        key: undefined,
        language: 'en',
      }).expect(400);
      expect(message(one)).toContain('key: pair keys go in alphabetical order');
      await putEntity(versionId, 'oblomov--olga', {
        ...pair('oblomov--olga'),
        key: undefined,
        language: 'en',
      }).expect(200);
    });

    it('заведение: без связи и без общих глав — 400; связь в анализе — 200; треть глав — 200', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      // Присутствие не посчитано, связи нет — 400.
      const uncounted = await put(versionId, {
        language: 'en',
        entities: [pair('oblomov--olga')],
      }).expect(400);
      expect(message(uncounted)).toContain('are not related in the analysis');
      // Посчитано, общих глав нет: Обломов в 1 и 3, Захар только в 1-й (TEXT), Ольга только во 2-й.
      await setMentions(versionId, 'oblomov', [1, 3]);
      await setMentions(versionId, 'olga', [2]);
      expect(
        message(
          await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(400),
        ),
      ).toContain('are not related in the analysis');
      // Вместе в главе 1 из двух глав Обломова и одной Захара: 3·1 ≥ 2 и ≥ 1 — заводится без связи.
      await put(versionId, {
        language: 'en',
        entities: [pair('oblomov--zakhar', { name: 'Oblomov and Zakhar', quotes: null })],
      }).expect(200);
      // Связь в анализе в любую сторону (Ольга → Обломов) — заводится без общих глав.
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
    });

    it('поля не своего типа — 400 с путём; цитата пары — только о героях пары, не о себе', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      const wrong = await put(versionId, {
        language: 'en',
        entities: [
          pair('oblomov--olga', {
            role: 'main',
            character: 'x',
            aliases: ['O and O'],
            sources: [{ title: 'S', url: 'https://example.com/s' }],
          }),
          hero('stolz', { name: 'Stolz', conclusion: 'x' }),
          // Ссылка героя — на героя, не на пару (ревью круга 1).
          hero('zakhar', { name: 'Zakhar', relations: [{ to: 'oblomov--olga', label: 'x' }] }),
        ],
      }).expect(400);
      for (const path of [
        'entities.0.role',
        'entities.0.character',
        'entities.0.aliases',
        'entities.0.sources',
        'entities.1.conclusion',
        'entities.2.relations.0.to',
      ]) {
        expect(message(wrong)).toContain(`${path}: `);
      }
      const quote = { text: 'Olga sang Casta diva.', chapter: 2, interpretation: 'Voice.' };
      const quotes = await put(versionId, {
        language: 'en',
        entities: [
          pair('oblomov--olga', {
            quotes: [
              { ...quote, speakerKey: 'zakhar', aboutKey: 'olga' },
              { ...quote, speakerKey: 'olga', aboutKey: 'olga' },
              { ...quote, speakerKey: 'olga' },
              { ...quote, aboutKey: 'olga' },
            ],
          }),
        ],
      }).expect(400);
      expect(message(quotes)).toContain(
        'entities.0.quotes.0.speakerKey: \\"zakhar\\" is not a character of this pair',
      );
      expect(message(quotes)).toContain(
        'entities.0.quotes.1.aboutKey: a quote of a pair is about the other character',
      );
      expect(message(quotes)).toContain(
        'entities.0.quotes.2.aboutKey: a quote of a pair names the character it is about',
      );
      // Рассказчик об одном из героев — не «друг о друге» (ревью круга 2).
      expect(message(quotes)).toContain(
        'entities.0.quotes.3.speakerKey: a quote of a pair is said by one of its characters',
      );
      const heroAbout = await put(versionId, {
        language: 'en',
        entities: [hero('oblomov', { quotes: [{ ...quote, aboutKey: 'olga' }] })],
      }).expect(400);
      expect(message(heroAbout)).toContain('entities.0.quotes.0.aboutKey: ');
      // Глава стороны сравнения — из версии (R4), путём своего поля.
      const chapter = await put(versionId, {
        language: 'en',
        entities: [
          pair('oblomov--olga', {
            compare: [{ feature: 'F', a: 'A', chapterA: 1, b: 'B', chapterB: 9 }],
          }),
        ],
      }).expect(400);
      expect(message(chapter)).toContain(
        'entities.0.compare.0.chapterB: chapter 9 is not in this version',
      );
    });

    it('общие главы пишет пересчёт, имя пары не ищется; пара на сайте только с обоими героями', async () => {
      const { versionId } = await createVersion();
      await makeListed(versionId, 'oblomov');
      await makeListed(versionId, 'olga', hero('olga', { name: 'Olga' }));
      await related(versionId);
      const saved = await put(versionId, {
        language: 'en',
        entities: [pair('oblomov--olga')],
      }).expect(200);
      expect(saved.body.entities[0].warnings.map((w: { path: string }) => w.path)).toEqual([
        'entities.0.mentions',
      ]);
      expect(saved.body.entities[0].warnings[0].message).toContain(
        'no chapter with both characters',
      );
      await drain(versionId);
      // Оба героя — в главах 1–3 (`makeListed`): общие главы — все три. Имя пары «Oblomov and Olga»
      // в тексте не стоит: найдись оно поиском — глав не было бы вовсе.
      const counted = await row(versionId, 'oblomov--olga');
      expect(counted.mentions).toMatchObject({ chapters: [1, 2, 3], first: 1, coPresence: {} });
      expect(counted.hasCore).toBe(true);
      expect(counted.isListed).toBe(false);
      await readLatest(versionId, 'oblomov--olga');
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(true);
      const page = await request(http())
        .get(`/versions/${versionId}/world/oblomov--olga`)
        .expect(200);
      // Читателю — без служебного (ревью круга 1): отметок редактора нет, строки сравнения — ровно поля DTO.
      expect(page.body.entity.editor).toBeUndefined();
      for (const c of page.body.entity.compare as Record<string, unknown>[]) {
        expect(Object.keys(c).sort()).toEqual(['a', 'b', 'chapterA', 'chapterB', 'feature']);
      }
      expect(page.body.entity).toMatchObject({
        type: 'pair',
        compare: expect.arrayContaining([expect.objectContaining({ chapterB: 2 })]),
        conclusion: 'Will against dream.',
        mentions: { chapters: [1, 2, 3] },
      });
      const list = await request(http()).get(`/versions/${versionId}/world`).expect(200);
      expect(
        list.body.entities.find((e: { key: string }) => e.key === 'oblomov--olga'),
      ).toMatchObject({
        type: 'pair',
        forms: [],
      });
      await expectListedConsistent(versionId);

      // Героиню скрыли — пара уходит с сайта той же транзакцией; вернули — пара возвращается.
      await flags(versionId, 'olga', { isVisible: false }).expect(200);
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(false);
      await request(http()).get(`/versions/${versionId}/world/oblomov--olga`).expect(404);
      await expectListedConsistent(versionId);
      await flags(versionId, 'olga', { isVisible: true }).expect(200);
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(true);

      // Героиня исчезла из текста: ядро и публичность падают у неё и у пары (пересчёт).
      await setMentions(versionId, 'olga', []);
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: versionId, number: 2 } },
        data: { content: '<p>The letter from the estate was still unread.</p><p>Ilya Oblomov</p>' },
      });
      await expect(worldMentions.recountVersion(versionId)).resolves.toMatchObject({
        status: 'done',
      });
      expect((await row(versionId, 'olga')).isListed).toBe(false);
      const gone = await row(versionId, 'oblomov--olga');
      expect(gone).toMatchObject({ isListed: false, hasCore: false });
      expect(gone.coreMissing).toEqual(['mentions']);
      await expectListedConsistent(versionId);
    });

    it('сравнение: 9 строк — 400; черновик из 2 строк сохраняется с предупреждением ядра', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      const row = { feature: 'F', a: 'A', chapterA: 1, b: 'B', chapterB: 2 };
      const nine = await put(versionId, {
        language: 'en',
        entities: [pair('oblomov--olga', { compare: Array.from({ length: 9 }, () => row) })],
      }).expect(400);
      expect(message(nine)).toContain('entities.0.compare');
      const draft = await put(versionId, {
        language: 'en',
        entities: [pair('oblomov--olga', { compare: [row, row] })],
      }).expect(200);
      expect(draft.body.entities[0].warnings.map((w: { path: string }) => w.path)).toEqual([
        'entities.0.compare',
        'entities.0.mentions',
      ]);
    });

    it('герои и пара одним телом: герои пишутся первыми, пара заводится связью анализа', async () => {
      const { versionId } = await createVersion();
      await related(versionId);
      const res = await put(versionId, {
        language: 'en',
        // Пара раньше героев в теле — порядок записи от тела не зависит.
        entities: [pair('oblomov--olga'), hero('oblomov'), hero('olga', { name: 'Olga' })],
      }).expect(200);
      expect(res.body.entities.map((e: { key: string; created: boolean }) => e.created)).toEqual([
        true,
        true,
        true,
      ]);
      expect((await row(versionId, 'oblomov--olga')).type).toBe('pair');
    });

    it('заведённая пара правится, даже если условие заведения больше не держится (R1); новая — 400', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      // Связь из анализа убрали: условие заведения у этой пары больше не выполняется.
      await prisma.bookAnalysis.update({
        where: { bookVersionId: versionId },
        data: { characters: [{ key: 'olga', name: 'Olga', role: 'main' }] },
      });
      await putEntity(versionId, 'oblomov--olga', {
        language: 'en',
        type: 'pair',
        conclusion: 'Fixed typo.',
      }).expect(200);
      expect((await row(versionId, 'oblomov--olga')).blocks).toMatchObject({
        conclusion: 'Fixed typo.',
      });
      // Та же пара заново — условие проверяется как у новой.
      await remove(versionId, 'oblomov--olga').expect(204);
      const again = await put(versionId, {
        language: 'en',
        entities: [pair('oblomov--olga')],
      }).expect(400);
      expect(message(again)).toContain('are not related in the analysis');
    });

    it('герой пары не меняет тип — 400 с путём type', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      const res = await putEntity(versionId, 'olga', { language: 'en', type: 'pair' }).expect(400);
      expect(message(res)).toContain('type: \\"olga\\" is a character of pairs oblomov--olga');
      expect((await row(versionId, 'olga')).type).toBe('character');
    });

    it('поля героя у пары без источников — ровно одна ошибка на поле (relations, critique, prototypes, adaptations)', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      const res = await put(versionId, {
        language: 'en',
        entities: [
          pair('oblomov--olga', {
            relations: [{ to: 'oblomov', label: 'x' }],
            critique: 'A critic.',
            prototypes: 'A prototype.',
            adaptations: [{ title: 'Film', year: 1980, actor: 'A', differences: 'Shorter.' }],
          }),
        ],
      }).expect(400);
      const errors = res.body.message as string[];
      for (const field of ['relations', 'critique', 'prototypes', 'adaptations']) {
        expect(errors.filter((e) => e.startsWith(`entities.0.${field}`))).toHaveLength(1);
      }
      expect(errors.filter((e) => e.startsWith('entities.0.relations.0.to'))).toHaveLength(0);
      expect(errors).toHaveLength(4);
    });

    it('«прочитано» героя возвращает пару на сайт в той же транзакции', async () => {
      const { versionId } = await createVersion();
      await makeListed(versionId, 'oblomov');
      // Ольга записана и посчитана, но её текст не прочитан: не на сайте.
      await put(versionId, { language: 'en', entities: [hero('olga', { name: 'Olga' })] }).expect(
        200,
      );
      await setMentions(versionId, 'olga', [1, 2, 3]);
      await put(versionId, {
        language: 'en',
        entities: [{ key: 'olga', type: 'character' }],
      }).expect(200);
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      await drain(versionId);
      await readLatest(versionId, 'oblomov--olga');
      expect((await row(versionId, 'olga')).isListed).toBe(false);
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(false);
      await readLatest(versionId, 'olga');
      expect((await row(versionId, 'olga')).isListed).toBe(true);
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(true);
      await expectListedConsistent(versionId);
    });

    it('запись одного героя снимает его с сайта (роль minor не проходит worldRolePasses): пара уходит тем же запросом', async () => {
      const { versionId } = await createVersion();
      await makeListed(versionId, 'oblomov');
      await makeListed(versionId, 'olga', hero('olga', { name: 'Olga' }));
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      await drain(versionId);
      await readLatest(versionId, 'oblomov--olga');
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(true);
      // Роль minor не проходит порог публичности героя (worldRolePasses): Ольга уходит с сайта, пара - с ней.
      await putEntity(versionId, 'olga', {
        language: 'en',
        type: 'character',
        role: 'minor',
      }).expect(200);
      expect((await row(versionId, 'olga')).isListed).toBe(false);
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(false);
      await expectListedConsistent(versionId);
    });

    it('рубильник выключен: пара с ядром и героями на сайте не публична', async () => {
      const { versionId } = await createVersion();
      await makeListed(versionId, 'oblomov');
      await makeListed(versionId, 'olga', hero('olga', { name: 'Olga' }));
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      await drain(versionId);
      WORLD_PAIRS.public = false;
      try {
        await readLatest(versionId, 'oblomov--olga');
        expect(await row(versionId, 'oblomov--olga')).toMatchObject({
          hasCore: true,
          isListed: false,
        });
        await request(http()).get(`/versions/${versionId}/world/oblomov--olga`).expect(404);
        const list = await request(http()).get(`/versions/${versionId}/world`).expect(200);
        expect(list.body.entities.map((e: { key: string }) => e.key)).toEqual(['oblomov', 'olga']);
        await expectListedConsistent(versionId);
      } finally {
        WORLD_PAIRS.public = true;
      }
    });

    it('пересчёт снимает героя с сайта — пара уходит в том же проходе, хотя её ключ раньше героя', async () => {
      const { versionId } = await createVersion();
      await makeListed(versionId, 'oblomov');
      // Второстепенная на сайте от WORLD_MIN_CHAPTERS (3) глав: Ольга в 1–3.
      await makeListed(versionId, 'olga', hero('olga', { name: 'Olga', role: 'secondary' }));
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      await drain(versionId);
      await readLatest(versionId, 'oblomov--olga');
      expect((await row(versionId, 'oblomov--olga')).isListed).toBe(true);
      // Ольга осталась только во 2-й главе (TEXT): ниже порога — уходит с сайта. Общая глава с
      // Обломовым есть, ядро пары держится — снимает её только публичность героини. Ключ
      // `oblomov--olga` по алфавиту раньше `olga`: без порядка «герои раньше пар» пара прочитала бы
      // прежний `isListed` героини.
      await setMentions(versionId, 'olga', [2]);
      expect((await row(versionId, 'olga')).isListed).toBe(false);
      expect(await row(versionId, 'oblomov--olga')).toMatchObject({
        hasCore: true,
        isListed: false,
      });
      await expectListedConsistent(versionId);
    });

    it('глава строки сравнения удалена — после пересчёта строка в stale, ядро пары падает', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      await setMentions(versionId, 'oblomov', [1, 2, 3]);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      await drain(versionId);
      expect((await row(versionId, 'oblomov--olga')).hasCore).toBe(true);
      // Строка 2 сравнения ссылается на главу 3 (`chapterA`).
      await prisma.chapter.delete({
        where: { bookVersionId_number: { bookVersionId: versionId, number: 3 } },
      });
      await expect(worldMentions.recountVersion(versionId)).resolves.toMatchObject({
        status: 'done',
      });
      const after = await row(versionId, 'oblomov--olga');
      expect(after.hasCore).toBe(false);
      expect(after.coreMissing).toEqual(['compare']);
      const editor = await request(http())
        .get(`/versions/${versionId}/world/oblomov--olga`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);
      expect(editor.body.entity.editor.stale).toEqual(['compare.2']);
    });

    it('героя из-под пары не удалить — 409 WORLD_ENTITY_REFERENCED, даже если ключ есть в анализе', async () => {
      const { versionId } = await createVersion();
      await heroes(versionId);
      await related(versionId);
      await put(versionId, { language: 'en', entities: [pair('oblomov--olga')] }).expect(200);
      const res = await remove(versionId, 'olga').expect(409);
      expect(res.body).toMatchObject({
        code: 'WORLD_ENTITY_REFERENCED',
        referencedBy: ['oblomov--olga'],
      });
      await remove(versionId, 'oblomov--olga').expect(204);
      await remove(versionId, 'olga').expect(204);
    });
  });

  it('версии нет — 404 на чтение и запись', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await request(http()).get(`/versions/${missing}/world`).expect(404);
    await put(missing, { language: 'en', entities: [hero()] }).expect(404);
    await flags(missing, 'oblomov', { isVisible: false }).expect(404);
  });
});
