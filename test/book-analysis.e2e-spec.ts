/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- тело ответа supertest типизировано как any */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Language, RightsClaimStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookAnalysisService } from '../src/modules/book-analysis/book-analysis.service';
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
