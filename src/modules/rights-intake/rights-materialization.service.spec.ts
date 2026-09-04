import { RightsMaterializationService } from './rights-materialization.service';
import { ComponentTerritoryAggregationService } from './component-territory-aggregation.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { RightsClaimEnforcementService } from '../rights-claims/rights-claim-enforcement.service';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import {
  PersonIdentityMissingError,
  PersonResolverService,
} from '../persons/person-resolver.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BadRequestException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  MATERIALIZATION_FAILED_REASON_RU,
  materializationFailedMessageRu,
} from './rights-review-import.constants';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

const makeValidReportJson = (): Record<string, unknown> => ({
  schemaVersion: '1.0',
  intakeId: 'intake-1',
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  summaryRu: 'test summary',
  conclusionRu: 'test conclusion',
  reasoningRu: 'test reasoning',
  nextReviewAt: '2027-01-01T00:00:00.000Z',
  sourceAssessment: {
    provider: 'PROJECT_GUTENBERG',
    status: 'ALLOWED',
    sourceTextType: 'ORIGINAL_TEXT',
    externalId: '12345',
    sourceUrl: 'https://example.com',
    sourceTitle: 'Test Book',
    sourceLanguage: 'en',
    gutenbergStatus: 'PUBLIC_DOMAIN',
    notesRu: 'test notes',
  },
  languageAssessments: [
    {
      languageCode: 'en',
      status: 'ALLOWED',
      translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
      translationSourceLanguage: null,
      requiresGeoBlock: false,
      notesRu: 'Оригинальный текст',
    },
    {
      languageCode: 'ru',
      status: 'LICENSE_REQUIRED',
      translationOrigin: 'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION',
      translationSourceLanguage: 'fr',
      requiresGeoBlock: true,
      notesRu: 'Перевод сделан с французского перевода',
    },
  ],
  componentAssessments: [
    {
      componentType: 'ORIGINAL_TEXT',
      titleRu: 'Original text',
      status: 'PUBLIC_DOMAIN',
      requiredAction: 'KEEP',
      confidence: 'HIGH',
    },
  ],
  territoryDecisions: [
    {
      countryCode: 'US',
      finalStatus: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      reasonRu: 'Public domain in US',
      confidence: 'HIGH',
    },
    {
      countryCode: 'FR',
      finalStatus: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      reasonRu: 'Public domain in FR',
      confidence: 'HIGH',
    },
  ],
  evidence: [
    {
      evidenceType: 'GUTENBERG_PAGE',
      sourceLevel: 'PRIMARY',
      title: 'Project Gutenberg page',
      authority: 'PG',
      url: 'https://gutenberg.org/ebooks/12345',
      jurisdictionCode: 'US',
      accessedAt: '2026-06-01T00:00:00.000Z',
      relevantExcerpt: 'This book is in the public domain',
      summaryRu: 'Страница PG',
    },
  ],
  requiredActions: [
    {
      actionType: 'REMOVE_COMPONENT',
      descriptionRu: 'Remove preface',
      affectedCountryCodes: ['US'],
      isBlocking: false,
      suggestedStatus: 'PENDING',
    },
  ],
});

const makeImportRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'import-1',
  rightsIntakeId: 'intake-1',
  importStatus: 'VALIDATED',
  isCurrent: true,
  reportJson: makeValidReportJson(),
  ...overrides,
});

const makeIntake = (overrides: Record<string, unknown> = {}) => ({
  id: 'intake-1',
  workflowStatus: 'REVIEW_IMPORTED',
  candidateTitle: 'Test Book',
  targetCountryCodes: ['US', 'FR'],
  ...overrides,
});

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  rightsIntakeId: 'intake-1',
  currentReviewImportId: 'import-1',
  status: 'IMPORTED',
  isCurrent: true,
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  summaryRu: 'test summary',
  conclusionRu: 'test conclusion',
  reasoningRu: 'test reasoning',
  nextReviewAt: new Date('2027-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  ...overrides,
});

interface PrismaStub {
  rightsIntake: { findUnique: jest.Mock };
  $transaction: jest.Mock;
  [key: string]: unknown;
}

const createPrismaStub = (): PrismaStub => {
  const stub: Record<string, unknown> = {
    rightsIntake: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };

  stub['rightsReviewImport'] = { findUnique: jest.fn() };
  stub['rightsProfile'] = {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  };
  stub['rightsReview'] = {
    updateMany: jest.fn(),
    // Phase 18: the chain linking below needs a review id back from `create`.
    create: jest.fn().mockResolvedValue({ id: 'review-1' }),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'review-1' }),
  };
  stub['sourceEdition'] = { create: jest.fn(), findUnique: jest.fn() };
  stub['editionRights'] = { create: jest.fn() };
  stub['rightsComponent'] = { create: jest.fn() };
  stub['componentTerritoryAssessment'] = { create: jest.fn() };
  stub['territoryDecision'] = { create: jest.fn() };
  stub['rightsEvidence'] = { create: jest.fn() };
  stub['rightsAction'] = { create: jest.fn() };
  stub['bookVersion'] = { findUnique: jest.fn(), update: jest.fn() };
  stub['geoBlockRule'] = { findMany: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() };
  stub['rightsProfileContributor'] = { create: jest.fn(), update: jest.fn() };
  stub['rightsLicense'] = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
  };
  stub['rightsLicenseLink'] = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
  };
  stub['rightsLicenseEvent'] = { create: jest.fn() };

  return stub as unknown as PrismaStub;
};

