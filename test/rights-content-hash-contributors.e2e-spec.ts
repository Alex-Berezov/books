/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookType, Language } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * WP-8.1 (R1-01) — участники в content hash, сквозная трассировка «HTTP-вход → эффект в БД».
 *
 * Сценарий отказа из отчёта ревью: книга проходит клиренс с переводчиком, умершим в 1940
 * (перевод в public domain), редактор меняет данные участника на переводчика, умершего
 * в 1990 (перевод под охраной) — и до WP-8 хеш не менялся, и смена была невидима.
 *
 * Решение владельца от 27.09.2026 (правовая семантика): правка после утверждения прав публикацию
 * не блокирует. Смена участника пишет событие аудита со `staleMarked: false`
 * (`reasonCode = CONTENT_CHANGE_LOGGED`), а клиренс не аннулируется ни в черновике, ни
 * в опубликованной версии. Baseline правкой не переснимается — это слепок, на котором утверждён
 * клиренс (ревью books-data, ADR-009); гейт показывает расхождение предупреждением
 * `RIGHTS_CONTENT_HASH_CHANGED`.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 */
describe('Rights content hash — contributors (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let versionId: string;
  let personId: string;
  let contributorId: string;
  let bookWithRights: Awaited<ReturnType<typeof createBookWithRights>>;

  const slug = `hash-contributors-${Date.now()}`;
  const createdSlugs: string[] = [];
  const createdPersonIds: string[] = [];
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const versionRow = async () =>
    prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        rightsContentHash: true,
        rightsRecheckRequired: true,
        rightsStaleReasonCode: true,
        rightsStaleDetectedAt: true,
      },
    });

  /**
   * Возврат версии в «проверенное» состояние: реакция на каждое изменение проверяется
   * по отдельности, от чистого слепка и утверждённого клиренса.
   */
  const rebaseline = async () => {
    const fresh = await request(http())
      .get(`/admin/versions/${versionId}/rights-content-hash`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await prisma.bookVersion.update({
      where: { id: versionId },
      data: {
        rightsContentHash: fresh.body.currentHash as string,
        rightsRecheckRequired: false,
        rightsStaleDetectedAt: null,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
      },
    });
    await prisma.rightsReview.update({
      where: { id: bookWithRights.review.id },
      data: { status: 'HUMAN_APPROVED', staleDetectedAt: null, staleReasonCode: null },
    });
    await prisma.rightsProfile.update({
      where: { id: bookWithRights.profile.id },
      data: { status: 'APPROVED', staleDetectedAt: null, staleReasonCode: null },
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

    const email = 'admin-hash-contributors@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    }
    await grantStaffRoles(app, email);

    bookWithRights = await createBookWithRights(prisma, slug);

    const created = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Contributors hash EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    versionId = created.body.id as string;

    const person = await request(http())
      .post('/admin/persons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        canonicalName: `Переводчик ${Date.now()}`,
        birthYear: 1870,
        deathYear: 1940,
        publicDomainFromYear: 2011,
      })
      .expect(201);
    personId = person.body.id as string;
  });

  afterAll(async () => {
    await prisma.bookVersionContributor.deleteMany({ where: { bookVersionId: versionId } });
    await cleanupBookWithRights(prisma, slug);
    // LEGACY-200: `RightsProfile.id` больше не выводится из слага литералом, отдельного
    // deleteMany по нему не построить - `cleanupBookWithRights` находит профиль по книге,
    // а `RightsProfileContributor.rightsProfileId` каскадно удаляется вместе с ним
    // (`onDelete: Cascade`, schema.prisma:1944).
    for (const extraSlug of createdSlugs) {
      await cleanupBookWithRights(prisma, extraSlug);
    }
    await prisma.person.deleteMany({ where: { id: { in: [personId, ...createdPersonIds] } } });
    await app.close();
  });

  /**
   * Черновик: состав участников уточняют до публикации — клиренс остаётся утверждённым,
   * утверждённый слепок не затирается, событие аудита пишется всегда.
   */
  it('only logs a translator added to a draft version and keeps the approved baseline', async () => {
    const before = await versionRow();
    expect(before?.rightsRecheckRequired).toBe(false);

    const created = await request(http())
      .post(`/admin/versions/${versionId}/contributors`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ personId, role: 'TRANSLATOR' })
      .expect(201);
    contributorId = created.body.id as string;

    const after = await versionRow();
    expect(after?.rightsRecheckRequired).toBe(false);
    expect(after?.rightsStaleReasonCode).toBeNull();
    // Baseline не переснят: он и есть слепок «под чем утверждали».
    expect(after?.rightsContentHash).toBe(before?.rightsContentHash);

    const review = await prisma.rightsReview.findUnique({
      where: { id: bookWithRights.review.id },
      select: { status: true },
    });
    expect(review?.status).toBe('HUMAN_APPROVED');
    const profile = await prisma.rightsProfile.findUnique({
      where: { id: bookWithRights.profile.id },
      select: { status: true },
    });
    expect(profile?.status).toBe('APPROVED');

    // Событие аудита: значение enum'а — существующее, точная причина в reasonCode (WP-8.1).
    const events = await prisma.rightsContentHashEvent.findMany({
      where: { bookVersionId: versionId, reasonCode: 'CONTENT_CHANGE_LOGGED' },
      select: { trigger: true, staleMarked: true, previousHash: true, currentHash: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].trigger).toBe('RIGHTS_SNAPSHOT_CHANGED');
    expect(events[0].staleMarked).toBe(false);
    expect(events[0].previousHash).toBe(before?.rightsContentHash);
    expect(events[0].currentHash).not.toBe(events[0].previousHash);
  });

  /** Клиренс версии и её профиля/проверки прав после правки остаётся утверждённым. */
  const expectClearanceApproved = async () => {
    const review = await prisma.rightsReview.findUnique({
      where: { id: bookWithRights.review.id },
      select: { status: true },
    });
    expect(review?.status).toBe('HUMAN_APPROVED');
    const profile = await prisma.rightsProfile.findUnique({
      where: { id: bookWithRights.profile.id },
      select: { status: true },
    });
    expect(profile?.status).toBe('APPROVED');
  };

  /**
   * До решения владельца от 27.09.2026 окно наполнения закрывалось публикацией, и та же правка
   * состава участников в опубликованной версии аннулировала клиренс целиком. Теперь — только
   * журнал: baseline прежний, stale не выставлен, клиренс утверждён.
   */
  it('only logs a translator change in a published version, without marking anything stale', async () => {
    await rebaseline();
    await prisma.bookVersion.update({
      where: { id: versionId },
      data: { status: 'published', publishedAt: new Date() },
    });
    const before = await versionRow();
    expect(before?.rightsRecheckRequired).toBe(false);

    await request(http())
      .patch(`/admin/versions/${versionId}/contributors/${contributorId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ creditedName: 'Иной перевод' })
      .expect(200);

    const after = await versionRow();
    expect(after?.rightsRecheckRequired).toBe(false);
    expect(after?.rightsStaleReasonCode).toBeNull();
    expect(after?.rightsStaleDetectedAt).toBeNull();
    // Baseline не переснят: он и есть слепок «под чем утверждали».
    expect(after?.rightsContentHash).toBe(before?.rightsContentHash);
    await expectClearanceApproved();

    const events = await prisma.rightsContentHashEvent.findMany({
      where: {
        bookVersionId: versionId,
        reasonCode: 'CONTENT_CHANGE_LOGGED',
        previousHash: before?.rightsContentHash,
      },
      select: { trigger: true, staleMarked: true, previousHash: true, currentHash: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].trigger).toBe('RIGHTS_SNAPSHOT_CHANGED');
    expect(events[0].staleMarked).toBe(false);
    expect(events[0].currentHash).not.toBe(events[0].previousHash);
    await expect(
      prisma.rightsContentHashEvent.count({
        where: { bookVersionId: versionId, staleMarked: true },
      }),
    ).resolves.toBe(0);
  });

  it('only logs a change of the death year of the translator', async () => {
    await rebaseline();
    const before = await versionRow();
    expect(before?.rightsRecheckRequired).toBe(false);

    await request(http())
      .patch(`/admin/persons/${personId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ deathYear: 1990, publicDomainFromYear: 2061 })
      .expect(200);

    const after = await versionRow();
    expect(after?.rightsRecheckRequired).toBe(false);
    expect(after?.rightsStaleReasonCode).toBeNull();
    expect(after?.rightsContentHash).toBe(before?.rightsContentHash);
    await expectClearanceApproved();

    const events = await prisma.rightsContentHashEvent.findMany({
      where: {
        bookVersionId: versionId,
        reasonCode: 'CONTENT_CHANGE_LOGGED',
        previousHash: before?.rightsContentHash,
      },
      select: { staleMarked: true, previousHash: true, currentHash: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].staleMarked).toBe(false);
    expect(events[0].currentHash).not.toBe(events[0].previousHash);
  });

  it('shows the translator change as a warning, not a blocker', async () => {
    const gate = await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const codes = (gate.body.blockingReasons as Array<{ code: string }>).map((r) => r.code);
    for (const staleCode of [
      'RIGHTS_RECHECK_REQUIRED',
      'RIGHTS_CONTENT_HASH_CHANGED',
      'RIGHTS_REVIEW_STALE',
      'RIGHTS_PROFILE_STALE',
    ]) {
      expect(codes).not.toContain(staleCode);
    }

    const warnings = (gate.body.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(warnings).toContain('RIGHTS_CONTENT_HASH_CHANGED');
  });

  /**
   * WP-8.1, регрессия из CI. Участники профиля проецируются на версию при создании книги из
   * клиренса, а baseline снимался до проекции — новорождённая книга сразу не проходила гейт
   * с `RIGHTS_CONTENT_HASH_CHANGED`. Трассировка идёт по реальному пути создания книги.
   */
  it('publishes a book created from clearance whose profile has contributors', async () => {
    const freshSlug = `hash-creation-${Date.now()}`;
    const fresh = await createBookWithRights(prisma, freshSlug, { languages: [Language.en] });
    createdSlugs.push(freshSlug);

    const contributorPerson = await prisma.person.create({
      data: {
        canonicalName: `Автор ${Date.now()}`,
        birthYear: 1860,
        deathYear: 1930,
        publicDomainFromYear: 2001,
      },
    });
    createdPersonIds.push(contributorPerson.id);

    await prisma.rightsProfileContributor.create({
      data: {
        rightsProfileId: fresh.profile.id,
        personId: contributorPerson.id,
        role: 'AUTHOR',
        displayName: contributorPerson.canonicalName,
        canonicalName: contributorPerson.canonicalName,
        creditedName: contributorPerson.canonicalName,
        birthYear: contributorPerson.birthYear,
        deathYear: contributorPerson.deathYear,
        publicDomainFromYear: contributorPerson.publicDomainFromYear,
      },
    });

    // Книга создаётся штатным путём: интейк → create-book, а не помощником.
    await prisma.book.delete({ where: { id: fresh.book.id } });

    const created = await request(http())
      .post(`/admin/rights/intakes/${fresh.intake.id}/create-book`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        slug: freshSlug,
        versions: [
          {
            language: 'en',
            title: 'Created from clearance',
            author: contributorPerson.canonicalName,
            description: 'Desc',
            coverImageUrl: 'https://example.com/cover.jpg',
            type: 'text',
            isFree: true,
          },
        ],
      })
      .expect(201);

    const createdVersionId = (created.body.versions as Array<{ id: string }>)[0].id;

    // Участник действительно спроецирован — иначе тест ничего не проверяет.
    const projected = await prisma.bookVersionContributor.count({
      where: { bookVersionId: createdVersionId },
    });
    expect(projected).toBe(1);

    const gate = await request(http())
      .get(`/admin/versions/${createdVersionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const codes = (gate.body.blockingReasons as Array<{ code: string }>).map((r) => r.code);
    expect(codes).not.toContain('RIGHTS_CONTENT_HASH_CHANGED');

    await request(http())
      .patch(`/versions/${createdVersionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('leaves the clearance alone when only editorial fields of the person change', async () => {
    await rebaseline();
    const eventsBefore = await prisma.rightsContentHashEvent.count({
      where: { bookVersionId: versionId },
    });

    await request(http())
      .patch(`/admin/persons/${personId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notesRu: 'Уточнён источник даты смерти' })
      .expect(200);

    const after = await versionRow();
    expect(after?.rightsRecheckRequired).toBe(false);
    expect(after?.rightsStaleReasonCode).toBeNull();

    const hash = await request(http())
      .get(`/admin/versions/${versionId}/rights-content-hash`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(hash.body.matchesBaseline).toBe(true);

    // Ни правки версии, ни записи в аудит: правовые поля персоны не менялись.
    await expect(
      prisma.rightsContentHashEvent.count({ where: { bookVersionId: versionId } }),
    ).resolves.toBe(eventsBefore);
  });
});
