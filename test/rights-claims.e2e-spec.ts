/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights } from './helpers/book-with-rights';
import type { PrismaClient } from '@prisma/client';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * Phase 16 rights claims / DMCA e2e. Requires a live database, so it is not part of the
 * local unit run — execute on the VPS/CI with `yarn test:e2e:serial`.
 */
describe('Rights claims e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let bookId: string;
  let versionId: string;
  let chapterId: string;
  let claimId: string;
  let worldwideBlockId: string;
  let countryBlockId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const slug = `rights-claims-e2e-${Date.now()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const created = await createBookWithRights(prisma as unknown as PrismaClient, slug);
    bookId = created.book.id;

    // The version stays `published` for the whole suite: a draft version is not served
    // publicly at all (404 before any enforcement runs), so 451 would be unreachable.
    const version = await prisma.bookVersion.create({
      data: {
        bookId: created.book.id,
        language: 'en',
        title: 'Claimed edition',
        author: 'Test Author',
        description: 'Version that will receive a DMCA notice',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: 'text',
        isFree: true,
        status: 'published',
        // `LEGACY-180`: у опубликованной версии есть дата публикации и лицензионный
        // снимок — именно их обязана погасить блокировка по претензии. Без них
        // проверка гашения ничего не стережёт: гасить было бы нечего.
        publishedAt: new Date('2026-09-01T10:00:00.000Z'),
        rightsLicenseIds: ['lic-e2e'],
        rightsLicenseCoverageStatus: 'COVERED',
        rightsLicenseCheckedAt: new Date('2026-09-01T09:59:00.000Z'),
        rightsLicenseUncoveredCountryCodes: ['BR'],
        rightsLicenseAttributionTextRu: 'Издано по лицензии',
        rightsProfileId: created.profile.id,
        approvedRightsReviewId: created.review.id,
        rightsStatus: 'APPROVED',
        rightsAllowedCountryCodes: [],
        rightsBlockedCountryCodes: [],
        rightsLicenseRequiredCountryCodes: [],
        rightsPendingCountryCodes: [],
        rightsRequiredActions: [],
      },
    });
    versionId = version.id;

    const chapter = await prisma.chapter.create({
      data: {
        bookVersionId: versionId,
        number: 1,
        title: 'Chapter one',
        content: 'Claimed text',
      },
    });
    chapterId = chapter.id;

    const password = 'password123';
    const adminRegistration = await request(http())
      .post('/auth/register')
      .send({ email: 'admin@example.com', password });
    if (adminRegistration.status === 201) {
      adminAccess = adminRegistration.body.accessToken as string;
    } else {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: 'admin@example.com', password })
        .expect(200);
      adminAccess = login.body.accessToken as string;
    }
    await grantStaffRoles(app, 'admin@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  // LEGACY-119. Идентификаторы модуля объявлены `@IsString()`, то есть любая
  // непустая строка доходила до сервиса и до базы: пустой результат поиска и 404
  // либо отказ на внешнем ключе, который клиент видит как 500. В схеме все они
  // uuid — форма значения известна заранее и проверяема.
  it('rejects a non-uuid identifier with 400 and names the field', async () => {
    await request(http())
      .post('/admin/rights/claims')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        claimType: 'DMCA_TAKEDOWN',
        severity: 'HIGH',
        claimantName: 'Acme Publishing',
        claimantType: 'PUBLISHER',
        claimantIsAuthorized: true,
        bookId: 'not-a-uuid',
        descriptionRu: 'Правообладатель требует удалить текст.',
        goodFaithStatement: true,
      })
      .expect(400)
      .expect(({ body }) => {
        // Именно про поле, а не «просто 400»: 400 отдаёт и любая другая
        // непройденная проверка тела.
        expect((body.message as string[]).join(' ')).toContain('bookId');
      });
  });

  // LEGACY-200. Три поля модуля оставались `@IsString()` дольше остальных: `id`
  // `RightsProfile` и `RightsIntake` задавали снаружи фикстуры, и ужесточение
  // отбило бы значение, валидное в базе. С 08.09.2026 фикстуры этого не делают,
  // поля переведены на `@IsUUID()`. Посадка на оба входа: тело создания и
  // query-фильтр списка — одного мало, ужесточение сняли бы на второй половине
  // и заметить это было бы нечем.
  it('rejects a non-uuid rightsProfileId/rightsIntakeId in the body with 400 (LEGACY-200)', async () => {
    await request(http())
      .post('/admin/rights/claims')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        claimType: 'DMCA_TAKEDOWN',
        severity: 'HIGH',
        claimantName: 'Acme Publishing',
        claimantType: 'PUBLISHER',
        claimantIsAuthorized: true,
        rightsProfileId: 'seed-profile-harry-potter',
        rightsIntakeId: 'seed-intake-harry-potter',
        descriptionRu: 'Правообладатель требует удалить текст.',
        goodFaithStatement: true,
      })
      .expect(400)
      .expect(({ body }) => {
        // Оба поля названы поимённо: возврат одного из них к `@IsString()`
        // оставил бы 400 от второго, и проверка «просто 400» не покраснела бы.
        const message = (body.message as string[]).join(' ');
        expect(message).toContain('rightsProfileId');
        expect(message).toContain('rightsIntakeId');
      });
  });

  it('rejects a non-uuid rightsProfileId in the list filter with 400 (LEGACY-200)', async () => {
    await request(http())
      .get('/admin/rights/claims')
      .query({ rightsProfileId: 'seed-profile-harry-potter' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400)
      .expect(({ body }) => {
        expect((body.message as string[]).join(' ')).toContain('rightsProfileId');
      });
  });

  // Положительный контроль к двум проверкам выше: uuid-значение несуществующего
  // профиля проходит валидацию и доходит до выборки. Без него обе краснели бы
  // и на коде, где фильтр отвергает вообще всё.
  it('accepts a well-formed uuid in the list filter (LEGACY-200)', async () => {
    await request(http())
      .get('/admin/rights/claims')
      .query({ rightsProfileId: randomUUID() })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual([]);
      });
  });

  // LEGACY-426. Окно `receivedFrom`/`receivedTo` — дата-время с зоной, как у журнала
  // `GET /admin/audit-events` (решение арбитра 29.09.2026): голая дата читалась полуночью
  // UTC и `receivedTo=<сегодня>` молча отрезал весь день; перевёрнутое окно давало пустой 200.
  it('rejects a bare date in receivedTo with 400 and names the field (LEGACY-426)', async () => {
    await request(http())
      .get('/admin/rights/claims')
      .query({ receivedTo: '2026-09-27' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400)
      .expect(({ body }) => {
        expect((body.message as string[]).join(' ')).toContain('receivedTo');
      });
  });

  it('rejects receivedFrom later than receivedTo with 400 instead of an empty 200 (LEGACY-426)', async () => {
    await request(http())
      .get('/admin/rights/claims')
      .query({ receivedFrom: '2026-09-28T00:00:00Z', receivedTo: '2026-09-27T00:00:00Z' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe('receivedFrom must not be later than receivedTo');
      });
  });

  // Положительный контроль: окно с датой-временем и зоной проходит валидацию и доходит до выборки.
  it('accepts a zoned date-time window in the list filter (LEGACY-426)', async () => {
    await request(http())
      .get('/admin/rights/claims')
      .query({ receivedFrom: '2000-01-01T00:00:00Z', receivedTo: '2000-01-01T23:59:59.999Z' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual([]);
      });
  });

  // LEGACY-202. Половина модуля была закрыта, а половина нет: `LEGACY-119`
  // проверила тело и query-фильтры, а параметры пути остались строкой. Битый
  // `:id` доходил до `requireClaim` и возвращался как 404 «не найдено» — то есть
  // «претензии нет» и «идентификатор битый» выглядели снаружи одинаково.
  it('rejects a non-uuid path parameter with 400, not 404', async () => {
    await request(http())
      .get('/admin/rights/claims/not-a-uuid')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);
  });

  /**
   * Вложенный идентификатор проверяется своим пайпом: проверка на одном только
   * `:id` прошла бы и на коде, где `:blockId` голый.
   *
   * ⚠️ Тело обязано быть **валидным** (`LiftClaimBlockDto` требует
   * `liftReasonRu`). С полем не из DTO глобальный `ValidationPipe`
   * (`whitelist` + `forbidNonWhitelisted`) отдаёт 400 сам, и тест зеленел бы
   * на коде без пайпа вовсе — то есть ничего бы не сажал.
   */
  it('rejects a non-uuid nested path parameter with 400, not 404', async () => {
    const response = await request(http())
      .post(`/admin/rights/claims/${randomUUID()}/blocks/not-a-uuid/lift`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ liftReasonRu: 'Проверка формы идентификатора.' })
      .expect(400);

    // 400 именно от пайпа, а не от разбора тела: `ParseUUIDPipe` отвечает
    // одной строкой `Validation failed (uuid is expected)` и имени параметра
    // не называет, тогда как глобальный `ValidationPipe` кладёт в `message`
    // **массив** сообщений с именами полей. Без этой проверки тест зеленел бы
    // на любом 400, откуда бы тот ни пришёл.
    expect(response.body).toMatchObject({ message: 'Validation failed (uuid is expected)' });
  });

  /**
   * Обратная половина: с валидным `:blockId` и валидным телом до пайпа
   * претензия не находится и ответ 404. Без этой пары первый тест зеленеет
   * на любом 400, откуда бы он ни пришёл.
   */
  it('валидные uuid в пути доходят до сервиса и дают 404, а не 400', async () => {
    await request(http())
      .post(`/admin/rights/claims/${randomUUID()}/blocks/${randomUUID()}/lift`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ liftReasonRu: 'Проверка формы идентификатора.' })
      .expect(404);
  });

  it('registers a claim that blocks publication with ACTIVE_RIGHTS_CLAIM', async () => {
    const created = await request(http())
      .post('/admin/rights/claims')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        claimType: 'DMCA_TAKEDOWN',
        severity: 'HIGH',
        claimantName: 'Acme Publishing',
        claimantType: 'PUBLISHER',
        claimantIsAuthorized: true,
        bookVersionId: versionId,
        descriptionRu: 'Правообладатель требует удалить текст.',
        goodFaithStatement: true,
      })
      .expect(201);

    claimId = created.body.id as string;
    expect(created.body.claimNumber).toMatch(/^CLM-\d{4}-\d{6}$/);
    expect(created.body.isOpen).toBe(true);
    expect(created.body.blocksPublication).toBe(true);
    expect(created.body.events.some((e: { eventType: string }) => e.eventType === 'CREATED')).toBe(
      true,
    );

    // An open blocking claim stops publication on its own, before any access block exists.
    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({})
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe('RIGHTS_PUBLICATION_BLOCKED');
        expect(
          body.blockingReasons.some((r: { code: string }) => r.code === 'ACTIVE_RIGHTS_CLAIM'),
        ).toBe(true);
      });
  });

  it('answers 451 BLOCKED_BY_RIGHTS_CLAIM on the public chapter endpoint', async () => {
    const blocks = await request(http())
      .post(`/admin/rights/claims/${claimId}/blocks`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        scope: 'LANGUAGE_EDITION',
        reasonRu: 'Контент снят до выяснения обстоятельств.',
      })
      .expect(201);

    expect(blocks.body).toHaveLength(1);
    expect(blocks.body[0].countryCode).toBeNull();
    expect(blocks.body[0].effectiveStatus).toBe('ACTIVE');
    worldwideBlockId = blocks.body[0].id as string;

    const assertBlockedBody = ({ body }: { body: Record<string, unknown> }): void => {
      expect(body.code).toBe('BLOCKED_BY_RIGHTS_CLAIM');
      // The public body must never leak claim internals.
      expect(body.claimId).toBeUndefined();
      expect(body.claimNumber).toBeUndefined();
      expect(body.claimantName).toBeUndefined();
    };

    // A worldwide block fires for a known country…
    await request(http())
      .get(`/chapters/${chapterId}`)
      .set('X-Geo-Country', 'US')
      .expect(451)
      .expect(assertBlockedBody);

    // …and for an unknown one, unlike a country-scoped restriction.
    await request(http()).get(`/chapters/${chapterId}`).expect(451).expect(assertBlockedBody);
  });

  it('applies a country-scoped block only in the listed country', async () => {
    await request(http())
      .post(`/admin/rights/claims/${claimId}/blocks/${worldwideBlockId}/lift`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ liftReasonRu: 'Заменяем на страновую блокировку.' })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('LIFTED');
      });

    const blocks = await request(http())
      .post(`/admin/rights/claims/${claimId}/blocks`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        scope: 'TEXT_READER',
        countryCodes: ['DE'],
        reasonRu: 'Ограничение только для Германии.',
      })
      .expect(201);

    expect(blocks.body).toHaveLength(1);
    expect(blocks.body[0].countryCode).toBe('DE');
    countryBlockId = blocks.body[0].id as string;

    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'DE').expect(451);
    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'US').expect(200);
    // An unknown country is not blocked by a country-scoped restriction (Phase 12 policy).
    await request(http()).get(`/chapters/${chapterId}`).expect(200);
  });

  it('restores access after resolving the claim with liftActiveBlocks', async () => {
    await request(http())
      .post(`/admin/rights/claims/${claimId}/resolve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        resolution: 'INVALID_REJECTED',
        resolutionNotesRu: 'Произведение в общественном достоянии.',
        liftActiveBlocks: true,
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.status).toBe('RESOLVED_INVALID');
        expect(body.isOpen).toBe(false);
        expect(body.activeBlocksCount).toBe(0);
        expect(body.accessBlocks.find((b: { id: string }) => b.id === countryBlockId).status).toBe(
          'LIFTED',
        );
        expect(body.events.some((e: { eventType: string }) => e.eventType === 'RESOLVED')).toBe(
          true,
        );
      });

    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'DE').expect(200);

    await request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(
          body.blockingReasons.some((r: { code: string }) => r.code === 'ACTIVE_RIGHTS_CLAIM'),
        ).toBe(false);
        expect(body.blockingClaimsCount).toBe(0);
        expect(body.activeClaimsCount).toBe(0);
      });
  });

  it('exposes claims on the navigation endpoints and never deletes them', async () => {
    await request(http())
      .get(`/admin/versions/${versionId}/rights-claims`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.some((c: { id: string }) => c.id === claimId)).toBe(true);
      });

    await request(http())
      .get(`/admin/books/${bookId}/rights-claims`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items.some((c: { id: string }) => c.id === claimId)).toBe(true);
      });

    // There is no delete route for claims — closing is the only terminal operation.
    await request(http())
      .delete(`/admin/rights/claims/${claimId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404);
  });

  // Runs last: it takes the version out of publication for the rest of the suite.
  it('takes the version out of publication when unpublishVersion is requested', async () => {
    const created = await request(http())
      .post('/admin/rights/claims')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        claimType: 'COPYRIGHT_INFRINGEMENT',
        severity: 'CRITICAL',
        claimantName: 'Second Claimant',
        bookVersionId: versionId,
        descriptionRu: 'Вторая претензия с немедленным снятием с публикации.',
      })
      .expect(201);
    const secondClaimId = created.body.id as string;
    expect(created.body.status).toBe('RECEIVED');

    // The auto-advance on block only fires for transitions the matrix allows, and
    // RECEIVED → CONTENT_REMOVED is not one of them — the claim has to be triaged first.
    await request(http())
      .post(`/admin/rights/claims/${secondClaimId}/status`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'UNDER_REVIEW' })
      .expect(201);

    await request(http())
      .post(`/admin/rights/claims/${secondClaimId}/blocks`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        scope: 'LANGUAGE_EDITION',
        reasonRu: 'Немедленное снятие контента.',
        unpublishVersion: true,
      })
      .expect(201);

    await request(http())
      .get(`/admin/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('draft');
        expect(body.rightsClaimBlockActive).toBe(true);
      });

    // `LEGACY-180`: блокировка по претензии гасит лицензионный снимок так же, как
    // админское снятие с публикации, — иначе черновик остаётся с датой публикации
    // и списком лицензий и в дашборде прав выглядит опубликованным. Проверяется
    // на живой базе: гашение идёт под замком строки, и мок его не подтвердит.
    const blocked = await prisma.bookVersion.findUnique({ where: { id: versionId } });
    expect(blocked?.publishedAt).toBeNull();
    expect(blocked?.rightsLicenseIds).toBeNull();
    expect(blocked?.rightsLicenseCoverageStatus).toBeNull();
    expect(blocked?.rightsLicenseCheckedAt).toBeNull();
    expect(blocked?.rightsLicenseUncoveredCountryCodes).toBeNull();

    await request(http())
      .get(`/admin/rights/claims/${secondClaimId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect(({ body }) => {
        // A worldwide edition-wide block advances a triaged claim to CONTENT_REMOVED.
        expect(body.status).toBe('CONTENT_REMOVED');
        expect(
          body.events.some((e: { eventType: string }) => e.eventType === 'VERSION_UNPUBLISHED'),
        ).toBe(true);
      });

    // Снимок обязан пережить гашение колонок: после блокировки ответить, на что опиралась
    // публикация, больше нечем (ADR-009). Он лежит в журнале административных действий,
    // а не в событии претензии: у того внешний ключ на претензию, а у неё каскад от версии.
    // Сверяются **значения**, а не имена ключей: пустой снимок с полным набором ключей —
    // ровно тот дефект, от которого эта посадка и стоит.
    const auditRow = await prisma.adminAuditEvent.findFirst({
      where: { targetType: 'BOOK_VERSION', targetId: versionId, action: 'VERSION_UNPUBLISHED' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.payload).toEqual({
      publishedAt: '2026-09-01T10:00:00.000Z',
      rightsLicenseIds: ['lic-e2e'],
      rightsLicenseCoverageStatus: 'COVERED',
      rightsLicenseCheckedAt: '2026-09-01T09:59:00.000Z',
      rightsLicenseUncoveredCountryCodes: ['BR'],
    });

    // История претензии называет снятую версию и снимка не несёт.
    const unpublishEvent = await prisma.rightsClaimEvent.findFirst({
      where: { rightsClaimId: secondClaimId, eventType: 'VERSION_UNPUBLISHED' },
    });
    expect(unpublishEvent).not.toBeNull();
    expect(unpublishEvent?.payload).toEqual({ bookVersionId: versionId });

    // Атрибуция лицензии публикации не принадлежит и остаётся на версии.
    expect(blocked?.rightsLicenseAttributionTextRu).toBe('Издано по лицензии');

    // An unpublished version is not served publicly at all, so the answer is 404, not 451.
    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'US').expect(404);
  });

  /**
   * `LEGACY-396`, пачка `T72`: персону, указанную заявителем закрытой претензии, нельзя было
   * удалить никогда — `PATCH` на `CLOSED` пускает только `internalNotesRu`, а удаление персоны
   * отказывает по этой связи. Снятие разрешил владелец 29.09.2026 с записью в журнал; форма —
   * отдельная ручка только для администратора (решение арбитра 30.09.2026).
   */
  describe('DELETE /admin/rights/claims/:id/claimant-person', () => {
    it('снимает заявителя у закрытой претензии, пишет событие, и персона удаляется', async () => {
      const stamp = Date.now();
      const person = await request(http())
        .post('/admin/contributors')
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ displayName: `Claimant Person ${stamp}` })
        .expect(201);
      const personId = (person.body as { id: string }).id;

      const created = await request(http())
        .post('/admin/rights/claims')
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({
          claimType: 'DMCA_TAKEDOWN',
          claimantName: 'Claimant Person',
          claimantPersonId: personId,
          descriptionRu: 'Претензия, у которой снимут заявителя.',
          bookId,
          blocksPublication: false,
          blocksPublicationOverrideReasonRu: 'Публикацию не держит: проверяется только заявитель.',
        })
        .expect(201);
      const closedClaimId = created.body.id as string;
      // Путь до `CLOSED` через переходы статуса к проверке отношения не имеет: состояние
      // задаётся фикстурой, а поведение ниже проверяется только через HTTP.
      await prisma.rightsClaim.update({
        where: { id: closedClaimId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });

      // Общий PATCH закрытую претензию по-прежнему не правит — исключения в правило не внесено.
      await request(http())
        .patch(`/admin/rights/claims/${closedClaimId}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ claimantPersonId: null })
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('CLAIM_CLOSED_IMMUTABLE'));

      const refused = await request(http())
        .delete(`/admin/contributors/${personId}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(400);
      expect((refused.body as { message: string }).message).toContain(
        `1 rights claim records as claimant (ids: ${closedClaimId}; ` +
          'unlink via DELETE /admin/rights/claims/:id/claimant-person, admin only)',
      );

      const unlinked = await request(http())
        .delete(`/admin/rights/claims/${closedClaimId}/claimant-person`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);
      expect(unlinked.body).toMatchObject({
        id: closedClaimId,
        status: 'CLOSED',
        claimantPersonId: null,
        claimantName: 'Claimant Person',
      });

      const events = await prisma.rightsClaimEvent.findMany({
        where: { rightsClaimId: closedClaimId, eventType: 'UPDATED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        changedFields: ['claimantPersonId'],
        previousClaimantPersonId: personId,
        reason: 'claimant-unlink',
      });

      // Повторный вызов — тот же ответ и ни одного нового события.
      await request(http())
        .delete(`/admin/rights/claims/${closedClaimId}/claimant-person`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);
      expect(
        await prisma.rightsClaimEvent.count({
          where: { rightsClaimId: closedClaimId, eventType: 'UPDATED' },
        }),
      ).toBe(1);

      await request(http())
        .delete(`/admin/contributors/${personId}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);
    });

    it('400 на идентификаторе не в форме uuid, а не 500 из сырого SQL замка', async () => {
      await request(http())
        .delete('/admin/rights/claims/not-a-uuid/claimant-person')
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(400);
    });

    it('404 на несуществующей претензии', async () => {
      await request(http())
        .delete('/admin/rights/claims/00000000-0000-0000-0000-000000000000/claimant-person')
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(404);
    });

    it('без токена 401, контент-менеджеру 403: ручка только для администратора', async () => {
      const email = `claims-manager-${Date.now()}@example.com`;
      const registered = await request(http())
        .post('/auth/register')
        .send({ email, password: 'password123' })
        .expect(201);
      const managerAccess = registered.body.accessToken as string;
      const managerId = registered.body.user.id as string;
      await request(http())
        .post(`/users/${managerId}/roles/content_manager`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(201);

      const path = '/admin/rights/claims/00000000-0000-0000-0000-000000000000/claimant-person';
      await request(http()).delete(path).expect(401);
      await request(http())
        .delete(path)
        .set('Authorization', `Bearer ${managerAccess}`)
        .expect(403);
    });
  });
});
