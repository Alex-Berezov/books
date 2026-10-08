import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookType, Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';
import { SLUG_MAX_LENGTH, SLUG_MAX_LENGTH_MESSAGE } from '../src/shared/validators/slug';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * У каждой языковой версии свой слаг, и запись его проверяет так же, как подсказка админки
 * (`findVersionSlugConflict`): слаг, который держит `Book.slug` другой книги или версия другой
 * книги в любом языке, молча увёл бы живой адрес той книги на эту - 400. Свои слаги (`Book.slug`
 * своей книги) и прежний, уже записанный слаг сохранению не мешают.
 */
describe('BookVersion slug conflicts on write (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  const stamp = Date.now();
  const ownSlug = `vsc-own-${stamp}`;
  const otherSlug = `vsc-other-${stamp}`;
  const otherVersionSlug = `vsc-other-es-${stamp}`;
  let ownBookId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const versionBody = (language: Language, slug: string) => ({
    language,
    slug,
    title: 'Title',
    author: 'Author',
    description: 'Desc',
    coverImageUrl: 'https://example.com/cover.jpg',
    type: BookType.text,
    isFree: true,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin-vsc@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = (login.body as { accessToken: string }).accessToken;
    }
    await grantStaffRoles(app, email);

    ownBookId = (
      await createBookWithRights(prisma, ownSlug, { languages: [Language.en, Language.ru] })
    ).book.id;
    const other = await createBookWithRights(prisma, otherSlug, { languages: [Language.es] });
    await request(http())
      .post(`/books/${other.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(versionBody(Language.es, otherVersionSlug))
      .expect(201);
  });

  afterAll(async () => {
    await cleanupBookWithRights(prisma, ownSlug);
    await cleanupBookWithRights(prisma, otherSlug);
    await app.close();
  });

  const create = (language: Language, slug: string) =>
    request(http())
      .post(`/books/${ownBookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(versionBody(language, slug));

  it('create: Book.slug of another book is refused', async () => {
    const res = await create(Language.ru, otherSlug).expect(400);

    expect(JSON.stringify(res.body)).toContain('another book');
  });

  it('create: a version slug of another book in another language is refused', async () => {
    const res = await create(Language.ru, otherVersionSlug).expect(400);

    expect(JSON.stringify(res.body)).toContain('another book');
  });

  it('create: the own Book.slug is free; update: other books are refused, the kept slug is not', async () => {
    const created = await create(Language.en, ownSlug).expect(201);
    const versionId = (created.body as { id: string }).id;

    const patch = (slug: string) =>
      request(http())
        .patch(`/versions/${versionId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug });

    const toOtherBook = await patch(otherSlug).expect(400);
    expect(JSON.stringify(toOtherBook.body)).toContain('another book');
    await patch(otherVersionSlug).expect(400);

    // Прежний слаг не меняется - проверка не зовётся, сохранение проходит.
    await patch(ownSlug).expect(200);

    const stored = await prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { slug: true },
    });
    expect(stored?.slug).toBe(ownSlug);
  });

  it('own book in another language is free; a version of another book in the same language keeps the old text', async () => {
    const ru = await create(Language.ru, `${ownSlug}-ru`).expect(201);
    const ruId = (ru.body as { id: string }).id;
    const patchRu = (slug: string) =>
      request(http())
        .patch(`/versions/${ruId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug });

    // Свой слаг у русской версии не трогает ни английскую версию, ни `Book.slug` — ради этого
    // и была правка: слаг одного языка расходился на все.
    await patchRu(`${ownSlug}-ru-own`).expect(200);
    const afterOwn = await prisma.bookVersion.findMany({
      where: { bookId: ownBookId },
      select: { language: true, slug: true },
      orderBy: { language: 'asc' },
    });
    expect(afterOwn).toEqual([
      { language: Language.en, slug: ownSlug },
      { language: Language.ru, slug: `${ownSlug}-ru-own` },
    ]);
    const book = await prisma.book.findUnique({ where: { id: ownBookId }, select: { slug: true } });
    expect(book?.slug).toBe(ownSlug);

    // Слаг версии en той же книги и её `Book.slug` ведут в ту же книгу.
    await patchRu(ownSlug).expect(200);

    const otherRu = await createBookWithRights(prisma, `${otherSlug}-ru`, {
      languages: [Language.ru],
    });
    const takenInRu = await request(http())
      .post(`/books/${otherRu.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(versionBody(Language.ru, ownSlug))
      .expect(400);
    await cleanupBookWithRights(prisma, `${otherSlug}-ru`);
    expect(JSON.stringify(takenInRu.body)).toContain('another version in this language');
  });

  /**
   * `LEGACY-437`: правило держится с обеих сторон и на старых адресах. Старый адрес другой книги
   * в любом языке занят (версия отвечает на адрес во всех языках, а фронт спрашивает редирект только
   * после 404); `Book.slug` не берёт слаг версии или старого адреса другой книги; подсказка без
   * `lang` говорит то же, что запись; слаг версии не по формату — 400.
   */
  describe('LEGACY-437: both directions, old addresses, format', () => {
    const retiredSlug = `vsc-retired-${stamp}`;

    beforeAll(async () => {
      // Старый fr-адрес другой книги, ведущий на её es-версию.
      await prisma.slugRedirect.create({
        data: {
          entityType: 'book',
          language: Language.fr,
          oldSlug: retiredSlug,
          newSlug: otherVersionSlug,
        },
      });
    });

    afterAll(async () => {
      await prisma.slugRedirect.deleteMany({ where: { oldSlug: retiredSlug } });
    });

    const patchBook = (slug: string) =>
      request(http())
        .patch(`/books/${ownBookId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug });

    it('a version slug that is an old address of another book in another language is refused', async () => {
      const en = await prisma.bookVersion.findFirstOrThrow({
        where: { bookId: ownBookId, language: Language.en },
        select: { id: true },
      });
      const res = await request(http())
        .patch(`/versions/${en.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug: retiredSlug })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('another book');
      const redirect = await prisma.slugRedirect.findFirst({ where: { oldSlug: retiredSlug } });
      expect(redirect?.newSlug).toBe(otherVersionSlug);
    });

    it('Book.slug does not take a version slug or an old address of another book', async () => {
      const toVersion = await patchBook(otherVersionSlug).expect(400);
      expect(JSON.stringify(toVersion.body)).toContain('another book');
      await patchBook(retiredSlug).expect(400);
      // `Book.slug` другой книги — тоже 400, а не 500 от `P2002`.
      await patchBook(otherSlug).expect(400);

      const book = await prisma.book.findUnique({
        where: { id: ownBookId },
        select: { slug: true },
      });
      expect(book?.slug).toBe(ownSlug);
    });

    it('check-slug without lang says the same as the write', async () => {
      for (const slug of [otherVersionSlug, retiredSlug]) {
        const res = await request(http())
          .get('/books/check-slug')
          .query({ slug, excludeId: ownBookId })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect((res.body as { exists: boolean }).exists).toBe(true);
      }
    });

    it('check-slug with lang sees an old address of another book too', async () => {
      const res = await request(http())
        .get('/books/check-slug')
        .query({ slug: retiredSlug, lang: Language.ru, excludeId: ownBookId })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((res.body as { exists: boolean }).exists).toBe(true);
    });

    it('an old address of the own book is free to take back', async () => {
      const ownRetired = `vsc-own-retired-${stamp}`;
      await prisma.slugRedirect.create({
        data: { entityType: 'book', language: Language.pt, oldSlug: ownRetired, newSlug: ownSlug },
      });
      try {
        const res = await request(http())
          .get('/books/check-slug')
          .query({ slug: ownRetired, excludeId: ownBookId })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect((res.body as { exists: boolean }).exists).toBe(false);
      } finally {
        await prisma.slugRedirect.deleteMany({ where: { oldSlug: ownRetired } });
      }
    });

    it('a version slug out of SLUG_PATTERN or longer than 100 is refused by validation', async () => {
      await create(Language.ru, 'Bad--Slug').expect(400);
      await create(Language.ru, 'a'.repeat(101)).expect(400);
    });

    it('PATCH version: a stored slug over the limit passes unchanged, a changed one is refused (LEGACY-437)', async () => {
      const longSlug = `${'a'.repeat(SLUG_MAX_LENGTH)}-${stamp}`;
      const version = await prisma.bookVersion.findFirstOrThrow({
        where: { bookId: ownBookId, language: Language.ru },
        select: { id: true, slug: true },
      });
      const patch = (body: object) =>
        request(http())
          .patch(`/versions/${version.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send(body);

      // Слаг старой записи длиннее предела, введённого позже: пишем мимо ручки.
      await prisma.bookVersion.update({ where: { id: version.id }, data: { slug: longSlug } });
      try {
        await patch({ slug: longSlug, title: 'Kept' }).expect(200);
        const refused = await patch({ slug: `${longSlug}-x` }).expect(400);
        expect(JSON.stringify(refused.body)).toContain(SLUG_MAX_LENGTH_MESSAGE);
      } finally {
        await prisma.bookVersion.update({
          where: { id: version.id },
          data: { slug: version.slug },
        });
      }
    });

    it('PATCH book: a stored slug over the limit passes unchanged, a changed one or null is refused (LEGACY-437)', async () => {
      const longSlug = `${'b'.repeat(SLUG_MAX_LENGTH)}-${stamp}`;
      await prisma.book.update({ where: { id: ownBookId }, data: { slug: longSlug } });
      try {
        await patchBook(longSlug).expect(200);
        const refused = await patchBook(`${longSlug}-x`).expect(400);
        expect(JSON.stringify(refused.body)).toContain(SLUG_MAX_LENGTH_MESSAGE);
        await request(http())
          .patch(`/books/${ownBookId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ slug: null })
          .expect(400);
      } finally {
        await prisma.book.update({ where: { id: ownBookId }, data: { slug: ownSlug } });
      }
    });

    it('PATCH version: null in a required field is 400, not 500 (LEGACY-437, T110)', async () => {
      // Версия из `beforeAll`: тест не зависит от порядка соседних.
      const version = await prisma.bookVersion.findFirstOrThrow({
        where: { slug: otherVersionSlug },
        select: { id: true },
      });
      for (const field of ['language', 'title', 'author', 'type', 'isFree']) {
        const res = await request(http())
          .patch(`/versions/${version.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ [field]: null })
          .expect(400);
        expect(JSON.stringify(res.body)).toContain(field);
      }
      // Отказ на входе: запись не тронута.
      const after = await prisma.bookVersion.findUniqueOrThrow({ where: { id: version.id } });
      expect(after).toMatchObject({ title: 'Title', author: 'Author', isFree: true });
    });

    it('check-slug refuses a slug over the limit and answers one at the limit (LEGACY-437)', async () => {
      const check = (slug: string) =>
        request(http())
          .get('/books/check-slug')
          .query({ slug })
          .set('Authorization', `Bearer ${adminToken}`);

      const refused = await check('c'.repeat(SLUG_MAX_LENGTH + 1)).expect(400);
      expect(JSON.stringify(refused.body)).toContain(SLUG_MAX_LENGTH_MESSAGE);
      await check('c'.repeat(SLUG_MAX_LENGTH)).expect(200);
    });
  });
});
