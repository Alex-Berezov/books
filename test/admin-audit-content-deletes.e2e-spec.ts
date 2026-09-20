/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';

/**
 * 🔴 `LEGACY-015`, пачка `T19`. Журнал административных действий на четырёх путях
 * физического удаления книжного контура — проверка на **живой базе**.
 *
 * ⚠️ Юнит-спеки этих путей подменяют `AdminAuditService` целиком и поэтому в принципе
 * не могут поймать три вещи, каждая из которых уезжает на прод молча:
 *
 * 1. значение перечисления, которого нет в базе: `AdminAuditAction.BOOK_DELETED`
 *    компилируется от сгенерированного клиента, а падает на `INSERT`, если миграция
 *    `20260920160000_legacy_015_audit_content_deletes` не накатилась;
 * 2. состав `payload` после сериализации в `Json`;
 * 3. **что каскад снёс ровно то, что перечислил журнал** — `doomedVersions` собирается
 *    запросом, а сносит строки `ON DELETE CASCADE` самой базы, и сойтись эти два списка
 *    обязаны на настоящем Postgres, а не на моке.
 *
 * Прецедент проверки — `book-version.e2e-spec.ts`, где так же читается `adminAuditEvent`
 * после публикации и снятия с публикации (`LEGACY-180`, пачка `V1`).
 */
describe('LEGACY-015 T19: журнал удалений книжного контура (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let actorUserId: string;
  const createdBookSlugs: string[] = [];
  // Переменная окружения восстанавливается в `afterAll`: прогон идёт в общем процессе
  // с соседними спеками, и оставленное значение меняет их поведение (круг 2 ревью).
  const adminEmailsBefore = process.env.ADMIN_EMAILS;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    } else {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }

    const admin = await prisma.user.findUniqueOrThrow({ where: { email } });
    actorUserId = admin.id;
  });

  afterAll(async () => {
    for (const slug of createdBookSlugs) {
      await cleanupBookWithRights(prisma, slug);
    }
    if (adminEmailsBefore === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = adminEmailsBefore;
    }
    await app.close();
  });

  const createVersion = async (bookId: string, language: Language): Promise<string> => {
    const res = await request(http())
      .post(`/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language,
        title: `Title ${language}`,
        author: 'Author',
        description: 'Description long enough to pass validation',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    return res.body.id as string;
  };

  it('DELETE /chapters/:id пишет CHAPTER_DELETED с актёром из токена', async () => {
    const slug = `audit-chapter-${Date.now()}`;
    const fixture = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);
    const versionId = await createVersion(fixture.book.id, Language.en);

    const chapterRes = await request(http())
      .post(`/versions/${versionId}/chapters`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ number: 1, title: 'Chapter one', content: 'Text of the chapter' })
      .expect(201);
    const chapterId = chapterRes.body.id as string;

    await request(http())
      .delete(`/chapters/${chapterId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'CHAPTER', targetId: chapterId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('CHAPTER_DELETED');
    expect(events[0].actorUserId).toBe(actorUserId);
    expect(events[0].payload).toEqual({ bookVersionId: versionId });

    // Строка главы действительно стёрта — событие описывает состоявшееся изменение.
    expect(await prisma.chapter.findUnique({ where: { id: chapterId } })).toBeNull();
  });

  it('DELETE /audio-chapters/:id пишет AUDIO_CHAPTER_DELETED с актёром из токена', async () => {
    const slug = `audit-audio-${Date.now()}`;
    const fixture = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);
    const versionId = await createVersion(fixture.book.id, Language.en);

    const audioRes = await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        number: 1,
        title: 'Audio one',
        audioUrl: 'https://example.com/audio/1.mp3',
        duration: 120,
      })
      .expect(201);
    const audioChapterId = audioRes.body.id as string;

    await request(http())
      .delete(`/audio-chapters/${audioChapterId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'AUDIO_CHAPTER', targetId: audioChapterId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('AUDIO_CHAPTER_DELETED');
    expect(events[0].actorUserId).toBe(actorUserId);
    expect(events[0].payload).toEqual({ bookVersionId: versionId });
  });

  it('DELETE /versions/:id пишет VERSION_DELETED со снимком лицензий и без признака каскада', async () => {
    const slug = `audit-version-${Date.now()}`;
    const fixture = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);
    const versionId = await createVersion(fixture.book.id, Language.en);

    await request(http())
      .delete(`/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'BOOK_VERSION', targetId: versionId, action: 'VERSION_DELETED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(actorUserId);

    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.bookId).toBe(fixture.book.id);
    expect(payload.language).toBe(Language.en);
    expect(payload.status).toBe('draft');
    // Признак каскада есть только у события, рождённого удалением книги.
    expect(payload.cascade).toBeUndefined();
    // Состав снимка — тот же, что у `VERSION_PUBLISHED`/`VERSION_UNPUBLISHED` (`LEGACY-180`).
    expect(payload).toHaveProperty('rightsLicenseIds');
    expect(payload).toHaveProperty('rightsLicenseCoverageStatus');
    expect(payload).toHaveProperty('rightsLicenseUncoveredCountryCodes');
  });

  /**
   * Главная проверка пачки: удаление книги каскадом сносит её версии, и журнал обязан
   * назвать **каждую**. Список, собранный `bookVersion.findMany` до удаления, должен
   * совпасть с тем, что реально снёс `ON DELETE CASCADE` — сойтись это может только
   * на настоящей базе.
   */
  it('DELETE /books/:id пишет BOOK_DELETED и VERSION_DELETED на каждую снесённую каскадом версию', async () => {
    const slug = `audit-book-${Date.now()}`;
    const fixture = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);

    const enVersionId = await createVersion(fixture.book.id, Language.en);
    const esVersionId = await createVersion(fixture.book.id, Language.es);

    await request(http())
      .delete(`/books/${fixture.book.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const bookEvents = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'BOOK', targetId: fixture.book.id },
    });
    expect(bookEvents).toHaveLength(1);
    expect(bookEvents[0].action).toBe('BOOK_DELETED');
    expect(bookEvents[0].actorUserId).toBe(actorUserId);
    // Строго, а не `toMatchObject`: сервис кладёт ровно эти два поля, и лишнее
    // в журнале — такая же находка, как недостающее (круг 2 ревью 20.09.2026).
    expect(bookEvents[0].payload).toEqual({ slug, versionCount: 2 });

    const versionEvents = await prisma.adminAuditEvent.findMany({
      where: {
        targetType: 'BOOK_VERSION',
        targetId: { in: [enVersionId, esVersionId] },
        action: 'VERSION_DELETED',
      },
      orderBy: { targetId: 'asc' },
    });
    expect(versionEvents).toHaveLength(2);
    for (const event of versionEvents) {
      expect(event.actorUserId).toBe(actorUserId);
      expect(event.payload).toMatchObject({ bookId: fixture.book.id, cascade: true });
    }

    // Каскад отработал: обеих версий в базе нет, и обе названы журналом.
    const survivors = await prisma.bookVersion.findMany({
      where: { id: { in: [enVersionId, esVersionId] } },
      select: { id: true },
    });
    expect(survivors).toEqual([]);
  });
});
