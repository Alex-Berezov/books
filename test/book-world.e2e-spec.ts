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
import { computeWorldListed } from '../src/modules/book-world/world-public';
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
    for (const r of rows) {
      expect({ key: r.key, isListed: r.isListed }).toEqual({
        key: r.key,
        isListed: computeWorldListed(r),
      });
    }
  };

  /** Присутствие пишет подсчёт `F08-2`; здесь — подготовка данных, затем запись пересчитывает ядро. */
  const setMentions = (versionId: string, key: string, chapters: number[]) =>
    prisma.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId: versionId, key } },
      data: { mentions: { chapters, first: chapters[0] ?? null } },
    });

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

  it('эталоны ru/en сохраняются: 200, ядра нет только из-за присутствия (F08-2)', async () => {
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
      for (const [i, e] of (res.body.entities as Body[]).entries()) {
        expect(e).toMatchObject({ created: true, hasCore: false });
        expect(e.warnings).toEqual([
          { code: 'core_incomplete', path: `entities.${i}.mentions`, message: MENTIONS_MISSING },
        ]);
      }
      await expectListedConsistent(version.id);
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
    expect(list.body).toEqual({ language: 'en', entities: [] });
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
        'faq',
        'sources',
        'mentions',
        'createdAt',
      ].sort(),
    );
    expect(res.body.entity.hasCore).toBe(true);
    expect(res.body.entity.mentions).toEqual({ chapters: [1, 2, 3], first: 1 });
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
    await prisma.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId: versionId, key: 'oblomov' } },
      data: { autoTextAt, mentions: { chapters: [1] } },
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
      ['key', 'type', 'name', 'role', 'short', 'hasCore', 'isIndexable', 'updatedAt'].sort(),
    );
    const editor = await request(http())
      .get(`/versions/${versionId}/world`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(Object.keys(editor.body.entities[0].editor).sort()).toEqual(
      ['isVisible', 'readAt', 'autoTextAt', 'firstPublishedAt', 'missing'].sort(),
    );
    expect(editor.body.entities[0].editor.missing).toEqual([]);
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

  it('версии нет — 404 на чтение и запись', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await request(http()).get(`/versions/${missing}/world`).expect(404);
    await put(missing, { language: 'en', entities: [hero()] }).expect(404);
    await flags(missing, 'oblomov', { isVisible: false }).expect(404);
  });
});