describe('RightsMaterializationService', () => {
  let service: RightsMaterializationService;
  let prisma: PrismaStub;
  let personResolver: { resolveOrCreatePerson: jest.Mock };
  let notifications: { create: jest.Mock };
  let aggregationService: ComponentTerritoryAggregationService;

  beforeEach(() => {
    prisma = createPrismaStub();
    aggregationService = new ComponentTerritoryAggregationService();
    personResolver = {
      resolveOrCreatePerson: jest.fn().mockResolvedValue({ id: 'person-1' }),
    };
    notifications = { create: jest.fn().mockResolvedValue({ id: 'notification-1' }) };
    service = new RightsMaterializationService(
      prisma as unknown as PrismaService,
      aggregationService,
      personResolver as unknown as PersonResolverService,
      notifications as unknown as RightsNotificationsService,
    );
    (prisma['rightsComponent'] as Record<string, jest.Mock>).create.mockResolvedValue({
      id: 'component-1',
    });
    (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
      id: 'source-edition-1',
    });
  });

  function setupTransaction() {
    prisma.$transaction.mockImplementation((fn: (tx: Record<string, unknown>) => unknown) =>
      fn(prisma as unknown as Record<string, unknown>),
    );
  }

  function setupBasicMocks(importOverrides: Record<string, unknown> = {}) {
    (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
      makeImportRecord(importOverrides),
    );
    prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());
    (prisma['rightsReview'] as Record<string, jest.Mock>).findFirst.mockResolvedValue(null);
  }

  describe('materializeFromImport', () => {
    it('should throw NotFoundException when import not found', async () => {
      (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        null,
      );

      await expect(service.materializeFromImport('missing-import')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when import status is VALIDATION_FAILED', async () => {
      setupBasicMocks({ importStatus: 'VALIDATION_FAILED' });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when import status is SUPERSEDED', async () => {
      setupBasicMocks({ importStatus: 'SUPERSEDED' });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when import is not current', async () => {
      setupBasicMocks({ isCurrent: false });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when intake status is not REVIEW_IMPORTED', async () => {
      setupBasicMocks();
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'DRAFT' }));

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when reportJson.schemaVersion is not 1.0', async () => {
      setupBasicMocks({
        reportJson: { ...makeValidReportJson(), schemaVersion: '2.0' },
      });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when reportJson.intakeId does not match', async () => {
      setupBasicMocks({
        reportJson: { ...makeValidReportJson(), intakeId: 'other-intake' },
      });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    // WP-6.3 (R9-02): сбой диагностируется одинаково в обоих каналах.
    describe('failure handling', () => {
      const failWith = (error: unknown) => {
        setupBasicMocks();
        prisma.$transaction.mockRejectedValue(error);
      };

      const prismaShapeError = () =>
        new Prisma.PrismaClientValidationError('Argument reasonRu is missing', {
          clientVersion: 'test',
        });

      it('turns a report-shaped Prisma failure into 422 instead of a bare 500', async () => {
        failWith(prismaShapeError());

        await expect(service.materializeFromImport('import-1')).rejects.toThrow(
          UnprocessableEntityException,
        );
      });

      /**
       * ⚠️ `LEGACY-197`. Утверждение сохранено как было: фикстура здесь —
       * `PrismaClientValidationError` с текстом `'Argument reasonRu is missing'`,
       * и слово `reasonRu` в нём совпадает с именем **нашего** поля. То есть
       * проверка `toContain('reasonRu')` проходит и на фразе-константе, если
       * та упоминает поле, — она про наличие адреса записи, а не про утечку.
       * Собственно утечка посажена отдельным `it` ниже.
       */
      it('reports the import id and the underlying reason in the 422 body', async () => {
        failWith(prismaShapeError());

        const error = await service.materializeFromImport('import-1').catch((e: unknown) => e);
        const response = (error as UnprocessableEntityException).getResponse() as Record<
          string,
          unknown
        >;

        expect(response['code']).toBe('REPORT_NOT_MATERIALIZABLE');
        expect(response['importId']).toBe('import-1');
      });

      /**
       * `LEGACY-197`, место 5. Отказ **драйвера** — единственный вид отказа,
       * чей текст сюда не идёт: в сообщении Prisma лежат имена моделей
       * и колонок. Различие только по типу исключения: наш `ReportShapeError`
       * несёт адрес битой записи и остаётся как был (см. `044:` ниже).
       */
      it('не отдаёт текст драйвера Prisma в теле 422', async () => {
        failWith(prismaShapeError());
        const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        const error = await service.materializeFromImport('import-1').catch((e: unknown) => e);
        const response = (error as UnprocessableEntityException).getResponse() as Record<
          string,
          unknown
        >;

        expect(response['reason']).toBe(MATERIALIZATION_FAILED_REASON_RU);
        // Проверка по телу целиком, а не по одному полю: иначе текст просто
        // переедет в соседнее и проверка этого не заметит.
        expect(JSON.stringify(response)).not.toContain('Argument reasonRu is missing');

        expect(logged.mock.calls.some((c) => String(c[0]).includes('Argument reasonRu'))).toBe(
          true,
        );
        logged.mockRestore();
      });

      /**
       * `LEGACY-197`, четвёртое место. `messageRu` уведомления лежит **в базе**
       * и показывается редактору в каждой выдаче; текст исключения там
       * переживал перезапуск. Раньше содержимое поля не проверялось вовсе —
       * тест смотрел только на тип и привязки уведомления.
       */
      it('не кладёт текст исключения в messageRu уведомления', async () => {
        failWith(prismaShapeError());

        await service.materializeFromImport('import-1').catch(() => undefined);

        const written = JSON.stringify(notifications.create.mock.calls);
        expect(written).not.toContain('Argument reasonRu');
        // Счётчик обязателен (L-005): второе уведомление в том же пути спека
        // иначе не различит, и текст мог бы уехать именно в него.
        expect(notifications.create).toHaveBeenCalledTimes(1);
        expect(notifications.create).toHaveBeenCalledWith(
          expect.objectContaining({
            messageRu: materializationFailedMessageRu('Test Book'),
          }),
        );
      });

      it('records a notification for the manual channel', async () => {
        failWith(prismaShapeError());

        await service.materializeFromImport('import-1').catch(() => undefined);

        expect(notifications.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'AGENT_REPORT_MATERIALIZATION_FAILED',
            rightsIntakeId: 'intake-1',
            rightsReviewImportId: 'import-1',
            agentSubmissionId: null,
          }),
        );
      });

      it('attributes the notification to the agent submission when there is one', async () => {
        failWith(prismaShapeError());

        await service
          .materializeFromImport('import-1', { agentSubmissionId: 'submission-1' })
          .catch(() => undefined);

        expect(notifications.create).toHaveBeenCalledWith(
          expect.objectContaining({ agentSubmissionId: 'submission-1' }),
        );
      });

      it('keeps an infrastructure failure a 500 and does not disguise it as a bad report', async () => {
        const infrastructureError = new Error('connection terminated');
        failWith(infrastructureError);

        await expect(service.materializeFromImport('import-1')).rejects.toBe(infrastructureError);
        expect(notifications.create).toHaveBeenCalled();
      });

      /**
       * `LEGACY-343`: `P2024` — таймаут получения соединения из пула, отказ
       * инфраструктуры, а не формы отчёта. Прежняя проверка `instanceof
       * Prisma.PrismaClientKnownRequestError` без разбора кода превращала его
       * в 422 «нужен исправленный отчёт», и `SentryExceptionFilter` (репортит
       * только 5xx) не поднимал алерт.
       */
      it('P2024 (pool connection timeout) stays a bare 500, not a report-shape 422', async () => {
        const poolTimeout = new Prisma.PrismaClientKnownRequestError(
          'Timed out fetching a connection',
          {
            code: 'P2024',
            clientVersion: 'test',
          },
        );
        failWith(poolTimeout);

        await expect(service.materializeFromImport('import-1')).rejects.toBe(poolTimeout);
      });

      /**
       * `LEGACY-343`: неизвестный код драйвера трактуется как инфраструктура —
       * 500 виден в Sentry, 422 нет.
       */
      it('an unlisted Prisma driver code stays a bare 500', async () => {
        const unknownCode = new Prisma.PrismaClientKnownRequestError('Something else broke', {
          code: 'P1017',
          clientVersion: 'test',
        });
        failWith(unknownCode);

        await expect(service.materializeFromImport('import-1')).rejects.toBe(unknownCode);
      });

      /**
       * `LEGACY-343`: `P2002` (нарушение уникальности) остаётся формой отчёта —
       * границу проводить по коду, не снимая её у известных «формы отчёта».
       */
      it('P2002 (unique constraint) still turns into a report-shape 422', async () => {
        const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: 'test',
          },
        );
        failWith(uniqueViolation);

        await expect(service.materializeFromImport('import-1')).rejects.toThrow(
          UnprocessableEntityException,
        );
      });

      it('does not let a failing notification mask the original error', async () => {
        failWith(prismaShapeError());
        notifications.create.mockRejectedValue(new Error('notifications are down'));

        await expect(service.materializeFromImport('import-1')).rejects.toThrow(
          UnprocessableEntityException,
        );
      });
    });

    it('should create RightsProfile, RightsReview, SourceEdition, EditionRights', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      const result = await service.materializeFromImport('import-1');

      expect(prisma['rightsProfile'] as Record<string, jest.Mock>).toBeDefined();
      expect(
        (prisma['rightsProfile'] as Record<string, jest.Mock>).updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rightsIntakeId: 'intake-1', isCurrent: true },
        }),
      );
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsIntakeId: 'intake-1',
            currentReviewImportId: 'import-1',
            status: 'HUMAN_REVIEW_REQUIRED',
            isCurrent: true,
          }),
        }),
      );
      expect((prisma['rightsReview'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            rightsReviewImportId: 'import-1',
            status: 'HUMAN_REVIEW_REQUIRED',
          }),
        }),
      );
      // Phase 18: the first review of an intake roots its own chain.
      expect((prisma['rightsReview'] as Record<string, jest.Mock>).update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: {
          previousReviewId: null,
          chainRootReviewId: 'review-1',
          revisionNumber: 1,
        },
      });
      expect((prisma['sourceEdition'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            provider: 'PROJECT_GUTENBERG',
          }),
        }),
      );
      expect((prisma['editionRights'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceEditionId: expect.any(String),
          }),
        }),
      );
      expect(result).toEqual(profile);
    });

    /**
     * WP-7.3 (R4-03, R2-01, R3-01): блок `languageAssessments` приходит в отчёте, проверяется
     * валидатором на покрытие каждого целевого языка — и до WP-7 выбрасывался. `EditionRights`
     * при этом создавалась одна на исходное издание и дословно копировала его `status`/`notesRu`.
     */
    /**
     * WP-9.1 / WP-8.3. Проверка — акт, и она обязана нести «под каким заданием и чем
     * проверяли» сама: импорт может уйти в SUPERSEDED. Сумма файла источника входит в
     * content hash, поэтому мусор в ней хуже пустоты — «изменение» закрывало бы гейт.
     */
    describe('WP-9: снимок задания и сумма файла источника', () => {
      const materialize = async (
        importOverrides: Record<string, unknown> = {},
        reportOverrides: Record<string, unknown> = {},
      ) => {
        setupBasicMocks({
          ...importOverrides,
          ...(Object.keys(reportOverrides).length > 0
            ? { reportJson: { ...makeValidReportJson(), ...reportOverrides } }
            : {}),
        });
        setupTransaction();
        (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
          makeProfile(),
        );
        (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
        await service.materializeFromImport('import-1');
      };

      const reviewData = () =>
        (prisma['rightsReview'] as Record<string, jest.Mock>).create.mock.calls[0][0]
          .data as Record<string, unknown>;

      const sourceEditionData = () =>
        (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mock.calls[0][0]
          .data as Record<string, unknown>;

      it('копирует promptVersion и agentModel импорта на проверку', async () => {
        await materialize({ promptVersion: '1.1', agentModel: 'ChatGPT o3' });

        expect(reviewData().promptVersion).toBe('1.1');
        expect(reviewData().agentModel).toBe('ChatGPT o3');
      });

      it('обходится без них, если импорт их не нёс', async () => {
        await materialize();

        expect(reviewData().promptVersion).toBeNull();
        expect(reviewData().agentModel).toBeNull();
      });

      it('переносит контрольную сумму файла источника из отчёта', async () => {
        const sourceAssessment = {
          ...(makeValidReportJson().sourceAssessment as Record<string, unknown>),
          sourceFileSha256: 'A'.repeat(64),
        };

        await materialize({}, { sourceAssessment });

        // Приводится к нижнему регистру: хеш клиренса не должен зависеть от регистра ввода.
        expect(sourceEditionData().sourceFileSha256).toBe('a'.repeat(64));
      });

      it('отбрасывает значение, не похожее на sha256', async () => {
        const sourceAssessment = {
          ...(makeValidReportJson().sourceAssessment as Record<string, unknown>),
          sourceFileSha256: 'not-a-hash',
        };

        await materialize({}, { sourceAssessment });

        expect(sourceEditionData().sourceFileSha256).toBeNull();
      });

      it('оставляет null, когда агент сумму не прислал', async () => {
        await materialize();

        expect(sourceEditionData().sourceFileSha256).toBeNull();
      });
    });

    describe('language assessments', () => {
      const editionRightsCalls = () =>
        (prisma['editionRights'] as Record<string, jest.Mock>).create.mock.calls.map(
          (call) => (call[0] as { data: Record<string, unknown> }).data,
        );

      const materializeWith = async (reportOverrides: Record<string, unknown> = {}) => {
        setupBasicMocks(
          Object.keys(reportOverrides).length > 0
            ? { reportJson: { ...makeValidReportJson(), ...reportOverrides } }
            : {},
        );
        setupTransaction();
        (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
          makeProfile(),
        );
        (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
        await service.materializeFromImport('import-1');
      };

      it('creates one EditionRights record per assessed language', async () => {
        await materializeWith();

        const calls = editionRightsCalls();
        expect(calls).toHaveLength(2);
        expect(calls.map((data) => data['languageCode'])).toEqual(['en', 'ru']);
        expect(calls.every((data) => data['sourceEditionId'] === 'source-edition-1')).toBe(true);
      });

      it('keeps the legal verdict of the language, not a copy of the source edition', async () => {
        await materializeWith();

        const [en, ru] = editionRightsCalls();
        expect(en).toEqual(
          expect.objectContaining({
            languageCode: 'en',
            status: 'ALLOWED',
            translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
            translationSourceLanguage: null,
            requiresGeoBlock: false,
            notesRu: 'Оригинальный текст',
          }),
        );
        expect(ru).toEqual(
          expect.objectContaining({
            languageCode: 'ru',
            status: 'LICENSE_REQUIRED',
            translationOrigin: 'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION',
            translationSourceLanguage: 'fr',
            requiresGeoBlock: true,
          }),
        );
      });

      it('normalizes the language code and defaults an unstated translation origin', async () => {
        await materializeWith({
          languageAssessments: [{ languageCode: 'RU', status: 'ALLOWED' }],
        });

        expect(editionRightsCalls()).toEqual([
          expect.objectContaining({
            languageCode: 'ru',
            status: 'ALLOWED',
            translationOrigin: 'UNKNOWN',
            translationSourceLanguage: null,
            requiresGeoBlock: false,
          }),
        ]);
      });

      /**
       * Fail-closed: строка прав без языка — это и есть дефект R3-01. Пустого «на всякий случай»
       * дубликата источника быть не должно: отсутствие записи честно означает «язык не оценён».
       */
      it('creates no EditionRights at all when the report carries no language block', async () => {
        await materializeWith({ languageAssessments: [] });

        expect(
          (prisma['editionRights'] as Record<string, jest.Mock>).create,
        ).not.toHaveBeenCalled();
      });

      it('stores the language of a component when the report states one', async () => {
        await materializeWith({
          componentAssessments: [
            {
              componentType: 'TRANSLATION',
              titleRu: 'Русский перевод',
              status: 'COPYRIGHTED',
              requiredAction: 'RETRANSLATE',
              confidence: 'HIGH',
              languageCode: 'ru',
            },
          ],
        });

        expect(
          (prisma['rightsComponent'] as Record<string, jest.Mock>).create,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ componentType: 'TRANSLATION', languageCode: 'ru' }),
          }),
        );
      });

      it('leaves the component language empty when the report does not state one', async () => {
        await materializeWith();

        expect(
          (prisma['rightsComponent'] as Record<string, jest.Mock>).create,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ componentType: 'ORIGINAL_TEXT', languageCode: null }),
          }),
        );
      });
    });

    it('should update intake workflowStatus to HUMAN_REVIEW_REQUIRED and clear approvedReviewId', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsIntake'] as Record<string, jest.Mock>).update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'intake-1' },
          data: {
            workflowStatus: 'HUMAN_REVIEW_REQUIRED',
            approvedReviewId: null,
          },
        }),
      );
    });

    it('should create TerritoryDecision records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledTimes(2);
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            countryCode: 'US',
            finalStatus: 'ALLOWED',
          }),
        }),
      );
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            countryCode: 'FR',
            finalStatus: 'ALLOWED',
          }),
        }),
      );
    });

    it('should create RightsComponent records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsComponent'] as Record<string, jest.Mock>).create).toHaveBeenCalledTimes(
        1,
      );
      expect((prisma['rightsComponent'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            componentType: 'ORIGINAL_TEXT',
            status: 'PUBLIC_DOMAIN',
          }),
        }),
      );
    });

    it('should create RightsEvidence records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsEvidence'] as Record<string, jest.Mock>).create).toHaveBeenCalledTimes(
        1,
      );
      expect((prisma['rightsEvidence'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            evidenceType: 'GUTENBERG_PAGE',
            title: 'Project Gutenberg page',
          }),
        }),
      );
    });

    it('should create RightsAction records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledTimes(1);
      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            actionType: 'REMOVE_COMPONENT',
            status: 'PENDING',
          }),
        }),
      );
    });

    // WP-5.3: the agent proposes an action, a human closes it. A report that arrives with
    // `suggestedStatus: WAIVED` used to create the action already closed, so the agent lifted its
    // own blocker before anyone saw it (R3-03).
    it('should ignore a closed suggestedStatus from the agent report', async () => {
      const reportJson = makeValidReportJson();
      reportJson.requiredActions = [
        {
          actionType: 'OBTAIN_LICENSE',
          descriptionRu: 'Купить лицензию',
          affectedCountryCodes: ['US'],
          isBlocking: true,
          suggestedStatus: 'WAIVED',
        },
      ];
      setupBasicMocks({ reportJson });
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actionType: 'OBTAIN_LICENSE',
            isBlocking: true,
            status: 'PENDING',
          }),
        }),
      );
    });

    it('should keep IN_PROGRESS as a suggested status', async () => {
      const reportJson = makeValidReportJson();
      reportJson.requiredActions = [
        {
          actionType: 'OBTAIN_LICENSE',
          descriptionRu: 'Купить лицензию',
          affectedCountryCodes: ['US'],
          isBlocking: true,
          suggestedStatus: 'IN_PROGRESS',
        },
      ];
      setupBasicMocks({ reportJson });
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'IN_PROGRESS' }),
        }),
      );
    });

    it('should supersede previous current profile on new materialization', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { id: 'old-profile-1' },
      ]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect(
        (prisma['rightsProfile'] as Record<string, jest.Mock>).updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rightsIntakeId: 'intake-1', isCurrent: true },
          data: expect.objectContaining({
            isCurrent: false,
            status: 'SUPERSEDED',
          }),
        }),
      );
      expect((prisma['rightsReview'] as Record<string, jest.Mock>).updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rightsProfileId: { in: ['old-profile-1'] } },
          data: { status: 'SUPERSEDED' },
        }),
      );
    });

    it('should be idempotent for same importId (return existing profile)', async () => {
      setupBasicMocks();
      const existingProfile = { id: 'existing-profile-1', rightsIntakeId: 'intake-1' };
      (prisma['rightsReview'] as Record<string, jest.Mock>).findFirst.mockResolvedValue({
        rightsProfile: existingProfile,
      });

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(existingProfile);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
    });

    it('should handle empty optional arrays (no components, evidence, actions)', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [];
      reportJson.evidence = [];
      reportJson.requiredActions = [];
      setupBasicMocks({ reportJson });
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(profile);
      expect(
        (prisma['rightsComponent'] as Record<string, jest.Mock>).create,
      ).not.toHaveBeenCalled();
      expect((prisma['rightsEvidence'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledTimes(2);
    });

    // WP-B: подробный отчёт перестаёт быть хуже пустого. Компонент, которого в издании нет,
    // не роняет целевые страны в PENDING_REVIEW; компонент, помеченный к удалению, — роняет,
    // пока удаление не подтверждено (R6-06).
    describe('WP-B: components without territory assessments', () => {
      const setupTwoComponents = (
        componentAssessments: unknown[],
        requiredActions: unknown[] = [],
      ) => {
        const reportJson = makeValidReportJson();
        reportJson.componentAssessments = componentAssessments;
        reportJson.requiredActions = requiredActions;
        reportJson.territoryDecisions = [];
        setupBasicMocks({ reportJson });
        prisma.rightsIntake.findUnique.mockResolvedValue(
          makeIntake({ targetCountryCodes: ['US', 'FR'] }),
        );
        setupTransaction();
        (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
          makeProfile(),
        );
        (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
        let index = 0;
        (prisma['rightsComponent'] as Record<string, jest.Mock>).create.mockImplementation(() => {
          index += 1;
          return Promise.resolve({ id: `component-${index}` });
        });
      };

      const publicDomainText = () => ({
        componentType: 'ORIGINAL_TEXT',
        titleRu: 'Оригинальный текст',
        status: 'PUBLIC_DOMAIN',
        requiredAction: 'KEEP',
        confidence: 'HIGH',
        territoryAssessments: [
          {
            countryCode: 'US',
            status: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            confidence: 'HIGH',
          },
          {
            countryCode: 'FR',
            status: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            confidence: 'HIGH',
          },
        ],
      });

      it('B.1/B.4: a speculative cover without country assessments does not pend the target markets', async () => {
        setupTwoComponents([
          publicDomainText(),
          {
            componentType: 'COVER',
            titleRu: 'Обложка',
            status: 'UNCERTAIN',
            requiredAction: 'VERIFY',
            confidence: 'LOW',
            territoryAssessments: [],
          },
        ]);
        const aggregate = jest.spyOn(
          aggregationService,
          'aggregateTerritoryDecisionsFromComponents',
        );

        await service.materializeFromImport('import-1');

        expect(aggregate).toHaveBeenCalledWith(
          expect.objectContaining({ componentRemovalsConfirmed: true }),
        );
        const created = (prisma['territoryDecision'] as Record<string, jest.Mock>).create.mock
          .calls;
        expect(created).toHaveLength(2);
        for (const call of created) {
          expect(call[0].data.finalStatus).toBe('ALLOWED');
          expect(call[0].data.accessPolicy).toBe('ALLOW');
        }
      });

      it('B.4: a component marked for removal still counts while its action is open', async () => {
        setupTwoComponents(
          [
            publicDomainText(),
            {
              componentType: 'OTHER',
              titleRu: 'Обвязка Gutenberg',
              status: 'EXCLUDED',
              requiredAction: 'REMOVE',
              confidence: 'HIGH',
              territoryAssessments: [
                {
                  countryCode: 'US',
                  status: 'BLOCKED',
                  accessPolicy: 'BLOCK',
                  geoBlockRequired: true,
                  reasonRu: 'Лицензия Gutenberg.',
                  confidence: 'HIGH',
                },
              ],
            },
          ],
          [
            {
              actionType: 'REMOVE_GUTENBERG_HEADER',
              descriptionRu: 'Убрать шапку Gutenberg',
              isBlocking: false,
            },
          ],
        );
        const aggregate = jest.spyOn(
          aggregationService,
          'aggregateTerritoryDecisionsFromComponents',
        );

        await service.materializeFromImport('import-1');

        expect(aggregate).toHaveBeenCalledWith(
          expect.objectContaining({ componentRemovalsConfirmed: false }),
        );
        const usDecision = (
          prisma['territoryDecision'] as Record<string, jest.Mock>
        ).create.mock.calls.find(
          (call: Array<{ data: { countryCode: string } }>) => call[0]?.data?.countryCode === 'US',
        )?.[0]?.data;
        expect(usDecision.finalStatus).toBe('BLOCKED');
        expect(usDecision.accessPolicy).toBe('BLOCK');
      });
    });

    it('should handle null/empty optional dates gracefully', async () => {
      const reportJson = makeValidReportJson();
      reportJson.nextReviewAt = null;
      const profile = makeProfile({ nextReviewAt: null });
      setupBasicMocks({ reportJson });
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(profile);
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextReviewAt: null,
          }),
        }),
      );
    });

    it('should handle missing sourceAssessment gracefully', async () => {
      const reportJson = makeValidReportJson();
      delete reportJson.sourceAssessment;
      setupBasicMocks({ reportJson });
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(profile);
      expect((prisma['sourceEdition'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect((prisma['editionRights'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
    });

    it('should create component territory assessments and aggregate a conservative decision', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Перевод',
          status: 'COPYRIGHTED',
          requiredAction: 'OBTAIN_LICENSE',
          confidence: 'HIGH',
          territoryAssessments: [
            {
              countryCode: 'gb',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
              reasonRu: 'Перевод защищён.',
              legalBasisRu: 'Translation copyright term.',
              rightsExpireAt: '2031-01-01T00:00:00.000Z',
              publicDomainFromYear: 2032,
              sourceEvidenceIds: ['evidence-gb'],
              confidence: 'MEDIUM',
              notesRu: 'Проверить автора перевода.',
            },
          ],
        },
      ];
      reportJson.territoryDecisions = [
        {
          countryCode: 'GB',
          finalStatus: 'ALLOWED',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          reasonRu: 'Top-level allow.',
          confidence: 'HIGH',
        },
      ];
      setupBasicMocks({ reportJson });
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ targetCountryCodes: ['GB'] }));
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      await service.materializeFromImport('import-1');

      expect(
        (prisma['componentTerritoryAssessment'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsComponentId: 'component-1',
          countryCode: 'GB',
          confidence: 'MEDIUM',
          sourceEvidenceIds: ['evidence-gb'],
          rightsExpireAt: new Date('2031-01-01T00:00:00.000Z'),
        }),
      });
      // WP-3.2: one blocking component closes the country as a whole, so the scope is the edition
      // and not the component's own medium — otherwise the audio of a forbidden text stays open.
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          countryCode: 'GB',
          finalStatus: 'BLOCKED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: true,
          geoBlockScope: 'LANGUAGE_EDITION',
        }),
      });

      // Verify GeoBlockRule generation pipeline from the materialized TerritoryDecision
      const materializedDecision = (
        prisma['territoryDecision'] as Record<string, jest.Mock>
      ).create.mock.calls.find(
        (call: Array<{ data: { countryCode: string } }>) => call[0]?.data?.countryCode === 'GB',
      )?.[0]?.data;

      expect(materializedDecision).toBeDefined();
      expect(materializedDecision.geoBlockRequired).toBe(true);
      expect(materializedDecision.geoBlockScope).toBe('LANGUAGE_EDITION');

      // Test GeoBlockRule projection from decision
      const geoBlockRuleService = new GeoBlockRuleService(
        prisma as unknown as PrismaService,
        {
          checkClaimAccess: jest.fn().mockResolvedValue({
            blocked: false,
            countryCode: null,
            scope: 'TEXT_READER',
            matchedBlockId: null,
            reasonCode: null,
            messageRu: null,
          }),
        } as unknown as RightsClaimEnforcementService,
        { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
        new RightsClearanceResolverService(prisma as unknown as PrismaService),
      );
      (prisma['bookVersion'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        id: 'v1',
        bookId: 'b1',
        rightsProfileId: 'profile-1',
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: false,
        // Read by the clearance resolver behind `generateRulesForVersion`.
        book: {
          id: 'b1',
          rightsIntakeId: null,
          currentRightsProfileId: 'profile-1',
          approvedRightsReviewId: null,
        },
      });
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany = jest
        .fn()
        .mockResolvedValue([
          {
            id: 'td-gb',
            rightsProfileId: 'profile-1',
            countryCode: 'GB',
            finalStatus: 'BLOCKED',
            accessPolicy: 'BLOCK',
            geoBlockRequired: true,
            geoBlockScope: 'LANGUAGE_EDITION',
            reasonRu: 'Translation copyright active in GB',
            legalBasisRu: 'UK Copyright Law',
          },
        ]);
      (prisma['geoBlockRule'] as Record<string, jest.Mock>).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 0 });
      (prisma['geoBlockRule'] as Record<string, jest.Mock>).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'rule-gb' });
      (prisma['geoBlockRule'] as Record<string, jest.Mock>).findMany = jest.fn().mockResolvedValue([
        {
          id: 'rule-gb',
          bookId: 'b1',
          bookVersionId: 'v1',
          rightsProfileId: 'profile-1',
          territoryDecisionId: 'td-gb',
          scope: 'LANGUAGE_EDITION',
          countryCode: 'GB',
          accessPolicy: 'BLOCK',
          sourceFinalStatus: 'BLOCKED',
          isActive: true,
          reasonRu: 'Translation copyright active in GB',
          legalBasisRu: 'UK Copyright Law',
          generatedFrom: 'TERRITORY_DECISION',
          generatedAt: new Date(),
          verifiedAt: null,
          verifiedByUserId: null,
          verificationNotesRu: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      (prisma['bookVersion'] as Record<string, jest.Mock>).update = jest.fn().mockResolvedValue({});

      const rulesResult = await geoBlockRuleService.generateRulesForVersion('v1');
      expect(rulesResult.summary.blockedCountries).toContain('GB');
      expect(rulesResult.summary.scopes).toContain('LANGUAGE_EDITION');
      expect(rulesResult.rules[0].countryCode).toBe('GB');
      expect(rulesResult.rules[0].scope).toBe('LANGUAGE_EDITION');
    });

    it('should inherit component confidence for a territory assessment', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [
        {
          componentType: 'ORIGINAL_TEXT',
          titleRu: 'Оригинальный текст',
          status: 'PUBLIC_DOMAIN',
          requiredAction: 'KEEP',
          confidence: 'LOW',
          territoryAssessments: [
            {
              countryCode: 'US',
              status: 'ALLOWED',
              accessPolicy: 'ALLOW',
              geoBlockRequired: false,
            },
          ],
        },
      ];
      setupBasicMocks({ reportJson });
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ targetCountryCodes: ['US'] }));
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      await service.materializeFromImport('import-1');

      expect(
        (prisma['componentTerritoryAssessment'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          countryCode: 'US',
          confidence: 'LOW',
        }),
      });
    });

    it('should set suggestedStatus to PENDING when invalid', async () => {
      const reportJson = makeValidReportJson();
      reportJson.requiredActions = [
        {
          actionType: 'REMOVE_COMPONENT',
          descriptionRu: 'Remove preface',
          affectedCountryCodes: ['US'],
          isBlocking: false,
          suggestedStatus: 'INVALID_STATUS',
        },
      ];
      setupBasicMocks({ reportJson });
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actionType: 'REMOVE_COMPONENT',
            status: 'PENDING',
          }),
        }),
      );
    });
  });

  describe('materializeFromImport — contributors', () => {
    const rpc = () => prisma['rightsProfileContributor'] as Record<string, jest.Mock>;

    const createdContributorData = () =>
      rpc().create.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);

    const setupContributorScenario = (reportJson: Record<string, unknown>) => {
      setupBasicMocks({ reportJson });
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      let componentIndex = 0;
      (prisma['rightsComponent'] as Record<string, jest.Mock>).create.mockImplementation(() =>
        Promise.resolve({ id: `component-${++componentIndex}` }),
      );

      let contributorIndex = 0;
      rpc().create.mockImplementation(() => Promise.resolve({ id: `rpc-${++contributorIndex}` }));

      personResolver.resolveOrCreatePerson.mockImplementation(
        (input: { canonicalName?: string; displayName: string }) =>
          Promise.resolve({ id: `person-${input.canonicalName ?? input.displayName}` }),
      );
    };

    it('should materialize sourceAssessment.contributors as profile-level contributors', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [
        {
          displayName: 'Mark Twain',
          role: 'AUTHOR',
          birthYear: 1835,
          deathYear: 1910,
          viafId: '50566653',
          notesRu: 'Автор оригинала.',
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
      expect(createdContributorData()[0]).toEqual(
        expect.objectContaining({
          rightsProfileId: 'profile-1',
          rightsComponentId: null,
          personId: 'person-Mark Twain',
          role: 'AUTHOR',
          displayName: 'Mark Twain',
          birthYear: 1835,
          deathYear: 1910,
          viafId: '50566653',
          notesRu: 'Автор оригинала.',
        }),
      );
    });

    it('should materialize inline component contributors bound to the created component', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributors: [{ displayName: 'Juan Pérez', role: 'TRANSLATOR' }],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(createdContributorData()).toEqual([
        expect.objectContaining({
          rightsComponentId: 'component-1',
          personId: 'person-Juan Pérez',
          role: 'TRANSLATOR',
          displayName: 'Juan Pérez',
        }),
      ]);
    });

    it('should map legacy contributor fields and unknown roles', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [
        {
          displayName: 'Anna Karlsson',
          originalName: 'Karlsson, Anna',
          nationalityCountry: 'SE',
          pseudonym: 'A. K.',
          identityConfidence: 'PROBABLE',
          role: 'PROOFREADER',
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(createdContributorData()[0]).toEqual(
        expect.objectContaining({
          displayName: 'Anna Karlsson',
          canonicalName: 'Karlsson, Anna',
          nationalityCountryCode: 'SE',
          creditedName: 'A. K.',
          confidence: 'MEDIUM',
          role: 'OTHER',
          roleOtherRu: 'PROOFREADER',
        }),
      );
    });

    it('should attach a top-level contributor to a component via contributorRefs without duplicating it', async () => {
      const reportJson = makeValidReportJson();
      reportJson.contributors = [
        { key: 'translator:juan', role: 'TRANSLATOR', displayName: 'Juan Pérez' },
      ];
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [
            { contributorKey: 'translator:juan', role: 'TRANSLATOR', creditedName: 'J. Pérez' },
          ],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
      expect(rpc().update).toHaveBeenCalledWith({
        where: { id: 'rpc-1' },
        data: {
          rightsComponentId: 'component-1',
          creditedName: 'J. Pérez',
          notesRu: null,
        },
      });
    });

    it('should create an extra contributor row when the same contributor is referenced by two components', async () => {
      const reportJson = makeValidReportJson();
      reportJson.contributors = [
        { key: 'translator:juan', role: 'TRANSLATOR', displayName: 'Juan Pérez' },
      ];
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [{ contributorKey: 'translator:juan' }],
        },
        {
          componentType: 'ANNOTATIONS',
          titleRu: 'Комментарии переводчика',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [{ contributorKey: 'translator:juan' }],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().update).toHaveBeenCalledTimes(1);
      expect(rpc().create).toHaveBeenCalledTimes(2);
      expect(createdContributorData()[1]).toEqual(
        expect.objectContaining({
          rightsComponentId: 'component-2',
          role: 'TRANSLATOR',
          displayName: 'Juan Pérez',
        }),
      );
    });

    it('should not duplicate a contributor that is both referenced and inlined on the same component', async () => {
      const reportJson = makeValidReportJson();
      reportJson.contributors = [
        { key: 'translator:juan', role: 'TRANSLATOR', displayName: 'Juan Pérez' },
      ];
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [{ contributorKey: 'translator:juan' }],
          contributors: [{ displayName: 'Juan Pérez', role: 'TRANSLATOR' }],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
    });

    it('should create a fallback AUTHOR contributor from the intake candidate author', async () => {
      setupContributorScenario(makeValidReportJson());
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ candidateAuthor: 'Mark Twain' }),
      );

      await service.materializeFromImport('import-1');

      expect(createdContributorData()).toEqual([
        expect.objectContaining({
          rightsProfileId: 'profile-1',
          rightsComponentId: null,
          role: 'AUTHOR',
          displayName: 'Mark Twain',
          canonicalName: 'Mark Twain',
        }),
      ]);
    });

    it('should not create the fallback contributor when the report already provides contributors', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [{ displayName: 'Juan Pérez', role: 'TRANSLATOR' }];
      setupContributorScenario(reportJson);
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ candidateAuthor: 'Mark Twain' }),
      );

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
      expect(createdContributorData()[0]).toEqual(
        expect.objectContaining({ displayName: 'Juan Pérez', role: 'TRANSLATOR' }),
      );
    });

    it('should not touch contributors when the report has none and the intake has no candidate author', async () => {
      setupContributorScenario(makeValidReportJson());

      await service.materializeFromImport('import-1');

      expect(rpc().create).not.toHaveBeenCalled();
      expect(rpc().update).not.toHaveBeenCalled();
    });

    /**
     * `LEGACY-347`: персона обязана писаться клиентом чужой транзакции
     * (`tx`), а не вторым соединением `this.prisma` — иначе на занятом пуле
     * (`LEGACY-256`) второе соединение отклоняется по таймауту.
     */
    it('resolves the contributor person through the materialization tx, not a second connection', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [{ displayName: 'Mark Twain', role: 'AUTHOR' }];
      setupContributorScenario(reportJson);
      // `setupTransaction()` заводит `tx` тем же объектом, что и `prisma` — а
      // значит проверка `toHaveBeenCalledWith(..., prisma)` не отличила бы `tx`
      // от `this.prisma`, попади в код такая подмена (ревью нашло это как
      // слабость посадки). `txClient` — отдельный объект, делегирующий все
      // модели `prisma` через прототип: функционально то же самое, но другой
      // по идентичности, поэтому подмену `tx` → `this.prisma` тест ловит.
      const txClient = Object.create(prisma) as typeof prisma;
      prisma.$transaction.mockImplementationOnce((fn: (tx: Record<string, unknown>) => unknown) =>
        fn(txClient as unknown as Record<string, unknown>),
      );

      await service.materializeFromImport('import-1');

      expect(personResolver.resolveOrCreatePerson).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Mark Twain' }),
        txClient,
      );
      expect(personResolver.resolveOrCreatePerson).not.toHaveBeenCalledWith(
        expect.anything(),
        prisma,
      );
    });

    /**
     * `LEGACY-347`: отказ драйвера при разрешении персоны обязан всплыть
     * наружу, а не превратиться в `personId: null` — иначе связь участника
     * пишется без персоны и ручка отвечает успехом на сломанном профиле.
     */
    it('propagates a driver failure from person resolution instead of writing a null personId', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [{ displayName: 'Mark Twain', role: 'AUTHOR' }];
      setupBasicMocks({ reportJson });
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      const driverError = new Prisma.PrismaClientKnownRequestError(
        'Timed out fetching a connection',
        {
          code: 'P2024',
          clientVersion: 'test',
        },
      );
      personResolver.resolveOrCreatePerson.mockRejectedValue(driverError);

      await expect(service.materializeFromImport('import-1')).rejects.toBe(driverError);
      expect(rpc().create).not.toHaveBeenCalled();
    });

    /**
     * `LEGACY-347`: имени в отчёте нет — это форма отчёта
     * (`PersonIdentityMissingError`), не отказ базы. Единственный случай,
     * где `personId` остаётся `null`.
     */
    it('writes the contributor without a personId only when the report has no usable name', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [{ displayName: 'Mark Twain', role: 'AUTHOR' }];
      setupContributorScenario(reportJson);
      personResolver.resolveOrCreatePerson.mockRejectedValue(
        new PersonIdentityMissingError('Canonical or display name is required'),
      );

      await service.materializeFromImport('import-1');

      expect(createdContributorData()[0]).toEqual(expect.objectContaining({ personId: null }));
    });
  });

  // Phase 15: licenses[] materialization
  describe('licenses', () => {
    const rl = () => prisma['rightsLicense'] as Record<string, jest.Mock>;
    const rll = () => prisma['rightsLicenseLink'] as Record<string, jest.Mock>;
    const rle = () => prisma['rightsLicenseEvent'] as Record<string, jest.Mock>;

    const linkCalls = () =>
      rll().create.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);

    const withLicenses = (): Record<string, unknown> => {
      const reportJson = makeValidReportJson();
      reportJson['licenses'] = [
        {
          key: 'license:penguin-2019',
          title: 'Лицензия на перевод',
          licensor: 'Penguin Random House',
          status: 'ACTIVE',
          territoryScope: 'COUNTRY_LIST',
          countryCodes: ['FR'],
          languageCodes: ['fr'],
          documentSha256: 'a'.repeat(64),
        },
      ];
      return reportJson;
    };

    const setupLicenseScenario = (reportJson: Record<string, unknown>) => {
      setupTransaction();
      setupBasicMocks({ reportJson });
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsReview'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'review-1',
      });
      (
        prisma['componentTerritoryAssessment'] as Record<string, jest.Mock>
      ).create.mockResolvedValue({ id: 'assessment-1' });
      (prisma['territoryDecision'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'decision-1',
      });
      (prisma['rightsEvidence'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'evidence-1',
      });
      rl().create.mockResolvedValue({ id: 'lic-1' });
    };

    it('creates licenses from the report and links them to the profile', async () => {
      setupLicenseScenario(withLicenses());

      await service.materializeFromImport('import-1');

      expect(rl().create).toHaveBeenCalledTimes(1);
      expect(rle().create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'IMPORTED_FROM_REVIEW' }),
        }),
      );
      expect(linkCalls()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ linkType: 'RIGHTS_PROFILE', rightsProfileId: 'profile-1' }),
        ]),
      );
    });

    it('reuses an existing license with the same licenseKey instead of creating a duplicate', async () => {
      setupLicenseScenario(withLicenses());
      rl().findFirst.mockResolvedValue({ id: 'lic-existing', title: 'Существующая' });

      await service.materializeFromImport('import-1');

      expect(rl().create).not.toHaveBeenCalled();
      expect(linkCalls()[0]).toEqual(expect.objectContaining({ rightsLicenseId: 'lic-existing' }));
    });

    it('links component licenseRefs to the created component', async () => {
      const reportJson = withLicenses();
      (reportJson['componentAssessments'] as Array<Record<string, unknown>>)[0]['licenseRefs'] = [
        'license:penguin-2019',
      ];
      setupLicenseScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(linkCalls()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            linkType: 'RIGHTS_COMPONENT',
            rightsComponentId: 'component-1',
          }),
        ]),
      );
    });

    it('links a territory assessment licenseRef with the covered country', async () => {
      const reportJson = withLicenses();
      (reportJson['componentAssessments'] as Array<Record<string, unknown>>)[0][
        'territoryAssessments'
      ] = [
        {
          countryCode: 'FR',
          status: 'ALLOWED_BY_LICENSE',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          licenseRef: 'license:penguin-2019',
        },
      ];
      setupLicenseScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(linkCalls()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            linkType: 'COMPONENT_TERRITORY_ASSESSMENT',
            componentTerritoryAssessmentId: 'assessment-1',
            coversCountryCodes: ['FR'],
          }),
        ]),
      );
    });

    it('creates no license rows for a legacy report without a licenses block', async () => {
      setupLicenseScenario(makeValidReportJson());

      await service.materializeFromImport('import-1');

      expect(rl().create).not.toHaveBeenCalled();
      expect(rll().create).not.toHaveBeenCalled();
    });
  });
  // WP-5.5: пересчёт вердиктов по странам после того, как человек закрыл действие на
  // удаление компонента. Без него ветка «удаление подтверждено» недостижима (R6-06).
  describe('recomputeTerritoryDecisionsFromComponents', () => {
    const blockingIllustration = {
      id: 'component-illustration',
      componentType: 'ILLUSTRATION',
      titleRu: 'Иллюстрации',
      status: 'COPYRIGHTED',
      requiredAction: 'REMOVE',
      confidence: 'HIGH',
      territoryAssessments: [
        {
          countryCode: 'GB',
          status: 'BLOCKED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: true,
          reasonRu: 'Иллюстрации под охраной.',
          legalBasisRu: null,
          confidence: 'HIGH',
          rightsExpireAt: null,
        },
      ],
    };

    const setupRecompute = (options: { actions: Array<Record<string, unknown>> }) => {
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany = jest
        .fn()
        .mockResolvedValue([blockingIllustration]);
      (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeImportRecord({ reportJson: { ...makeValidReportJson(), territoryDecisions: [] } }),
      );
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ targetCountryCodes: ['GB'] }));
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany = jest
        .fn()
        .mockResolvedValue(options.actions);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findUnique = jest
        .fn()
        .mockResolvedValue({
          id: 'decision-gb',
          finalStatus: 'BLOCKED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: true,
          geoBlockScope: 'LANGUAGE_EDITION',
          reasonRu: 'Блокирующие компоненты: «Иллюстрации».',
          legalBasisRu: null,
          confidence: 'HIGH',
          nextReviewAt: null,
        });
      (prisma['territoryDecision'] as Record<string, jest.Mock>).update = jest.fn();
    };

    /**
     * 🔴 Регрессия, найденная код-ревью пачки, а не самой записью `LEGACY-044`.
     *
     * Первая версия правки бросала `ReportShapeError` из
     * `mapExistingTerritoryDecisions` **всегда**. Но этот метод зовётся и отсюда,
     * из пересчёта, а пересчёт идёт из `RightsActionService` внутри чужой
     * транзакции, где ошибку никто не переводит в 422. Модератор, закрывающий
     * действие на удаление компонента у профиля со старыми битыми данными,
     * получал голую 500, и вместе с ней откатывались смена статуса и её событие
     * аудита — действие становилось незакрываемым навсегда.
     *
     * Тест краснеет от возврата режима `reject` на этом пути.
     */
    describe('битые коды страны в уже сохранённых данных (регрессия LEGACY-044)', () => {
      it('не роняет пересчёт из-за негодного countryCode в сохранённом отчёте', async () => {
        setupRecompute({
          actions: [{ actionType: 'REPLACE_ILLUSTRATIONS', status: 'COMPLETED' }],
        });
        (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
          makeImportRecord({
            reportJson: {
              ...makeValidReportJson(),
              // Такие профили уже существуют: до правки `null` молча становился ''.
              territoryDecisions: [
                {
                  ...(
                    makeValidReportJson()['territoryDecisions'] as Array<Record<string, unknown>>
                  )[0],
                  countryCode: null,
                },
              ],
            },
          }),
        );

        const result = await service.recomputeTerritoryDecisionsFromComponents(
          prisma as unknown as Record<string, unknown>,
          'profile-1',
        );

        // Пересчёт доходит до конца: действие модератора закрывается.
        expect(result).toEqual({ changedCountryCodes: ['GB'] });
      });

      it('не роняет пересчёт из-за пустого countryCode в строке БД', async () => {
        setupRecompute({
          actions: [{ actionType: 'REPLACE_ILLUSTRATIONS', status: 'COMPLETED' }],
        });
        (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany = jest
          .fn()
          .mockResolvedValue([
            {
              ...blockingIllustration,
              territoryAssessments: [
                // Строка БД, а не отчёт: переимпорт её не починит, поэтому и
                // сообщать оператору «исправьте отчёт» здесь нельзя.
                { ...blockingIllustration.territoryAssessments[0], countryCode: '' },
                blockingIllustration.territoryAssessments[0],
              ],
            },
          ]);

        const result = await service.recomputeTerritoryDecisionsFromComponents(
          prisma as unknown as Record<string, unknown>,
          'profile-1',
        );

        expect(result).toEqual({ changedCountryCodes: ['GB'] });
      });
    });

    it('opens the country once the removal action is closed', async () => {
      setupRecompute({
        actions: [{ actionType: 'REPLACE_ILLUSTRATIONS', status: 'COMPLETED' }],
      });

      const result = await service.recomputeTerritoryDecisionsFromComponents(
        prisma as unknown as Record<string, unknown>,
        'profile-1',
      );

      expect(result).toEqual({ changedCountryCodes: ['GB'] });
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).update,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'decision-gb' },
          data: expect.objectContaining({ finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' }),
        }),
      );
    });

    it('leaves the country closed while the removal action is open', async () => {
      setupRecompute({
        actions: [{ actionType: 'REPLACE_ILLUSTRATIONS', status: 'PENDING' }],
      });

      const result = await service.recomputeTerritoryDecisionsFromComponents(
        prisma as unknown as Record<string, unknown>,
        'profile-1',
      );

      expect(result).toEqual({ changedCountryCodes: [] });
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).update,
      ).not.toHaveBeenCalled();
    });

    it('does nothing when the profile is no longer current', async () => {
      setupRecompute({
        actions: [{ actionType: 'REPLACE_ILLUSTRATIONS', status: 'COMPLETED' }],
      });
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeProfile({ isCurrent: false }),
      );

      const result = await service.recomputeTerritoryDecisionsFromComponents(
        prisma as unknown as Record<string, unknown>,
        'profile-1',
      );

      expect(result).toBeNull();
    });

    it('does nothing when the source report is no longer available', async () => {
      setupRecompute({
        actions: [{ actionType: 'REPLACE_ILLUSTRATIONS', status: 'COMPLETED' }],
      });
      (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        null,
      );

      const result = await service.recomputeTerritoryDecisionsFromComponents(
        prisma as unknown as Record<string, unknown>,
        'profile-1',
      );

      expect(result).toBeNull();
    });
  });

  /**
   * WP-G: валидатор перестал требовать часть полей и стал принимать синонимы enum.
   * Каждому выведенному из `required` полю обязан быть дефолт здесь — иначе валидный отчёт
   * роняет запись в колонку `NOT NULL` и превращается в 500 уже после `VALIDATED` (R4-01).
   */
  describe('WP-G: дефолты и нормализация ослабленного отчёта', () => {
    const materializeJson = async (
      reportJson: Record<string, unknown>,
      intakeOverrides: Record<string, unknown> = {},
    ) => {
      (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeImportRecord({ reportJson }),
      );
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake(intakeOverrides));
      (prisma['rightsReview'] as Record<string, jest.Mock>).findFirst.mockResolvedValue(null);
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      await service.materializeFromImport('import-1');
    };

    const dataOf = (model: string): Array<Record<string, unknown>> =>
      (prisma[model] as Record<string, jest.Mock>).create.mock.calls.map(
        (call) => (call[0] as Record<string, unknown>)['data'] as Record<string, unknown>,
      );

    it('G.4: синоним finalStatus доезжает до записи нормализованным', async () => {
      const report = makeValidReportJson();
      (report['territoryDecisions'] as Array<Record<string, unknown>>)[0]['finalStatus'] =
        'PUBLIC_DOMAIN';

      await materializeJson(report);

      expect(dataOf('territoryDecision')[0]['finalStatus']).toBe('ALLOWED');
    });

    it('G.3: строчный код страны записывается в верхнем регистре', async () => {
      const report = makeValidReportJson();
      (report['territoryDecisions'] as Array<Record<string, unknown>>)[0]['countryCode'] = 'us';

      await materializeJson(report);

      expect(dataOf('territoryDecision')[0]['countryCode']).toBe('US');
    });

    it('G.2: разрешающее решение без reasonRu и confidence получает дефолты, а не null', async () => {
      const report = makeValidReportJson();
      report['territoryDecisions'] = [
        { countryCode: 'US', finalStatus: 'ALLOWED', accessPolicy: 'ALLOW' },
      ];

      await materializeJson(report);

      const created = dataOf('territoryDecision')[0];
      expect(typeof created['reasonRu']).toBe('string');
      expect((created['reasonRu'] as string).trim()).not.toBe('');
      expect(created['confidence']).toBe('HIGH');
    });

    /**
     * `LEGACY-044`. Дефолт допустим там, где значение по существу необязательно
     * (`reasonRu` — G.2 выше). Код страны — идентичность строки: пустая строка
     * вместо него создавала решение, которое не попадает ни в целевые страны, ни
     * в справочник регионов, но существует в профиле и считается в счётчиках.
     *
     * Ответ — 422 `REPORT_NOT_MATERIALIZABLE`, а не 500: такой отчёт не
     * разложится никогда, сколько ни повторяй запрос.
     */
    const expect422 = async (report: Record<string, unknown>) => {
      (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeImportRecord({ reportJson: report }),
      );
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());
      (prisma['rightsReview'] as Record<string, jest.Mock>).findFirst.mockResolvedValue(null);
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const error = await service.materializeFromImport('import-1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const response = (error as UnprocessableEntityException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response['code']).toBe('REPORT_NOT_MATERIALIZABLE');
      // Индекс в сообщении — не украшение: без него оператор с сорока
      // решениями в отчёте не найдёт виноватую запись.
      expect(String(response['reason'])).toContain('territoryDecisions[0]');
      expect(String(response['reason'])).toContain('countryCode');
      return response;
    };

    it('044: countryCode = null в решении — 422, а не решение с пустым кодом', async () => {
      const report = makeValidReportJson();
      (report['territoryDecisions'] as Array<Record<string, unknown>>)[0]['countryCode'] = null;

      await expect422(report);

      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).not.toHaveBeenCalled();
    });

    it('044: нестроковый countryCode в решении — 422, а не молчаливая пустая строка', async () => {
      const report = makeValidReportJson();
      (report['territoryDecisions'] as Array<Record<string, unknown>>)[0]['countryCode'] = 7;

      await expect422(report);
    });

    it('044: пустая строка в countryCode тоже отвергается', async () => {
      const report = makeValidReportJson();
      (report['territoryDecisions'] as Array<Record<string, unknown>>)[0]['countryCode'] = '  ';

      await expect422(report);
    });

    it('G.6: отчёт без requiredActions и evidence материализуется без этих записей', async () => {
      const report = makeValidReportJson();
      delete report['requiredActions'];
      delete report['evidence'];

      await materializeJson(report);

      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect((prisma['rightsEvidence'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect(dataOf('territoryDecision')).toHaveLength(2);
    });

    it('G.5: целевой язык без оценки материализуется как NOT_TARGETED', async () => {
      await materializeJson(makeValidReportJson(), { targetLanguages: ['en', 'ru', 'fr'] });

      const byLanguage = new Map(
        dataOf('editionRights').map((data) => [data['languageCode'], data]),
      );
      expect(byLanguage.get('fr')?.['status']).toBe('NOT_TARGETED');
      expect(byLanguage.get('fr')?.['requiresGeoBlock']).toBe(false);
    });

    // WP-G.2 × WP-B.3: дефолты не должны превращать голое решение агента в «обоснованное».
    // Проверка идёт по реальному конвейеру — от reportJson до записанного TerritoryDecision.
    describe('G.2 × B.3: дефолты не подменяют обоснование агента', () => {
      const unassessedTranslation = () => ({
        componentType: 'TRANSLATION',
        titleRu: 'Перевод',
        status: 'COPYRIGHTED',
        requiredAction: 'VERIFY',
        confidence: 'HIGH',
        territoryAssessments: [
          {
            countryCode: 'FR',
            status: 'ALLOWED',
            accessPolicy: 'ALLOW',
            geoBlockRequired: false,
            confidence: 'HIGH',
          },
        ],
      });

      const reportWithUsDecision = (usDecision: Record<string, unknown>) => {
        const report = makeValidReportJson();
        report['confidence'] = 'HIGH';
        report['componentAssessments'] = [unassessedTranslation()];
        report['requiredActions'] = [];
        report['territoryDecisions'] = [usDecision];
        return report;
      };

      const usDecisionData = () =>
        dataOf('territoryDecision').find((data) => data['countryCode'] === 'US');

      it('голое ALLOW без reasonRu и legalBasisRu не переживает PENDING_REVIEW из пустоты', async () => {
        await materializeJson(
          reportWithUsDecision({
            countryCode: 'US',
            finalStatus: 'ALLOWED',
            accessPolicy: 'ALLOW',
          }),
        );

        const us = usDecisionData();
        expect(us?.['finalStatus']).toBe('PENDING_REVIEW');
        expect(us?.['accessPolicy']).toBe('REVIEW_REQUIRED');
      });

      it('кейс По: обоснованное решение агента по-прежнему доживает до записи', async () => {
        await materializeJson(
          reportWithUsDecision({
            countryCode: 'US',
            finalStatus: 'ALLOWED',
            accessPolicy: 'ALLOW',
            legalBasisRu: 'PD, автор †1849',
            confidence: 'HIGH',
          }),
        );

        const us = usDecisionData();
        expect(us?.['finalStatus']).toBe('ALLOWED');
        expect(us?.['accessPolicy']).toBe('ALLOW');
        expect(us?.['legalBasisRu']).toBe('PD, автор †1849');
      });
    });

    it('обратная сторона G.5: оценённый язык сохраняет вердикт агента', async () => {
      await materializeJson(makeValidReportJson(), { targetLanguages: ['en', 'ru', 'fr'] });

      const byLanguage = new Map(
        dataOf('editionRights').map((data) => [data['languageCode'], data]),
      );
      expect(byLanguage.get('ru')?.['status']).toBe('LICENSE_REQUIRED');
      expect(byLanguage.get('en')?.['status']).toBe('ALLOWED');
    });
  });
});
