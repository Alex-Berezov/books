/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- тело ответа supertest типизировано как any */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Language, RightsClaimStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F04-1: очень краткий пересказ и разделы пересказа (`books-app-docs/features/F04-summary-variants/
 * tech.md` §2-§4, §9; решения арбитра `F04 | F04-1` в `decisions-log.md`).
 */
describe('BookSummary sections e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userAccess: string;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const auth = () => `Bearer ${adminAccess}`;

  const createVersion = async (
    over: { language?: Language; status?: 'published' | 'draft'; slug?: string | null } = {},
  ) => {
    const bookSlug = `book-ss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const book = await createBookFixture(prisma, bookSlug);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: over.language ?? 'en',
        title: 'Version For Sections',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: over.status ?? 'published',
        slug: over.slug === undefined ? `${bookSlug}-v` : over.slug,
      },
    });
    return { bookId: book.id, bookSlug, versionId: version.id, versionSlug: version.slug };
  };

  const putSummary = (versionId: string, summary = '<p>Full summary</p>') =>
    request(http())
      .put(`/versions/${versionId}/summary`)
      .set('Authorization', auth())
      .send({ summary });

  const add = (versionId: string, body: Record<string, unknown>) =>
    request(http())
      .post(`/versions/${versionId}/summary-sections`)
      .set('Authorization', auth())
      .send(body);

  const section = (n: number, extra: Record<string, unknown> = {}) => ({
    title: `Part ${n}`,
    text: `<p>Text of part ${n}</p>`,
    readerChapter: null,
    ...extra,
  });

  /** Версия с полным пересказом и `count` разделами; ответ — список разделов. */
  const versionWithSections = async (
    count: number,
    over: Parameters<typeof createVersion>[0] = {},
  ) => {
    const v = await createVersion(over);
    await putSummary(v.versionId).expect(200);
    for (let n = 1; n <= count; n += 1) await add(v.versionId, section(n)).expect(200);
    const list = await request(http())
      .get(`/versions/${v.versionId}/summary-sections`)
      .set('Authorization', auth())
      .expect(200);
    return { ...v, sections: list.body.sections as Array<{ id: string; updatedAt: string }> };
  };

  const rows = (versionId: string) =>
    prisma.bookSummarySection.findMany({
      where: { bookVersionId: versionId },
      orderBy: { number: 'asc' },
    });

  const register = async (email: string) => {
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) return reg.body.accessToken as string;
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return login.body.accessToken as string;
  };

  const claimWithBlock = async (
    v: { bookId: string; versionId: string },
    status: RightsClaimStatus,
    countryCode: string | null = null,
    entireBook = false,
  ) => {
    const claim = await prisma.rightsClaim.create({
      data: {
        claimNumber: `RC-SS-${randomUUID()}`,
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
        ...(entireBook
          ? { bookId: v.bookId, scope: 'ENTIRE_BOOK' as const }
          : { bookVersionId: v.versionId, scope: 'TEXT_READER' as const }),
        countryCode,
        status: 'ACTIVE',
        reasonRu: 'Причина',
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    userAccess = await register(`user_ss_${Date.now()}@example.com`);
    adminAccess = await register('admin@example.com');
    await grantStaffRoles(app, 'admin@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('очень краткий пересказ', () => {
    const putBrief = (versionId: string, body: Record<string, unknown>) =>
      request(http())
        .put(`/versions/${versionId}/summary/brief`)
        .set('Authorization', auth())
        .send(body);

    it('без полного пересказа — 409', async () => {
      const v = await createVersion();
      await putBrief(v.versionId, { brief: '<p>Brief</p>' }).expect(409);
    });

    it('полный пересказ без видимого текста — 409; ответ — только поля пересказа', async () => {
      const v = await createVersion();
      await putSummary(v.versionId).expect(200);
      await prisma.bookSummary.update({
        where: { bookVersionId: v.versionId },
        data: { hasText: false },
      });
      await putBrief(v.versionId, { brief: '<p>Brief</p>' }).expect(409);
      await prisma.bookSummary.update({
        where: { bookVersionId: v.versionId },
        data: { hasText: true },
      });
      const res = await putBrief(v.versionId, { brief: '<p>Brief</p>' }).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'analysis',
          'bookVersionId',
          'brief',
          'briefHasText',
          'createdAt',
          'hasText',
          'id',
          'summary',
          'themes',
          'updatedAt',
        ].sort(),
      );
    });

    it('ключ обязателен: {} — 400; null и "" очищают; текст ставит briefHasText', async () => {
      const v = await createVersion();
      await putSummary(v.versionId).expect(200);
      await putBrief(v.versionId, {}).expect(400);

      const set = await putBrief(v.versionId, { brief: '<p>Very short</p>' }).expect(200);
      expect(set.body).toMatchObject({ brief: '<p>Very short</p>', briefHasText: true });
      const get = await request(http()).get(`/versions/${v.versionId}/summary`).expect(200);
      expect(get.body).toMatchObject({ brief: '<p>Very short</p>', briefHasText: true });

      const empty = await putBrief(v.versionId, { brief: '' }).expect(200);
      expect(empty.body).toMatchObject({ brief: null, briefHasText: false });

      await putBrief(v.versionId, { brief: '<p>Again</p>' }).expect(200);
      const cleared = await putBrief(v.versionId, { brief: null }).expect(200);
      expect(cleared.body).toMatchObject({ brief: null, briefHasText: false });
    });

    it('HTML без видимого текста — не отказ, а briefHasText = false', async () => {
      const v = await createVersion();
      await putSummary(v.versionId).expect(200);
      const res = await putBrief(v.versionId, { brief: '<p></p>' }).expect(200);
      expect(res.body.briefHasText).toBe(false);
    });

    it('PUT summary без brief не трогает ни brief, ни флаг', async () => {
      const v = await createVersion();
      await putSummary(v.versionId).expect(200);
      await putBrief(v.versionId, { brief: '<p>Keep me</p>' }).expect(200);
      const res = await putSummary(v.versionId, '<p>New full</p>').expect(200);
      expect(res.body).toMatchObject({ brief: '<p>Keep me</p>', briefHasText: true });
    });

    it('без роли — 401 и 403', async () => {
      const v = await createVersion();
      await request(http())
        .put(`/versions/${v.versionId}/summary/brief`)
        .send({ brief: null })
        .expect(401);
      await request(http())
        .put(`/versions/${v.versionId}/summary/brief`)
        .set('Authorization', `Bearer ${userAccess}`)
        .send({ brief: null })
        .expect(403);
    });
  });

  describe('запись разделов', () => {
    it('добавление в конец: номер «число разделов + 1», ответ со списком и warnings', async () => {
      const v = await createVersion();
      const first = await add(v.versionId, section(1)).expect(200);
      expect(first.body.section).toMatchObject({ number: 1, title: 'Part 1' });
      expect(first.body.warnings).toEqual([]);
      const second = await add(v.versionId, section(2)).expect(200);
      expect(second.body.section.number).toBe(2);
      expect(second.body.sections.map((s: { number: number }) => s.number)).toEqual([1, 2]);
    });

    it('проверки тела: пустые title/text, теги в title, лишнее поле, номер, readerChapter', async () => {
      const v = await createVersion();
      const messages = async (body: Record<string, unknown>) =>
        JSON.stringify((await add(v.versionId, body).expect(400)).body.message);
      expect(await messages(section(1, { title: '   ' }))).toMatch(/title/);
      expect(await messages(section(1, { text: '<p></p>' }))).toMatch(/text must contain text/);
      await add(v.versionId, section(1, { title: '<b>Part</b>' })).expect(400);
      await add(v.versionId, section(1, { title: 'x'.repeat(201) })).expect(400);
      await add(v.versionId, section(1, { number: 5 })).expect(400);
      await add(v.versionId, section(1, { readerChapter: 0 })).expect(400);
      await add(v.versionId, section(1, { readerChapter: 10_001 })).expect(400);
      const ok = await add(v.versionId, section(1, { title: '  Part one  ' })).expect(200);
      expect(ok.body.section.title).toBe('Part one');
    });

    it('несуществующая глава читалки — warnings, а не отказ; существующая — без них', async () => {
      const v = await createVersion();
      await prisma.chapter.create({
        data: { bookVersionId: v.versionId, number: 3, title: 'Ch 3', content: 'c' },
      });
      const missing = await add(v.versionId, section(1, { readerChapter: 7 })).expect(200);
      expect(missing.body.warnings).toEqual([
        expect.objectContaining({ code: 'chapter_not_found', path: 'readerChapter' }),
      ]);
      const present = await add(v.versionId, section(2, { readerChapter: 3 })).expect(200);
      expect(present.body.warnings).toEqual([]);
    });

    it('номера не подряд мимо сервиса — добавление 409, а не 500', async () => {
      const v = await createVersion();
      await prisma.bookSummarySection.createMany({
        data: [1, 3].map((number) => ({
          bookVersionId: v.versionId,
          number,
          title: `P${number}`,
          text: '<p>t</p>',
        })),
      });
      await add(v.versionId, section(3)).expect(409);
    });

    it('201-й раздел — 400', async () => {
      const v = await createVersion();
      await prisma.bookSummarySection.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          bookVersionId: v.versionId,
          number: i + 1,
          title: `P${i + 1}`,
          text: '<p>t</p>',
        })),
      });
      await add(v.versionId, section(201)).expect(400);
    });

    it('без роли — 401 и 403; версии нет — 404', async () => {
      const v = await createVersion();
      await request(http())
        .post(`/versions/${v.versionId}/summary-sections`)
        .send(section(1))
        .expect(401);
      await request(http())
        .post(`/versions/${v.versionId}/summary-sections`)
        .set('Authorization', `Bearer ${userAccess}`)
        .send(section(1))
        .expect(403);
      await add(randomUUID(), section(1)).expect(404);
    });

    it('правка, удаление, перестановка и чтение по id — без роли 403', async () => {
      const v = await versionWithSections(2);
      const ids = v.sections.map((s) => s.id);
      const user = `Bearer ${userAccess}`;
      await request(http())
        .put(`/summary-sections/${ids[0]}`)
        .set('Authorization', user)
        .send({ ...section(1), expectedUpdatedAt: v.sections[0].updatedAt })
        .expect(403);
      await request(http())
        .post(`/versions/${v.versionId}/summary-sections/delete`)
        .set('Authorization', user)
        .send({ sectionId: ids[0], from: ids })
        .expect(403);
      await request(http())
        .put(`/versions/${v.versionId}/summary-sections/order`)
        .set('Authorization', user)
        .send({ from: ids, to: [ids[1], ids[0]] })
        .expect(403);
      await request(http())
        .get(`/summary-sections/${ids[0]}`)
        .set('Authorization', user)
        .expect(403);
      expect((await rows(v.versionId)).map((r) => r.id)).toEqual(ids);
    });

    it('правка по id: пустой title и глава 0 — 400 с путём поля', async () => {
      const v = await versionWithSections(1);
      const edit = (body: Record<string, unknown>) =>
        request(http())
          .put(`/summary-sections/${v.sections[0].id}`)
          .set('Authorization', auth())
          .send({ ...section(1), expectedUpdatedAt: v.sections[0].updatedAt, ...body });
      expect(JSON.stringify((await edit({ title: '  ' }).expect(400)).body.message)).toMatch(
        /title/,
      );
      expect(JSON.stringify((await edit({ readerChapter: 0 }).expect(400)).body.message)).toMatch(
        /readerChapter/,
      );
      // Раздел пишется целиком: без ключа главы — 400, а не молча снятая связь; `null` снимает её.
      const { readerChapter: _omitted, ...withoutChapter } = section(1);
      void _omitted;
      await request(http())
        .put(`/summary-sections/${v.sections[0].id}`)
        .set('Authorization', auth())
        .send({ ...withoutChapter, expectedUpdatedAt: v.sections[0].updatedAt })
        .expect(400);
      await edit({ readerChapter: 4 }).expect(200);
      expect((await rows(v.versionId))[0].readerChapter).toBe(4);
    });

    it('удаление чужого раздела через другую версию — 404, раздел на месте', async () => {
      const a = await versionWithSections(1);
      const b = await versionWithSections(1);
      await request(http())
        .post(`/versions/${b.versionId}/summary-sections/delete`)
        .set('Authorization', auth())
        .send({ sectionId: a.sections[0].id, from: [a.sections[0].id] })
        .expect(404);
      expect(await rows(a.versionId)).toHaveLength(1);
    });

    it('удаление среднего: номера без дыр, updatedAt сдвинутых прежний, contentDate свежая', async () => {
      const v = await versionWithSections(4);
      const before = await rows(v.versionId);
      const res = await request(http())
        .post(`/versions/${v.versionId}/summary-sections/delete`)
        .set('Authorization', auth())
        .send({ sectionId: before[1].id, from: before.map((r) => r.id) })
        .expect(200);
      expect(res.body.sections.map((s: { id: string }) => s.id)).toEqual([
        before[0].id,
        before[2].id,
        before[3].id,
      ]);
      const after = await rows(v.versionId);
      expect(after.map((r) => r.number)).toEqual([1, 2, 3]);
      expect(after[0].movedAt).toBeNull();
      for (const moved of after.slice(1)) {
        const was = before.find((r) => r.id === moved.id)!;
        expect(moved.updatedAt.getTime()).toBe(was.updatedAt.getTime());
        expect(moved.movedAt!.getTime()).toBeGreaterThan(was.updatedAt.getTime());
      }
      const admin = await request(http())
        .get(`/summary-sections/${after[1].id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(new Date(admin.body.contentDate).getTime()).toBe(after[1].movedAt!.getTime());
    });

    it('удаление: нет раздела — 404, нет в from — 400, устаревший from — 409', async () => {
      const v = await versionWithSections(3);
      const ids = v.sections.map((s) => s.id);
      const del = (body: Record<string, unknown>) =>
        request(http())
          .post(`/versions/${v.versionId}/summary-sections/delete`)
          .set('Authorization', auth())
          .send(body);
      await del({ sectionId: randomUUID(), from: ids }).expect(404);
      await del({ sectionId: ids[0], from: [ids[1], ids[2]] }).expect(400);
      await del({ sectionId: ids[0], from: [ids[1], ids[0], ids[2]] }).expect(409);
      await del({ sectionId: ids[0], from: ids }).expect(200);
      // Второе удаление того же раздела устаревшей вкладкой — 404.
      await del({ sectionId: ids[0], from: ids }).expect(404);
    });

    it('перестановка 1↔3: movedAt у 1 и 3, не у 2; updatedAt не меняется', async () => {
      const v = await versionWithSections(3);
      const before = await rows(v.versionId);
      const ids = before.map((r) => r.id);
      const res = await request(http())
        .put(`/versions/${v.versionId}/summary-sections/order`)
        .set('Authorization', auth())
        .send({ from: ids, to: [ids[2], ids[1], ids[0]] })
        .expect(200);
      expect(res.body.sections.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[1], ids[0]]);
      const after = await rows(v.versionId);
      const byId = new Map(after.map((r) => [r.id, r]));
      expect(byId.get(ids[0])!.number).toBe(3);
      expect(byId.get(ids[2])!.number).toBe(1);
      expect(byId.get(ids[0])!.movedAt).not.toBeNull();
      expect(byId.get(ids[2])!.movedAt).not.toBeNull();
      expect(byId.get(ids[1])!.movedAt).toBeNull();
      for (const r of before)
        expect(byId.get(r.id)!.updatedAt.getTime()).toBe(r.updatedAt.getTime());
    });

    it('перестановка: чужой, недостающий или повторный id в to — 400; устаревший from — 409', async () => {
      const v = await versionWithSections(3);
      const ids = v.sections.map((s) => s.id);
      const order = (body: Record<string, unknown>) =>
        request(http())
          .put(`/versions/${v.versionId}/summary-sections/order`)
          .set('Authorization', auth())
          .send(body);
      await order({ from: ids, to: [ids[0], ids[1], randomUUID()] }).expect(400);
      await order({ from: ids, to: [ids[0], ids[1]] }).expect(400);
      await order({ from: ids, to: [ids[0], ids[0], ids[1]] }).expect(400);
      // Тот же набор, другой from: поверх чужой перестановки — 409.
      await order({ from: [ids[1], ids[0], ids[2]], to: ids }).expect(409);
    });

    it('правка по id: устаревший expectedUpdatedAt — 409, после чужой перестановки — 200', async () => {
      const v = await versionWithSections(3);
      const ids = v.sections.map((s) => s.id);
      const edit = (id: string, expectedUpdatedAt: string, title: string) =>
        request(http())
          .put(`/summary-sections/${id}`)
          .set('Authorization', auth())
          .send({ ...section(1, { title }), expectedUpdatedAt });

      // Чужая перестановка не трогает updatedAt — правка своего раздела проходит.
      await request(http())
        .put(`/versions/${v.versionId}/summary-sections/order`)
        .set('Authorization', auth())
        .send({ from: ids, to: [ids[2], ids[1], ids[0]] })
        .expect(200);
      const first = await edit(ids[0], v.sections[0].updatedAt, 'Edited').expect(200);
      expect(first.body.section).toMatchObject({ id: ids[0], number: 3, title: 'Edited' });

      // Два сохранения подряд — второе по updatedAt из ответа первого.
      await edit(ids[0], first.body.section.updatedAt, 'Edited again').expect(200);
      // Устаревшая вкладка второго редактора — 409.
      await edit(ids[0], v.sections[0].updatedAt, 'Stale').expect(409);
      await edit(randomUUID(), v.sections[0].updatedAt, 'Gone').expect(404);
    });

    it('правка по id после удаления соседа правит тот же раздел', async () => {
      const v = await versionWithSections(3);
      const ids = v.sections.map((s) => s.id);
      await request(http())
        .post(`/versions/${v.versionId}/summary-sections/delete`)
        .set('Authorization', auth())
        .send({ sectionId: ids[0], from: ids })
        .expect(200);
      await request(http())
        .put(`/summary-sections/${ids[2]}`)
        .set('Authorization', auth())
        .send({ ...section(9, { title: 'Third' }), expectedUpdatedAt: v.sections[2].updatedAt })
        .expect(200);
      const after = await rows(v.versionId);
      expect(after.map((r) => [r.id, r.number, r.title])).toEqual([
        [ids[1], 1, 'Part 2'],
        [ids[2], 2, 'Third'],
      ]);
    });

    it('гонки под замком: удаление ∥ добавление и удаление ∥ удаление соседа — номера подряд', async () => {
      const v = await versionWithSections(4);
      const ids = v.sections.map((s) => s.id);
      await Promise.all([
        request(http())
          .post(`/versions/${v.versionId}/summary-sections/delete`)
          .set('Authorization', auth())
          .send({ sectionId: ids[1], from: ids }),
        add(v.versionId, section(5)),
      ]);
      const mid = await rows(v.versionId);
      expect(mid.map((r) => r.number)).toEqual(mid.map((_, i) => i + 1));

      const w = await versionWithSections(4);
      const wIds = w.sections.map((s) => s.id);
      // Одна вкладка видит порядок до чужого удаления: проходит одно удаление, второе — 409.
      const results = await Promise.all(
        [wIds[1], wIds[2]].map((sectionId) =>
          request(http())
            .post(`/versions/${w.versionId}/summary-sections/delete`)
            .set('Authorization', auth())
            .send({ sectionId, from: wIds }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const after = await rows(w.versionId);
      expect(after.map((r) => r.number)).toEqual([1, 2, 3]);
    });
  });

  describe('чтение разделов', () => {
    it('черновик скрыт от анонима, модератор видит список и текст без полного пересказа', async () => {
      const draft = await createVersion({ status: 'draft' });
      await add(draft.versionId, section(1)).expect(200);
      await request(http()).get(`/versions/${draft.versionId}/summary-sections`).expect(404);
      await request(http()).get(`/versions/${draft.versionId}/summary-sections/1`).expect(404);
      const list = await request(http())
        .get(`/versions/${draft.versionId}/summary-sections`)
        .set('Authorization', auth())
        .expect(200);
      expect(list.body.sections).toHaveLength(1);
      expect(list.body.sections[0]).not.toHaveProperty('text');
      const one = await request(http())
        .get(`/summary-sections/${list.body.sections[0].id}`)
        .set('Authorization', auth())
        .expect(200);
      expect(one.body.text).toBe('<p>Text of part 1</p>');
    });

    it('аноним без текста полного пересказа — [] и 404; с текстом — список и раздел', async () => {
      const v = await createVersion();
      await add(v.versionId, section(1, { readerChapter: 2 })).expect(200);
      const empty = await request(http())
        .get(`/versions/${v.versionId}/summary-sections`)
        .expect(200);
      expect(empty.body.sections).toEqual([]);
      await request(http()).get(`/versions/${v.versionId}/summary-sections/1`).expect(404);

      await putSummary(v.versionId).expect(200);
      await add(v.versionId, section(2)).expect(200);
      const list = await request(http())
        .get(`/versions/${v.versionId}/summary-sections`)
        .expect(200);
      expect(list.body.sections.map((s: { number: number }) => s.number)).toEqual([1, 2]);
      const page = await request(http())
        .get(`/versions/${v.versionId}/summary-sections/1`)
        .expect(200);
      expect(page.body).toMatchObject({
        number: 1,
        title: 'Part 1',
        readerChapter: 2,
        readerChapterExists: false,
        briefHasText: false,
        sections: [
          { number: 1, title: 'Part 1' },
          { number: 2, title: 'Part 2' },
        ],
      });
      expect(page.headers['cache-control']).toMatch(/no-store/);
      expect(page.body).not.toHaveProperty('movedAt');
      expect(page.body).not.toHaveProperty('updatedAt');

      await prisma.chapter.create({
        data: { bookVersionId: v.versionId, number: 2, title: 'Ch 2', content: 'c' },
      });
      const withChapter = await request(http())
        .get(`/versions/${v.versionId}/summary-sections/1`)
        .expect(200);
      expect(withChapter.body.readerChapterExists).toBe(true);
    });

    it.each(['0', '01', 'abc', '1.5', '3'])('номер %s — 404', async (n) => {
      const v = await versionWithSections(2);
      await request(http()).get(`/versions/${v.versionId}/summary-sections/${n}`).expect(404);
    });

    it('окончённая претензия по стране: 451 там (и на несуществующий номер), 200 вне, полный пересказ открыт', async () => {
      const v = await versionWithSections(2);
      await claimWithBlock(v, 'RESOLVED_VALID', 'GB');
      await request(http())
        .get(`/versions/${v.versionId}/summary-sections/1`)
        .set('X-Geo-Country', 'GB')
        .expect(451);
      await request(http())
        .get(`/versions/${v.versionId}/summary-sections/99`)
        .set('X-Geo-Country', 'GB')
        .expect(451);
      await request(http())
        .get(`/versions/${v.versionId}/summary-sections/1`)
        .set('X-Geo-Country', 'US')
        .expect(200);
      await request(http()).get(`/versions/${v.versionId}/summary-sections/1`).expect(200);
      await request(http())
        .get(`/versions/${v.versionId}/summary`)
        .set('X-Geo-Country', 'GB')
        .expect(200);
      // Список для читателя — [] в любой стране (правило счётчика), модератору — всё.
      const list = await request(http())
        .get(`/versions/${v.versionId}/summary-sections`)
        .set('X-Geo-Country', 'US')
        .expect(200);
      expect(list.body.sections).toEqual([]);
      const editor = await request(http())
        .get(`/versions/${v.versionId}/summary-sections`)
        .set('Authorization', auth())
        .expect(200);
      expect(editor.body.sections).toHaveLength(2);
    });

    it('спор идёт — разделы открыты', async () => {
      const v = await versionWithSections(1);
      await claimWithBlock(v, 'UNDER_REVIEW', null);
      await request(http()).get(`/versions/${v.versionId}/summary-sections/1`).expect(200);
    });

    it('_count.summarySections в обзоре: число видимых, 0 без текста полного и при блоке', async () => {
      // Канонический адрес обзора — слаг версии (по слагу книги — 301 на него).
      const count = async (slug: string | null) => {
        const ov = await request(http()).get(`/en/books/${slug}/overview`).expect(200);
        return ov.body.versions[0]._count.summarySections as number;
      };
      const open = await versionWithSections(3);
      expect(await count(open.versionSlug)).toBe(3);

      const noText = await createVersion();
      await add(noText.versionId, section(1)).expect(200);
      expect(await count(noText.versionSlug)).toBe(0);

      const blocked = await versionWithSections(2);
      await claimWithBlock(blocked, 'CLOSED', 'DE');
      expect(await count(blocked.versionSlug)).toBe(0);

      const wholeBook = await versionWithSections(2);
      await claimWithBlock(wholeBook, 'RESOLVED_VALID', null, true);
      expect(await count(wholeBook.versionSlug)).toBe(0);
      const list = await request(http())
        .get(`/versions/${wholeBook.versionId}/summary-sections`)
        .expect(200);
      expect(list.body.sections).toEqual([]);
    });

    it('маршруты: GET summary-sections/<uuid> — модераторская ручка, не :lang', async () => {
      await request(http()).get(`/summary-sections/${randomUUID()}`).expect(401);
      await request(http())
        .get(`/summary-sections/${randomUUID()}`)
        .set('Authorization', auth())
        .expect(404);
    });
  });

  describe('карта сайта разделов', () => {
    type Item = { slug: string; sections: Array<{ number: number; lastmod: string }> };

    const readAll = async (lang: Language, limit: number) => {
      const items: Item[] = [];
      let total = -1;
      for (let page = 1; ; page += 1) {
        const res = await request(http())
          .get(`/${lang}/summary-sections/sitemap`)
          .query({ page, limit })
          .expect(200);
        total = res.body.pagination.total;
        items.push(...(res.body.items as Item[]));
        if (page >= res.body.pagination.totalPages) break;
      }
      return { items, total };
    };

    it('потолок limit — 50', async () => {
      await request(http()).get('/pt/summary-sections/sitemap').query({ limit: 51 }).expect(400);
      // Потолок номера страницы: огромный `page` — 400, а не 500 от Prisma; у края — пустая страница.
      await request(http()).get('/pt/summary-sections/sitemap').query({ page: 10_001 }).expect(400);
      await request(http())
        .get('/pt/summary-sections/sitemap')
        .query({ page: '1000000000000000' })
        .expect(400);
      const edge = await request(http())
        .get('/pt/summary-sections/sitemap')
        .query({ page: 10_000 })
        .expect(200);
      expect(edge.body.items).toEqual([]);
      const ok = await request(http())
        .get('/pt/summary-sections/sitemap')
        .query({ limit: 50 })
        .expect(200);
      // Карта страну и роль не читает — публичный кэш, как у списка книг.
      expect(ok.headers['cache-control']).toMatch(/public/);
      expect(ok.headers['cache-control']).toMatch(/s-maxage=\d+/);
    });

    it('только открытые версии со слагом и без noindex; total — по всем страницам; lastmod после сдвига', async () => {
      const lang: Language = 'pt';
      const open = await versionWithSections(2, { language: lang });
      const noSeo = await versionWithSections(1, { language: lang });
      const noSlug = await versionWithSections(1, { language: lang, slug: null });
      const draft = await versionWithSections(1, { language: lang, status: 'draft' });
      const claimed = await versionWithSections(1, { language: lang });
      await claimWithBlock(claimed, 'RESOLVED_VALID', 'GB');
      const claimedBook = await versionWithSections(1, { language: lang });
      await claimWithBlock(claimedBook, 'CLOSED', null, true);
      const noText = await createVersion({ language: lang });
      await add(noText.versionId, section(1)).expect(200);

      const robots: Array<[string, boolean]> = [
        ['noindex', false],
        ['none', false],
        ['NoIndex, follow', false],
        ['googlebot: noindex', false],
        ['max-image-preview: none', true],
        ['', true],
      ];
      const withRobots: Array<{ slug: string | null; expected: boolean }> = [];
      for (const [value, expected] of robots) {
        const v = await versionWithSections(1, { language: lang });
        const seo = await prisma.seo.create({ data: { robots: value } });
        await prisma.bookVersion.update({ where: { id: v.versionId }, data: { seoId: seo.id } });
        withRobots.push({ slug: v.versionSlug, expected });
      }

      const { items, total } = await readAll(lang, 2);
      expect(items).toHaveLength(total);
      const slugs = items.map((i) => i.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(slugs).toEqual(expect.arrayContaining([open.versionSlug, noSeo.versionSlug]));
      for (const absent of [noSlug, draft, claimed, claimedBook, noText]) {
        expect(slugs).not.toContain(absent.versionSlug);
      }
      for (const { slug, expected } of withRobots) {
        expect([slug, slugs.includes(slug!)]).toEqual([slug, expected]);
      }
      const openItem = items.find((i) => i.slug === open.versionSlug)!;
      expect(openItem.sections.map((s) => s.number)).toEqual([1, 2]);

      // После удаления первого раздела второй сдвинулся — lastmod свежий.
      const ids = open.sections.map((s) => s.id);
      const beforeLastmod = new Date(openItem.sections[1].lastmod).getTime();
      await request(http())
        .post(`/versions/${open.versionId}/summary-sections/delete`)
        .set('Authorization', auth())
        .send({ sectionId: ids[0], from: ids })
        .expect(200);
      const again = await readAll(lang, 50);
      const moved = again.items.find((i) => i.slug === open.versionSlug)!;
      expect(moved.sections).toHaveLength(1);
      expect(new Date(moved.sections[0].lastmod).getTime()).toBeGreaterThan(beforeLastmod);

      // Порядок страниц стабилен.
      const repeat = await readAll(lang, 2);
      expect(repeat.items.map((i) => i.slug)).toEqual(again.items.map((i) => i.slug));
    });
  });
});
