/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- тело ответа supertest типизировано как any */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Language, RightsClaimStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookAnalysisService } from '../src/modules/book-analysis/book-analysis.service';
import { BookService } from '../src/modules/book/book.service';
import { RedirectException } from '../src/common/exceptions/redirect.exception';
import type { UpdateBookAnalysisDto } from '../src/modules/book-analysis/dto/update-book-analysis.dto';
import { createBookFixture } from './helpers/book-fixture';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F03-1: ручки анализа книги (`books-app-docs/features/F03-book-analysis/tech.md` §3-§4,
 * `batches.md` F03-1 «Посадка»; решения арбитра А1-А11 в `decisions-log.md`, метка `F03 | F03-1`).
 */
describe('BookAnalysis e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let analyses: BookAnalysisService;
  let userAccess: string;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const createVersion = async (
    over: { language?: Language; status?: 'published' | 'draft'; slugPrefix?: string } = {},
  ) => {
    const slug = `${over.slugPrefix ?? 'book-an'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const book = await createBookFixture(prisma, slug);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: over.language ?? 'en',
        title: 'Version For Analysis',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: over.status ?? 'published',
      },
    });
    return { bookId: book.id, bookSlug: slug, versionId: version.id };
  };

  const core = (): Partial<UpdateBookAnalysisDto> => ({
    mainIdea: 'Guilt cannot be argued away.',
    themes: [
      { key: 'guilt', title: 'Guilt', interpretation: 'First.\n\nSecond.', chapters: [1] },
      { key: 'faith', title: 'Faith', interpretation: 'Text.' },
    ],
    characters: [
      {
        key: 'rodion',
        name: 'Rodion',
        role: 'main',
        description: 'A student.',
        themeKeys: ['guilt'],
        relations: [{ to: 'sonya', label: 'loves' }],
      },
      { key: 'sonya', name: 'Sonya', role: 'secondary', description: 'She believes.' },
    ],
    keyQuotes: [
      { text: 'Q1', interpretation: 'I1', speakerKey: 'rodion', themeKeys: ['guilt'] },
      { text: 'Q2', interpretation: 'I2' },
      { text: 'Q3', interpretation: 'I3' },
    ],
  });

  const put = (versionId: string, body: Record<string, unknown>, query = '') =>
    request(http())
      .put(`/versions/${versionId}/analysis${query}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(body);

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
    analyses = moduleRef.get(BookAnalysisService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    userAccess = await register(`user_an_${Date.now()}@example.com`);
    adminAccess = await register('admin@example.com');
    await grantStaffRoles(app, 'admin@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET без записи — null (пустое тело), а не объект', async () => {
    const { versionId } = await createVersion();
    const res = await request(http()).get(`/versions/${versionId}/analysis`).expect(200);
    expect(res.text).toBe('');
  });

  it('анализ без ядра: читателю null, редактору запись (product §2)', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', mainIdea: 'Only idea.' }).expect(200);
    const anon = await request(http()).get(`/versions/${versionId}/analysis`).expect(200);
    expect(anon.text).toBe('');
    const user = await request(http())
      .get(`/versions/${versionId}/analysis`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(200);
    expect(user.text).toBe('');
    const editor = await request(http())
      .get(`/versions/${versionId}/analysis`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(editor.body.mainIdea).toBe('Only idea.');
    expect(editor.body.hasCore).toBe(false);
  });

  it('PUT: без токена 401, без роли 403', async () => {
    const { versionId } = await createVersion();
    await request(http())
      .put(`/versions/${versionId}/analysis`)
      .send({ language: 'en' })
      .expect(401);
    await request(http())
      .put(`/versions/${versionId}/analysis`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ language: 'en' })
      .expect(403);
  });

  it('сохраняет ядро, отдаёт белый список полей и hasCore', async () => {
    const { versionId } = await createVersion();
    const res = await put(versionId, { language: 'en', ...core() }).expect(200);
    expect(res.body.hasCore).toBe(true);
    expect(res.body.analysis.hasCore).toBe(true);
    expect(res.body.warnings).toEqual(
      // глава 1 в версии нет — предупреждение, а не отказ (T4)
      [expect.objectContaining({ code: 'chapter_not_found', path: 'themes.0.chapters.0' })],
    );

    const get = await request(http()).get(`/versions/${versionId}/analysis`).expect(200);
    expect(get.body.language).toBe('en');
    expect(get.body.mainIdea).toBe('Guilt cannot be argued away.');
    expect(get.body.themes).toHaveLength(2);
    // Белый список (`tech.md` §4): ни id записи, ни id версии.
    expect(get.body).not.toHaveProperty('id');
    expect(get.body).not.toHaveProperty('bookVersionId');
    expect(Object.keys(get.body as object).sort()).toEqual(
      [
        'language',
        'hasCore',
        'chapterNumbers',
        'facts',
        'mainIdea',
        'themes',
        'characters',
        'symbols',
        'keyQuotes',
        'titleMeaning',
        'endingMeaning',
        'context',
        'timeline',
        'style',
        'reception',
        'adaptations',
        'misreadings',
        'discussionQuestions',
        'faq',
        'sources',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });

  it('главы версии: существующая — без предупреждения, несуществующая — предупреждение и 200', async () => {
    const { versionId } = await createVersion();
    await prisma.chapter.create({
      data: { bookVersionId: versionId, number: 1, title: 'One', content: 'Text' },
    });
    const body = {
      language: 'en',
      ...core(),
      symbols: [{ title: 'Axe', interpretation: 'Text.', chapters: [1, 99] }],
    };
    const res = await put(versionId, body).expect(200);
    expect(res.body.warnings).toEqual([
      expect.objectContaining({ code: 'chapter_not_found', path: 'symbols.0.chapters.1' }),
    ]);
    expect(res.body.analysis.symbols[0].chapters).toEqual([1, 99]);
  });

  it('«Вводные»: названия глав без текста — только редактору (А5)', async () => {
    const { versionId } = await createVersion({ status: 'draft' });
    await prisma.chapter.createMany({
      data: [
        { bookVersionId: versionId, number: 2, title: 'Two', content: 'Long text 2' },
        { bookVersionId: versionId, number: 1, title: 'One', content: 'Long text 1' },
      ],
    });
    const res = await request(http())
      .get(`/admin/versions/${versionId}/chapter-titles`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(res.body.items).toEqual([
      { number: 1, title: 'One' },
      { number: 2, title: 'Two' },
    ]);
    expect(res.body.pagination.total).toBe(2);
    await request(http())
      .get(`/admin/versions/${versionId}/chapter-titles`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(403);
  });

  it('язык JSON не совпал с языком версии — 400, запись не создана', async () => {
    const { versionId } = await createVersion({ language: 'en' });
    const res = await put(versionId, { language: 'ru', ...core() }).expect(400);
    expect(JSON.stringify(res.body.message)).toContain('language');
    expect(await prisma.bookAnalysis.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('форма: неизвестный ключ, роль, вид, глава 0, http-источник, лимит цитат темы — 400 с путём', async () => {
    const { versionId } = await createVersion();
    const cases: [Record<string, unknown>, string][] = [
      [{ unknownBlock: 1 }, 'unknownBlock'],
      [{ characters: [{ key: 'a', name: 'A', role: 'hero' }] }, 'characters.0.role'],
      [{ timeline: [{ year: '1866', event: 'E', kind: 'war' }] }, 'timeline.0.kind'],
      [{ keyQuotes: [{ text: 'Q', chapter: 0 }] }, 'keyQuotes.0.chapter'],
      [{ sources: [{ title: 'S', url: 'http://example.com' }] }, 'sources.0.url'],
      [{ themes: [{ key: 'Bad Key', title: 'T' }] }, 'themes.0.key'],
      [{ themes: [{ key: 't', title: '   ' }] }, 'themes.0.title'],
      [
        {
          themes: [{ key: 't', title: 'T', quotes: [1, 2, 3, 4].map((n) => ({ text: `q${n}` })) }],
        },
        'themes.0.quotes',
      ],
    ];
    for (const [body, path] of cases) {
      const res = await put(versionId, { language: 'en', ...body }).expect(400);
      expect(JSON.stringify(res.body.message)).toContain(path);
    }
  });

  it('неизвестный themeKeys — 400 с путём; ссылка на тему из прошлого импорта проходит', async () => {
    const { versionId } = await createVersion();
    const bad = await put(versionId, {
      language: 'en',
      themes: [{ key: 'guilt', title: 'Guilt' }],
      characters: [{ key: 'r', name: 'R', role: 'main', themeKeys: ['nope'] }],
    }).expect(400);
    expect(JSON.stringify(bad.body.message)).toContain('characters.0.themeKeys.0');

    await put(versionId, { language: 'en', themes: [{ key: 'guilt', title: 'Guilt' }] }).expect(
      200,
    );
    // Второй импорт без тем: ссылка проверяется на слитой записи.
    await put(versionId, {
      language: 'en',
      characters: [{ key: 'r', name: 'R', role: 'main', themeKeys: ['guilt'] }],
    }).expect(200);
  });

  it('очистка тем при живых ссылках — 400 по ссылающемуся полю, запись не тронута', async () => {
    const { versionId } = await createVersion();
    await put(versionId, { language: 'en', ...core() }).expect(200);
    for (const themes of [null, []]) {
      const res = await put(versionId, { language: 'en', themes }).expect(400);
      expect(JSON.stringify(res.body.message)).toContain('characters.0.themeKeys.0');
    }
    const row = await prisma.bookAnalysis.findUniqueOrThrow({
      where: { bookVersionId: versionId },
    });
    expect(row.themes).toHaveLength(2);
  });

  it('слияние: ключа нет — блок прежний, null очищает, список заменяется целиком; ядро пересчитывается', async () => {
    const { versionId } = await createVersion();
    await put(versionId, {
      language: 'en',
      ...core(),
      titleMeaning: 'Title.',
      symbols: [
        { title: 'Axe', interpretation: 'A.' },
        { title: 'Cross', interpretation: 'C.' },
      ],
    }).expect(200);

    const res = await put(versionId, {
      language: 'en',
      titleMeaning: null,
      symbols: [{ title: 'Yellow', interpretation: 'Y.' }],
      keyQuotes: [{ text: 'Q1', interpretation: 'I1' }],
    }).expect(200);
    const a = res.body.analysis;
    expect(a.mainIdea).toBe('Guilt cannot be argued away.');
    expect(a.themes).toHaveLength(2);
    expect(a.titleMeaning).toBeNull();
    expect(a.symbols).toEqual([{ title: 'Yellow', interpretation: 'Y.' }]);
    // 1 цитата из 3 — ядро снято в обе стороны.
    expect(a.hasCore).toBe(false);
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'core_incomplete', path: 'keyQuotes' }),
      ]),
    );

    const back = await put(versionId, { language: 'en', keyQuotes: core().keyQuotes }).expect(200);
    expect(back.body.analysis.hasCore).toBe(true);
  });

  it('dryRun: проверка и слияние без записи — hasCore и warnings, запись не изменилась (А3)', async () => {
    const { versionId } = await createVersion();
    const dry = await put(versionId, { language: 'en', ...core() }, '?dryRun=true').expect(200);
    expect(dry.body.analysis).toBeNull();
    expect(dry.body.hasCore).toBe(true);
    expect(await prisma.bookAnalysis.count({ where: { bookVersionId: versionId } })).toBe(0);

    await put(versionId, { language: 'en', mainIdea: 'Saved.' }).expect(200);
    const before = await prisma.bookAnalysis.findUniqueOrThrow({
      where: { bookVersionId: versionId },
    });
    const dry2 = await put(versionId, { language: 'en', mainIdea: 'Dry.' }, '?dryRun=true').expect(
      200,
    );
    expect(dry2.body.warnings.map((w: { path: string }) => w.path)).toEqual([
      'themes',
      'characters',
      'keyQuotes',
    ]);
    const after = await prisma.bookAnalysis.findUniqueOrThrow({
      where: { bookVersionId: versionId },
    });
    expect(after.mainIdea).toBe('Saved.');
    expect(after.updatedAt).toEqual(before.updatedAt);

    // Ошибка формы и ссылок на dryRun — тот же 400.
    await put(
      versionId,
      { language: 'en', characters: [{ key: 'r', name: 'R', role: 'main', themeKeys: ['x'] }] },
      '?dryRun=true',
    ).expect(400);
    await put(versionId, { language: 'en' }, '?dryRun=yes').expect(400);
  });

  it('черновик версии: аноним 404, редактор видит запись', async () => {
    const { versionId } = await createVersion({ status: 'draft' });
    await put(versionId, { language: 'en', ...core() }).expect(200);
    await request(http()).get(`/versions/${versionId}/analysis`).expect(404);
    await request(http())
      .get(`/versions/${versionId}/analysis`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(404);
    const res = await request(http())
      .get(`/versions/${versionId}/analysis`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(res.body.hasCore).toBe(true);
  });

  /**
   * Решение владельца 18.10.2026 по А1 (вариант «а»): анализ — сведения о книге, как пересказ
   * (ADR-012 п.7, «карточка»), гео-блок текста версии его не закрывает.
   */
  it('гео-блок текста версии анализ не закрывает: 200 в закрытой стране', async () => {
    const blocked = await createVersion();
    await put(blocked.versionId, { language: 'en', ...core() }).expect(200);
    await prisma.geoBlockRule.create({
      data: {
        bookId: blocked.bookId,
        bookVersionId: blocked.versionId,
        scope: 'TEXT_READER',
        countryCode: 'GB',
        accessPolicy: 'BLOCK',
        sourceFinalStatus: 'BLOCKED',
        isActive: true,
        generatedFrom: 'E2E_TEST',
      },
    });
    // Текст версии в закрытой стране закрыт — правило действует.
    await request(http())
      .get(`/versions/${blocked.versionId}/chapters`)
      .set('X-Geo-Country', 'GB')
      .expect(451);
    const res = await request(http())
      .get(`/versions/${blocked.versionId}/analysis`)
      .set('X-Geo-Country', 'GB')
      .expect(200);
    expect(res.body.hasCore).toBe(true);
    // Без страны (серверный рендер страницы, поисковик) — тоже 200.
    await request(http()).get(`/versions/${blocked.versionId}/analysis`).expect(200);
  });

  /** Претензия с блоком доступа к тексту версии; статус претензии — стадия спора. */
  const claimWithBlock = async (
    v: { bookId: string; versionId: string },
    status: RightsClaimStatus,
    block: {
      countryCode?: string | null;
      status?: 'ACTIVE' | 'LIFTED';
      entireBook?: boolean;
      /** Блок с областью на всю книгу, привязанный только к версии (`bookId` пуст). */
      entireBookOnVersion?: boolean;
    } = {},
  ) => {
    const claim = await prisma.rightsClaim.create({
      data: {
        claimNumber: `RC-AN-${randomUUID()}`,
        claimType: 'COPYRIGHT_INFRINGEMENT',
        claimantName: 'Claimant',
        descriptionRu: 'Тест',
        bookId: v.bookId,
        bookVersionId: v.versionId,
        status,
      },
    });
    await prisma.rightsClaimAccessBlock.create({
      data: {
        rightsClaimId: claim.id,
        ...(block.entireBook
          ? { bookId: v.bookId, scope: 'ENTIRE_BOOK' as const }
          : block.entireBookOnVersion
            ? { bookVersionId: v.versionId, scope: 'ENTIRE_BOOK' as const }
            : { bookVersionId: v.versionId, scope: 'TEXT_READER' as const }),
        countryCode: block.countryCode ?? null,
        status: block.status ?? 'ACTIVE',
        reasonRu: 'Внутренняя причина: заявитель Zx9Claimant',
      },
    });
    return claim;
  };

  const versionWithAnalysis = async () => {
    const v = await createVersion();
    await put(v.versionId, { language: 'en', ...core() }).expect(200);
    return v;
  };

  /**
   * Слово владельца 18.10.2026 (`work-queue.md` «ВЛАДЕЛЕЦ» п.6): пока спор с правообладателем
   * идёт, анализ открыт; спор окончен, а блок не снят (текст убран) — анализ закрыт там же, где
   * текст. Перевод на статусы — решение арбитра `2026-10-18-f03-claim-upheld`: резолюция
   * не читается.
   */
  it.each([
    'RECEIVED',
    'UNDER_REVIEW',
    'ACTION_REQUIRED',
    'AWAITING_CLAIMANT',
    'CONTENT_REMOVED',
    'CONTENT_RESTRICTED',
    'COUNTER_NOTICE_FILED',
    'ESCALATED_TO_LAWYER',
  ] as const)('спор идёт (%s): текст закрыт, анализ открыт', async (status) => {
    const v = await versionWithAnalysis();
    await claimWithBlock(v, status);
    await request(http()).get(`/versions/${v.versionId}/chapters`).expect(451);
    await request(http()).get(`/versions/${v.versionId}/analysis`).expect(200);
  });

  it.each(['RESOLVED_VALID', 'RESOLVED_INVALID', 'WITHDRAWN', 'CLOSED'] as const)(
    'спор окончен (%s), блок не снят: анализ 451 BLOCKED_BY_RIGHTS_CLAIM, редактору 200',
    async (status) => {
      const v = await versionWithAnalysis();
      // Без резолюции — так статус ставит `changeStatus`; резолюция на исход не влияет.
      await claimWithBlock(v, status);
      const res = await request(http()).get(`/versions/${v.versionId}/analysis`).expect(451);
      expect(res.body.code).toBe('BLOCKED_BY_RIGHTS_CLAIM');
      // Ни данные претензии, ни редакторский `reasonRu` блока наружу не уходят (ADR-012 п.8).
      expect(JSON.stringify(res.body)).not.toContain('Claimant');
      expect(JSON.stringify(res.body)).not.toContain('Zx9');
      await request(http())
        .get(`/versions/${v.versionId}/analysis`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);
    },
  );

  it('спор окончен, блок снят — анализ открыт; претензию переоткрыли — снова открыт', async () => {
    const lifted = await versionWithAnalysis();
    await claimWithBlock(lifted, 'RESOLVED_VALID', { status: 'LIFTED' });
    await request(http()).get(`/versions/${lifted.versionId}/analysis`).expect(200);

    const reopened = await versionWithAnalysis();
    const claim = await claimWithBlock(reopened, 'RESOLVED_VALID');
    await request(http()).get(`/versions/${reopened.versionId}/analysis`).expect(451);
    await prisma.rightsClaim.update({ where: { id: claim.id }, data: { status: 'UNDER_REVIEW' } });
    await request(http()).get(`/versions/${reopened.versionId}/analysis`).expect(200);
  });

  it('блок на всю книгу: в споре анализ открыт, по окончании закрыт', async () => {
    const open = await versionWithAnalysis();
    await claimWithBlock(open, 'UNDER_REVIEW', { entireBook: true });
    await request(http()).get(`/versions/${open.versionId}/chapters`).expect(451);
    await request(http()).get(`/versions/${open.versionId}/analysis`).expect(200);

    const settled = await versionWithAnalysis();
    await claimWithBlock(settled, 'CLOSED', { entireBook: true });
    await request(http()).get(`/versions/${settled.versionId}/analysis`).expect(451);
  });

  it('окончённая претензия по стране закрывает анализ только в этой стране', async () => {
    const v = await versionWithAnalysis();
    await claimWithBlock(v, 'RESOLVED_VALID', { countryCode: 'GB' });
    await request(http())
      .get(`/versions/${v.versionId}/analysis`)
      .set('X-Geo-Country', 'GB')
      .expect(451);
    await request(http())
      .get(`/versions/${v.versionId}/analysis`)
      .set('X-Geo-Country', 'US')
      .expect(200);
  });

  it('счётчик анализа в обзоре и в списке книг — только с ядром', async () => {
    const withCore = await createVersion({ slugPrefix: 'book-an-cnt' });
    await put(withCore.versionId, { language: 'en', ...core() }).expect(200);
    const noCore = await createVersion({ slugPrefix: 'book-an-cnt' });
    await put(noCore.versionId, { language: 'en', mainIdea: 'Only idea.' }).expect(200);

    const ov1 = await request(http()).get(`/en/books/${withCore.bookSlug}/overview`).expect(200);
    expect(ov1.body.versions[0]._count.analyses).toBe(1);
    const ov2 = await request(http()).get(`/en/books/${noCore.bookSlug}/overview`).expect(200);
    expect(ov2.body.versions[0]._count.analyses).toBe(0);

    const list = await request(http()).get('/en/books').query({ page: 1, limit: 100 }).expect(200);
    const items = (list.body.items ?? list.body.data) as {
      slug: string;
      versions: { _count: { analyses: number } }[];
    }[];
    const counts = (slug: string) =>
      items.find((b) => b.slug === slug)?.versions.map((v) => v._count.analyses);
    expect(counts(withCore.bookSlug)).toEqual([1]);
    expect(counts(noCore.bookSlug)).toEqual([0]);
  });

  /**
   * F03-2, решение арбитра `F03 | F03-2`: счётчик — источник карты сайта, hreflang и кнопки.
   * Закрытый окончённой претензией анализ (по любой стране) в нём не считается; пока спор идёт
   * или блок снят — считается.
   */
  it('счётчик анализа не считает закрытый блоком окончённой претензии', async () => {
    const overviewCount = async (bookSlug: string) => {
      const ov = await request(http()).get(`/en/books/${bookSlug}/overview`).expect(200);
      return ov.body.versions[0]._count.analyses as number;
    };
    const cases: Array<[string, RightsClaimStatus, Parameters<typeof claimWithBlock>[2], number]> =
      [
        ['окончена, на весь мир', 'RESOLVED_VALID', {}, 0],
        ['окончена, по стране', 'CLOSED', { countryCode: 'GB' }, 0],
        ['окончена, на всю книгу', 'WITHDRAWN', { entireBook: true }, 0],
        ['спор идёт', 'UNDER_REVIEW', {}, 1],
        ['окончена, блок снят', 'RESOLVED_VALID', { status: 'LIFTED' }, 1],
      ];
    for (const [name, status, block, expected] of cases) {
      const v = await createVersion({ slugPrefix: 'book-an-claim' });
      await put(v.versionId, { language: 'en', ...core() }).expect(200);
      await claimWithBlock(v, status, block);
      expect([name, await overviewCount(v.bookSlug)]).toEqual([name, expected]);
    }

    const expired = await createVersion({ slugPrefix: 'book-an-claim' });
    await put(expired.versionId, { language: 'en', ...core() }).expect(200);
    await claimWithBlock(expired, 'RESOLVED_VALID');
    await prisma.rightsClaimAccessBlock.updateMany({
      where: { bookVersionId: expired.versionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await overviewCount(expired.bookSlug)).toBe(1);

    // Список книг (источник карты сайта) — то же правило.
    const closed = await createVersion({ slugPrefix: 'book-an-claim' });
    await put(closed.versionId, { language: 'en', ...core() }).expect(200);
    await claimWithBlock(closed, 'CLOSED', { countryCode: 'DE' });
    const list = await request(http()).get('/en/books').query({ page: 1, limit: 100 }).expect(200);
    const items = (list.body.items ?? list.body.data) as {
      slug: string;
      versions: { _count: { analyses: number } }[];
    }[];
    expect(items.find((b) => b.slug === closed.bookSlug)?.versions[0]._count.analyses).toBe(0);
  });

  it('chapterNumbers: номера глав версии по возрастанию; без глав — пустой список', async () => {
    const v = await versionWithAnalysis();
    for (const number of [3, 1]) {
      await prisma.chapter.create({
        data: { bookVersionId: v.versionId, number, title: `C${number}`, content: 'Text' },
      });
    }
    const res = await request(http()).get(`/versions/${v.versionId}/analysis`).expect(200);
    expect(res.body.chapterNumbers).toEqual([1, 3]);

    const empty = await versionWithAnalysis();
    const res2 = await request(http()).get(`/versions/${empty.versionId}/analysis`).expect(200);
    expect(res2.body.chapterNumbers).toEqual([]);
  });

  it('GET analyses/claim-closures: только блоки окончённых претензий, без правовых полей', async () => {
    const byCountry = await versionWithAnalysis();
    await claimWithBlock(byCountry, 'RESOLVED_VALID', { countryCode: 'gb' });
    const wholeBook = await versionWithAnalysis();
    await claimWithBlock(wholeBook, 'CLOSED', { entireBook: true });
    const inDispute = await versionWithAnalysis();
    await claimWithBlock(inDispute, 'UNDER_REVIEW');

    const res = await request(http()).get('/analyses/claim-closures').expect(200);
    const items = res.body.items as Array<{
      slugs: string[];
      language: string | null;
      countryCode: string | null;
      expiresAt: string | null;
    }>;
    expect(items.filter((i) => i.slugs.includes(byCountry.bookSlug))).toEqual([
      { slugs: [byCountry.bookSlug], language: 'en', countryCode: 'GB', expiresAt: null },
    ]);
    expect(items.filter((i) => i.slugs.includes(wholeBook.bookSlug))).toEqual([
      { slugs: [wholeBook.bookSlug], language: 'en', countryCode: null, expiresAt: null },
    ]);
    expect(items.some((i) => i.slugs.includes(inDispute.bookSlug))).toBe(false);
    // Ответ кэширует только middleware (до 300 с): на CDN снятый блок держался бы дольше.
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).not.toContain('Zx9');
    expect(res.text).not.toContain('Claimant');
  });

  /**
   * F04-3 (решение арбитра `F04 | F04-3`): список закрытий - это закрытия **текста**, им же
   * middleware фронта закрывает страницы разделов пересказа. Версия без анализа в нём есть: иначе
   * раздел пересказа книги без анализа остался бы открыт в стране блока.
   */
  it('GET analyses/claim-closures: версия без анализа в списке есть', async () => {
    const noAnalysis = await createVersion();
    await claimWithBlock(noAnalysis, 'RESOLVED_VALID', { countryCode: 'fr' });

    const res = await request(http()).get('/analyses/claim-closures').expect(200);
    const items = res.body.items as Array<{ slugs: string[] }>;
    expect(items.filter((i) => i.slugs.includes(noAnalysis.bookSlug))).toEqual([
      { slugs: [noAnalysis.bookSlug], language: 'en', countryCode: 'FR', expiresAt: null },
    ]);
  });

  /**
   * F03-2f: список закрытий отдаёт адрес книге, которой его отдаёт `getOverview` (версия в языке
   * адреса, затем версия в любом языке, затем `Book.slug`). Сверка - по самой ручке обзора: каждый
   * слаг элемента ведёт на книгу блока, а чужой адрес в элемент не попадает.
   */
  describe('GET analyses/claim-closures: адрес - той книге, которой его отдаёт обзор', () => {
    const addVersion = (bookId: string, language: Language, slug: string | null = null) =>
      prisma.bookVersion.create({
        data: {
          bookId,
          language,
          slug,
          title: 'Version',
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'published',
        },
      });
    const setSlug = (versionId: string, slug: string) =>
      prisma.bookVersion.update({ where: { id: versionId }, data: { slug } });

    /**
     * Книга, которую обзор отдаёт по адресу; 301 - по его цели. Зов сервиса, а не HTTP: приложение
     * этой спеки собрано без глобальных фильтров, и 301 уходит без `Location`.
     */
    const bookOf = async (lang: Language, slug: string): Promise<string | null> => {
      const books = app.get(BookService);
      let target: [Language, string] = [lang, slug];
      // Цель 301 сама может ответить 301 - идём по цепочке, но не дольше трёх шагов.
      for (let step = 0; step < 3; step += 1) {
        try {
          return (await books.getOverview(target[1], target[0])).id;
        } catch (error) {
          if (error instanceof NotFoundException) return null;
          if (!(error instanceof RedirectException)) throw error;
          const match = /^\/api\/([a-z]+)\/books\/([^/]+)\/overview$/.exec(error.url);
          if (!match) throw new Error(`Unexpected overview redirect: ${error.url}`);
          target = [match[1] as Language, match[2]];
        }
      }
      throw new Error(`Overview redirect chain too long for /${lang}/books/${slug}`);
    };

    const closuresOf = async (bookSlugs: string[]) => {
      const res = await request(http()).get('/analyses/claim-closures').expect(200);
      return (res.body.items as Array<{ slugs: string[]; language: Language }>).filter((i) =>
        i.slugs.some((slug) => bookSlugs.includes(slug)),
      );
    };

    const expectAllLeadTo = async (
      items: Array<{ slugs: string[]; language: Language }>,
      bookId: string,
    ) => {
      for (const item of items) {
        for (const slug of item.slugs) {
          expect([item.language, slug, await bookOf(item.language, slug)]).toEqual([
            item.language,
            slug,
            bookId,
          ]);
        }
      }
    };

    it('Book.slug книги A, которым в русском владеет версия книги B, не закрывается ни в каком языке', async () => {
      const a = await versionWithAnalysis();
      await addVersion(a.bookId, 'ru');
      const b = await createVersion({ language: 'ru' });
      await setSlug(b.versionId, a.bookSlug);
      await claimWithBlock(a, 'CLOSED', { entireBook: true });

      // en и ru адреса `a.bookSlug` обзор отдаёт книге B (в en - запасным поиском по любому языку).
      expect(await bookOf('ru', a.bookSlug)).toBe(b.bookId);
      expect(await bookOf('en', a.bookSlug)).toBe(b.bookId);
      expect(await closuresOf([a.bookSlug])).toEqual([]);
    });

    it('версия без слага закрыта и по слагу другой версии своей книги', async () => {
      const a = await versionWithAnalysis();
      const enSlug = `${a.bookSlug}-en`;
      await setSlug(a.versionId, enSlug);
      await addVersion(a.bookId, 'ru');
      await claimWithBlock(a, 'CLOSED', { entireBook: true });

      const items = await closuresOf([a.bookSlug, enSlug]);
      expect(items.map((i) => [i.language, [...i.slugs].sort()])).toEqual(
        expect.arrayContaining([
          ['en', [a.bookSlug, enSlug].sort()],
          ['ru', [a.bookSlug, enSlug].sort()],
        ]),
      );
      expect(items).toHaveLength(2);
      await expectAllLeadTo(items, a.bookId);
    });

    it('слаг версии книги A, которым в языке адреса владеет версия книги B, закрывается только в своём языке', async () => {
      const a = await versionWithAnalysis();
      const shared = `${a.bookSlug}-shared`;
      await setSlug(a.versionId, shared);
      await addVersion(a.bookId, 'ru');
      const b = await createVersion({ language: 'ru' });
      await setSlug(b.versionId, shared);
      await claimWithBlock(a, 'CLOSED', { entireBook: true });

      const items = await closuresOf([a.bookSlug, shared]);
      expect(items.find((i) => i.language === 'en')?.slugs.sort()).toEqual(
        [a.bookSlug, shared].sort(),
      );
      expect(items.find((i) => i.language === 'ru')?.slugs).toEqual([a.bookSlug]);
      expect(await bookOf('ru', shared)).toBe(b.bookId);
      await expectAllLeadTo(items, a.bookId);
    });
  });

  it('GET analyses/claim-closures: срок отдаётся датой, истёкший блок и книга без опубликованных версий не попадают', async () => {
    const dated = await versionWithAnalysis();
    await claimWithBlock(dated, 'CLOSED', { countryCode: 'FR' });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.rightsClaimAccessBlock.updateMany({
      where: { bookVersionId: dated.versionId },
      data: { expiresAt },
    });
    const expired = await versionWithAnalysis();
    await claimWithBlock(expired, 'CLOSED');
    await prisma.rightsClaimAccessBlock.updateMany({
      where: { bookVersionId: expired.versionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const draftOnly = await createVersion({ status: 'draft' });
    await claimWithBlock(draftOnly, 'CLOSED', { entireBook: true });

    const res = await request(http()).get('/analyses/claim-closures').expect(200);
    const items = res.body.items as Array<{ slugs: string[]; expiresAt: string | null }>;
    expect(items.find((i) => i.slugs.includes(dated.bookSlug))?.expiresAt).toBe(
      expiresAt.toISOString(),
    );
    expect(items.some((i) => i.slugs.includes(expired.bookSlug))).toBe(false);
    expect(items.some((i) => i.slugs.includes(draftOnly.bookSlug))).toBe(false);
  });

  /**
   * Решение арбитра `F03 | F03-2` (В5, а): привязка блока к цели одна на три места - ручка (451),
   * счётчик `_count.analyses` и список закрытий для middleware. Разойдутся - карта сайта или
   * middleware откроют анализ, который ручка закрывает.
   */
  it.each([
    ['блок на книгу по bookId', { entireBook: true }, 'en'],
    ['блок версии по bookVersionId', {}, 'en'],
    ['блок с областью на книгу, привязанный только к версии', { entireBookOnVersion: true }, 'en'],
  ] as const)('%s: ручка, счётчик и список закрытий согласны', async (_name, block, language) => {
    const v = await versionWithAnalysis();
    await claimWithBlock(v, 'CLOSED', block);

    await request(http()).get(`/versions/${v.versionId}/analysis`).expect(451);
    const ov = await request(http()).get(`/en/books/${v.bookSlug}/overview`).expect(200);
    expect(ov.body.versions[0]._count.analyses).toBe(0);
    const list = await request(http()).get('/analyses/claim-closures').expect(200);
    const items = (list.body.items as Array<{ slugs: string[]; language: string | null }>).filter(
      (i) => i.slugs.includes(v.bookSlug),
    );
    expect(items).toEqual([expect.objectContaining({ language })]);
  });

  it('параллельные сохранения одной версии — одна строка и без 500', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { versionId } = await createVersion();
      const results = await Promise.allSettled([
        analyses.saveForVersion(
          versionId,
          { language: 'en', mainIdea: 'A' } as UpdateBookAnalysisDto,
          false,
        ),
        analyses.saveForVersion(
          versionId,
          { language: 'en', titleMeaning: 'B' } as UpdateBookAnalysisDto,
          false,
        ),
      ]);
      for (const r of results) expect(r.status).toBe('fulfilled');
      const rows = await prisma.bookAnalysis.findMany({ where: { bookVersionId: versionId } });
      expect(rows).toHaveLength(1);
      // Замок: второй писатель видит блок первого и не затирает его.
      expect(rows[0].mainIdea).toBe('A');
      expect(rows[0].titleMeaning).toBe('B');
    }
  }, 60_000);

  it('эталон на пяти языках сохраняется без ошибок и с ядром', async () => {
    const book = await createBookFixture(prisma, `book-an-ref-${Date.now()}`);
    for (const language of Object.values(Language)) {
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
      const body = JSON.parse(
        readFileSync(join(__dirname, 'fixtures', `example-analysis.${language}.json`), 'utf8'),
      ) as Record<string, unknown>;
      const res = await put(version.id, body);
      expect({ language, status: res.status }).toEqual({ language, status: 200 });
      expect(res.body.hasCore).toBe(true);
      expect(
        res.body.warnings.filter((w: { code: string }) => w.code === 'core_incomplete'),
      ).toEqual([]);
    }
  });
});
