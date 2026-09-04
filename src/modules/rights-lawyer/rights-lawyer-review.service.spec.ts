import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import { RightsLawyerReviewService } from './rights-lawyer-review.service';
import { RightsLawyerService } from './rights-lawyer.service';
import { RightsRiskAssessmentService } from './rights-risk-assessment.service';
import {
  RightsLawyerConditionStatus,
  RightsLawyerDecision,
  RightsLawyerReviewEventType,
  RightsLawyerReviewStatus,
  RightsLawyerReviewTrigger,
  RightsLawyerType,
  RightsRiskLevel,
  type RightsLawyerRecord,
  type RightsLawyerReviewRecord,
} from './rights-lawyer-interface';

const LAWYER: RightsLawyerRecord = {
  id: 'lawyer-1',
  fullName: 'Иванова Анна',
  lawyerType: RightsLawyerType.EXTERNAL_COUNSEL,
  organization: 'Бюро',
  barId: null,
  email: null,
  phone: null,
  jurisdictionCodes: ['RU'],
  specializationRu: null,
  notesRu: null,
  userId: 'user-lawyer',
  isActive: true,
  deactivatedAt: null,
  deactivatedByUserId: null,
  deactivateReasonRu: null,
  createdByUserId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const makeReview = (
  overrides: Partial<RightsLawyerReviewRecord> = {},
): RightsLawyerReviewRecord => ({
  id: 'lr-1',
  reviewNumber: 'LR-2026-000001',
  status: RightsLawyerReviewStatus.PENDING,
  trigger: RightsLawyerReviewTrigger.HIGH_RISK_POLICY,
  riskLevel: RightsRiskLevel.HIGH,
  riskFactors: [],
  rightsProfileId: 'profile-1',
  rightsIntakeId: 'intake-1',
  rightsReviewId: 'review-1',
  bookId: null,
  bookVersionId: null,
  rightsClaimId: null,
  titleRu: 'Юридическая проверка',
  questionRu: 'Можно ли публиковать?',
  contextRu: null,
  affectedCountryCodes: ['US'],
  affectedLanguages: ['en'],
  affectedComponentIds: [],
  blocksApproval: true,
  requestedByUserId: 'user-1',
  requestedAt: new Date('2026-07-01T00:00:00.000Z'),
  dueAt: new Date('2026-07-15T00:00:00.000Z'),
  assignedLawyerId: null,
  assignedAt: null,
  assignedByUserId: null,
  startedAt: null,
  decision: null,
  decidedAt: null,
  decidedByUserId: null,
  decidedLawyerId: null,
  lawyerNameSnapshot: null,
  opinionSummaryRu: null,
  restrictionsRu: null,
  approvedCountryCodes: [],
  blockedCountryCodes: [],
  validUntil: null,
  expiredAt: null,
  expiryNotifiedAt: null,
  withdrawnAt: null,
  withdrawnByUserId: null,
  withdrawReasonRu: null,
  reopenedAt: null,
  reopenedByUserId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  conditions: [],
  opinions: [],
  events: [],
  ...overrides,
});

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  rightsIntakeId: 'intake-1',
  status: 'HUMAN_REVIEW_REQUIRED',
  isCurrent: true,
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  // LOW confidence over a contested target country (see the territoryDecision stub) is a HIGH
  // risk factor, so the default profile of this suite genuinely requires a lawyer — which is
  // what almost every case below is about.
  confidence: 'LOW',
  riskLevel: RightsRiskLevel.HIGH,
  riskFactors: [],
  riskAssessedAt: null,
  lawyerReviewRequired: true,
  lawyerReviewBlocking: false,
  currentLawyerReviewId: null,
  lawyerApprovedAt: null,
  lawyerApprovedLawyerId: null,
  lawyerApprovedLawyerName: null,
  lawyerOpinionValidUntil: null,
  ...overrides,
});

const createPrismaStub = () => {
  const stub: Record<string, unknown> = {
    rightsLawyerReview: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(makeReview()),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeReview(data as Partial<RightsLawyerReviewRecord>)),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeReview(data as Partial<RightsLawyerReviewRecord>)),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsLawyerReviewEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsLawyerReviewCondition: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'cond-1',
          status: RightsLawyerConditionStatus.PENDING,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }),
      ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsLegalOpinion: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsProfile: {
      findUnique: jest.fn().mockResolvedValue(makeProfile()),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(makeProfile()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsReview: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rightsIntake: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'intake-1',
        candidateTitle: 'Гамлет',
        workflowStatus: 'HUMAN_REVIEW_REQUIRED',
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookVersion: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn() },
    rightsComponent: { findMany: jest.fn().mockResolvedValue([]) },
    // WP-E: с 02.08.2026 гейт считает риск заново. Чтобы профиль этого сьюта действительно
    // требовал юриста, у него есть целевая страна с LICENSE_REQUIRED — фактор HIGH сам по себе.
    territoryDecision: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ countryCode: 'US', finalStatus: 'LICENSE_REQUIRED' }]),
    },
    rightsAction: { findMany: jest.fn().mockResolvedValue([]) },
    rightsProfileContributor: { findMany: jest.fn().mockResolvedValue([]) },
    rightsClaim: { findMany: jest.fn().mockResolvedValue([]) },
    rightsEvidence: { create: jest.fn().mockResolvedValue({ id: 'ev-1' }) },
    sourceEdition: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn() },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-1',
        name: null,
        email: 'a@b.c',
        roles: [{ role: { name: 'admin' } }],
      }),
    },
  };
  stub['$transaction'] = jest.fn((callback: (client: unknown) => unknown) => callback(stub));
  return stub;
};

describe('RightsLawyerReviewService', () => {
  let prisma: ReturnType<typeof createPrismaStub>;
  let notifications: { create: jest.Mock };
  let lawyers: RightsLawyerService;
  let risk: RightsRiskAssessmentService;
  let service: RightsLawyerReviewService;

  const build = (configValues: Record<string, string> = {}) => {
    const config = { get: jest.fn((key: string) => configValues[key]) };
    lawyers = new RightsLawyerService(prisma as unknown as PrismaService);
    jest.spyOn(lawyers, 'requireActiveLawyer').mockResolvedValue(LAWYER);
    jest.spyOn(lawyers, 'requireLawyer').mockResolvedValue(LAWYER);
    jest.spyOn(lawyers, 'findByUserId').mockResolvedValue(LAWYER);
    risk = new RightsRiskAssessmentService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
    service = new RightsLawyerReviewService(
      prisma as unknown as PrismaService,
      notifications as unknown as RightsNotificationsService,
      lawyers,
      risk,
      config as unknown as ConfigService,
    );
  };

  const reviewDelegate = () => prisma['rightsLawyerReview'] as Record<string, jest.Mock>;
  const eventDelegate = () => prisma['rightsLawyerReviewEvent'] as Record<string, jest.Mock>;
  const profileDelegate = () => prisma['rightsProfile'] as Record<string, jest.Mock>;
  const intakeDelegate = () => prisma['rightsIntake'] as Record<string, jest.Mock>;
  const subjectReviewDelegate = () => prisma['rightsReview'] as Record<string, jest.Mock>;
  const conditionDelegate = () =>
    prisma['rightsLawyerReviewCondition'] as Record<string, jest.Mock>;

  const eventTypes = () =>
    eventDelegate().create.mock.calls.map(
      (call) => (call[0] as { data: { eventType: string } }).data.eventType,
    );

  beforeEach(() => {
    prisma = createPrismaStub();
    notifications = { create: jest.fn().mockResolvedValue({}) };
    build();
  });

  const baseRequest = {
    rightsProfileId: 'profile-1',
    rightsReviewId: 'review-1',
    titleRu: 'Юридическая проверка Гамлета',
    questionRu: 'Можно ли публиковать перевод?',
  };

  describe('request', () => {
    it('creates the review, the REQUESTED event and the notification in one transaction', async () => {
      await service.request(baseRequest, 'user-1');

      expect(reviewDelegate().create).toHaveBeenCalledTimes(1);
      expect(eventTypes()).toContain(RightsLawyerReviewEventType.REQUESTED);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LAWYER_REVIEW_REQUIRED', severity: 'WARNING' }),
        expect.anything(),
      );
      expect(prisma['$transaction']).toHaveBeenCalled();
    });

    it('generates a LR-YYYY-NNNNNN number', async () => {
      reviewDelegate().count.mockResolvedValue(12);
      await service.request(baseRequest, 'user-1');

      const data = reviewDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['reviewNumber']).toMatch(/^LR-\d{4}-000013$/);
    });

    it('retries the number on a P2002 collision', async () => {
      const collision = Object.assign(new Error('unique'), { code: 'P2002' });
      reviewDelegate().count.mockResolvedValue(0);
      reviewDelegate()
        .create.mockRejectedValueOnce(collision)
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeReview(data as Partial<RightsLawyerReviewRecord>)),
        );

      await service.request(baseRequest, 'user-1');

      expect(reviewDelegate().create).toHaveBeenCalledTimes(2);
      const second = reviewDelegate().create.mock.calls[1][0].data as Record<string, unknown>;
      expect(second['reviewNumber']).toMatch(/000002$/);
    });

    it('is idempotent: an open review is reused and only gets a note', async () => {
      reviewDelegate().findFirst.mockResolvedValue(makeReview());

      await service.request(baseRequest, 'user-1');

      expect(reviewDelegate().create).not.toHaveBeenCalled();
      expect(eventTypes()).toEqual([RightsLawyerReviewEventType.NOTE_ADDED]);
    });

    it('requires a profile or an intake', async () => {
      await expect(
        service.request({ titleRu: 'Проверка', questionRu: 'Вопрос по правам?' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_TARGET_REQUIRED', statusCode: 400 } });
    });

    it('rejects a due date in the past', async () => {
      await expect(
        service.request({ ...baseRequest, dueAt: '2020-01-01T00:00:00.000Z' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_INVALID_DUE_DATE', statusCode: 400 } });
    });

    it('escalates intake, profile and agent review to LAWYER_REVIEW_REQUIRED', async () => {
      await service.request(baseRequest, 'user-1');

      expect(profileDelegate().updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'LAWYER_REVIEW_REQUIRED' } }),
      );
      expect(intakeDelegate().updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { workflowStatus: 'LAWYER_REVIEW_REQUIRED' } }),
      );
      expect(subjectReviewDelegate().updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'LAWYER_REVIEW_REQUIRED' }),
        }),
      );
    });

    it('never rolls an APPROVED or BOOK_CREATED intake back', async () => {
      await service.request(baseRequest, 'user-1');

      const call = intakeDelegate().updateMany.mock.calls[0][0] as {
        where: { workflowStatus: { in: string[] } };
      };
      expect(call.where.workflowStatus.in).toEqual(['REVIEW_IMPORTED', 'HUMAN_REVIEW_REQUIRED']);
    });

    it('respects an explicit blocksApproval: false', async () => {
      await service.request({ ...baseRequest, blocksApproval: false }, 'user-1');

      const data = reviewDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['blocksApproval']).toBe(false);
    });

    it('does not escalate statuses for a non-blocking review', async () => {
      reviewDelegate().create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(
          makeReview({ ...(data as Partial<RightsLawyerReviewRecord>), blocksApproval: false }),
        ),
      );

      await service.request({ ...baseRequest, blocksApproval: false }, 'user-1');

      expect(intakeDelegate().updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { workflowStatus: 'LAWYER_REVIEW_REQUIRED' } }),
      );
    });

    it('never approves the intake or writes approvedReviewId', async () => {
      await service.request(baseRequest, 'user-1');

      const writes = [
        ...intakeDelegate().update.mock.calls,
        ...intakeDelegate().updateMany.mock.calls,
      ].map((call) => JSON.stringify((call[0] as { data: unknown }).data));
      expect(writes.some((write) => write.includes('"APPROVED"'))).toBe(false);
      expect(writes.some((write) => write.includes('approvedReviewId'))).toBe(false);
    });
  });

  describe('status transitions', () => {
    it('allows PENDING -> IN_PROGRESS through start', async () => {
      await service.start('lr-1', 'user-1');
      expect(eventTypes()).toContain(RightsLawyerReviewEventType.STARTED);
    });

    it('rejects start from a decided review', async () => {
      reviewDelegate().findUnique.mockResolvedValue(
        makeReview({ status: RightsLawyerReviewStatus.APPROVED }),
      );
      await expect(service.start('lr-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_REVIEW_INVALID_TRANSITION', statusCode: 409 },
      });
    });

    it('rejects a decision on a REJECTED review', async () => {
      reviewDelegate().findUnique.mockResolvedValue(
        makeReview({ status: RightsLawyerReviewStatus.REJECTED }),
      );
      await expect(
        service.decide(
          'lr-1',
          {
            decision: RightsLawyerDecision.APPROVED,
            lawyerId: 'lawyer-1',
            opinionSummaryRu: 'Всё в порядке, можно публиковать.',
          },
          'user-1',
        ),
      ).rejects.toMatchObject({
        response: { code: 'LAWYER_REVIEW_INVALID_TRANSITION', statusCode: 409 },
      });
    });

    it('rejects withdrawing an already withdrawn review', async () => {
      reviewDelegate().findUnique.mockResolvedValue(
        makeReview({ status: RightsLawyerReviewStatus.WITHDRAWN }),
      );
      await expect(
        service.withdraw('lr-1', { reasonRu: 'дублирующая проверка' }, 'user-1'),
      ).rejects.toMatchObject({
        response: { code: 'LAWYER_REVIEW_INVALID_TRANSITION', statusCode: 409 },
      });
    });
  });

  describe('decide', () => {
    const approve = {
      decision: RightsLawyerDecision.APPROVED,
      lawyerId: 'lawyer-1',
      opinionSummaryRu: 'Произведение в общественном достоянии, публикация допустима.',
    };

    it('stores the lawyer name snapshot', async () => {
      await service.decide('lr-1', approve, 'user-1');

      const data = reviewDelegate().update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['lawyerNameSnapshot']).toBe('Иванова Анна');
      expect(data['decidedLawyerId']).toBe('lawyer-1');
      expect(data['decidedByUserId']).toBe('user-1');
    });

    it('rejects a deactivated lawyer', async () => {
      jest
        .spyOn(lawyers, 'requireActiveLawyer')
        .mockRejectedValue(
          Object.assign(new Error('inactive'), { response: { code: 'LAWYER_INACTIVE' } }),
        );
      await expect(service.decide('lr-1', approve, 'user-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_INACTIVE' },
      });
    });

    it('rejects a too short opinion summary', async () => {
      await expect(
        service.decide('lr-1', { ...approve, opinionSummaryRu: 'ок' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_REASON_TOO_SHORT', statusCode: 400 } });
    });

    it('requires at least one condition for APPROVED_WITH_CONDITIONS', async () => {
      await expect(
        service.decide(
          'lr-1',
          { ...approve, decision: RightsLawyerDecision.APPROVED_WITH_CONDITIONS },
          'user-1',
        ),
      ).rejects.toMatchObject({
        response: { code: 'LAWYER_CONDITIONS_REQUIRED', statusCode: 400 },
      });
    });

    it('creates the conditions of an APPROVED_WITH_CONDITIONS decision', async () => {
      await service.decide(
        'lr-1',
        {
          ...approve,
          decision: RightsLawyerDecision.APPROVED_WITH_CONDITIONS,
          conditions: [{ code: 'geo_block_us', textRu: 'Заблокировать США' }],
        },
        'user-1',
      );

      const data = conditionDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['code']).toBe('GEO_BLOCK_US');
      expect(data['isBlocking']).toBe(true);
      expect(eventTypes()).toContain(RightsLawyerReviewEventType.CONDITION_ADDED);
    });

    it('defaults validUntil to now + 730 days', async () => {
      await service.decide('lr-1', approve, 'user-1');

      const data = reviewDelegate().update.mock.calls[0][0].data as Record<string, unknown>;
      const validUntil = data['validUntil'] as Date;
      const days = Math.round((validUntil.getTime() - Date.now()) / 86_400_000);
      expect(days).toBe(730);
    });

    it('leaves validUntil null for a rejection', async () => {
      await service.decide(
        'lr-1',
        { ...approve, decision: RightsLawyerDecision.REJECTED },
        'user-1',
      );

      const data = reviewDelegate().update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['validUntil']).toBeNull();
    });

    it('writes both STARTED and DECIDED when deciding straight from PENDING', async () => {
      await service.decide('lr-1', approve, 'user-1');
      expect(eventTypes()).toEqual([
        RightsLawyerReviewEventType.STARTED,
        RightsLawyerReviewEventType.DECIDED,
      ]);
    });

    it('returns the intake to HUMAN_REVIEW_REQUIRED on a positive decision', async () => {
      reviewDelegate().update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeReview({ ...(data as Partial<RightsLawyerReviewRecord>) })),
      );

      await service.decide('lr-1', approve, 'user-1');

      expect(profileDelegate().updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'LAWYER_APPROVED' } }),
      );
      expect(intakeDelegate().updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { workflowStatus: 'HUMAN_REVIEW_REQUIRED' } }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LAWYER_REVIEW_APPROVED', severity: 'SUCCESS' }),
        expect.anything(),
      );
    });

    it('leaves workflow statuses untouched on a rejection', async () => {
      await service.decide(
        'lr-1',
        { ...approve, decision: RightsLawyerDecision.REJECTED },
        'user-1',
      );

      expect(profileDelegate().updateMany).not.toHaveBeenCalled();
      expect(intakeDelegate().updateMany).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LAWYER_REVIEW_REJECTED', severity: 'ERROR' }),
        expect.anything(),
      );
    });
  });

  describe('assign', () => {
    it('lets a lawyer take a review for themselves', async () => {
      (prisma['user'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        id: 'user-lawyer',
        name: null,
        email: 'l@b.c',
        roles: [{ role: { name: 'lawyer' } }],
      });

      await service.assign('lr-1', { lawyerId: 'lawyer-1' }, 'user-lawyer');

      expect(eventTypes()).toContain(RightsLawyerReviewEventType.ASSIGNED);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LAWYER_REVIEW_ASSIGNED', targetUserId: 'user-lawyer' }),
        expect.anything(),
      );
    });

    it('forbids a lawyer from assigning someone else', async () => {
      (prisma['user'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        id: 'user-lawyer',
        name: null,
        email: 'l@b.c',
        roles: [{ role: { name: 'lawyer' } }],
      });
      jest.spyOn(lawyers, 'findByUserId').mockResolvedValue({ ...LAWYER, id: 'lawyer-other' });

      await expect(
        service.assign('lr-1', { lawyerId: 'lawyer-1' }, 'user-lawyer'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_SELF_ASSIGN_ONLY', statusCode: 403 } });
    });

    it('refuses to assign a closed review', async () => {
      reviewDelegate().findUnique.mockResolvedValue(
        makeReview({ status: RightsLawyerReviewStatus.APPROVED }),
      );
      await expect(
        service.assign('lr-1', { lawyerId: 'lawyer-1' }, 'user-1'),
      ).rejects.toMatchObject({
        response: { code: 'LAWYER_REVIEW_ALREADY_CLOSED', statusCode: 409 },
      });
    });
  });

  describe('conditions', () => {
    const condition = {
      id: 'cond-1',
      rightsLawyerReviewId: 'lr-1',
      code: 'GEO_BLOCK_US',
      textRu: 'Заблокировать США',
      status: RightsLawyerConditionStatus.PENDING,
      isBlocking: true,
      affectedCountryCodes: [],
      satisfiedAt: null,
      satisfiedByUserId: null,
      satisfiedNotesRu: null,
      waivedAt: null,
      waivedByUserId: null,
      waiveReasonRu: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('marks a condition satisfied', async () => {
      conditionDelegate().findUnique.mockResolvedValue(condition);
      await service.satisfyCondition('lr-1', 'cond-1', { notesRu: 'сделано' }, 'user-1');

      const data = conditionDelegate().update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['status']).toBe(RightsLawyerConditionStatus.SATISFIED);
      expect(eventTypes()).toContain(RightsLawyerReviewEventType.CONDITION_SATISFIED);
    });

    it('rejects satisfying an already closed condition', async () => {
      conditionDelegate().findUnique.mockResolvedValue({
        ...condition,
        status: RightsLawyerConditionStatus.SATISFIED,
      });
      await expect(service.satisfyCondition('lr-1', 'cond-1', {}, 'user-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_CONDITION_ALREADY_CLOSED', statusCode: 409 },
      });
    });

    it('requires a reason to waive a condition', async () => {
      conditionDelegate().findUnique.mockResolvedValue(condition);
      await expect(
        service.waiveCondition('lr-1', 'cond-1', { reasonRu: 'нет' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_REASON_TOO_SHORT', statusCode: 400 } });
    });

    it('reports LAWYER_CONDITION_NOT_FOUND for a condition of another review', async () => {
      conditionDelegate().findUnique.mockResolvedValue({
        ...condition,
        rightsLawyerReviewId: 'lr-other',
      });
      await expect(service.satisfyCondition('lr-1', 'cond-1', {}, 'user-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_CONDITION_NOT_FOUND', statusCode: 404 },
      });
    });

    /**
     * LEGACY-036. `addCondition` звал `createCondition(this.getDatabase(), ...)`: параметр
     * назывался `tx`, а приходил корневой клиент — условие и событие о нём писались двумя
     * независимыми `await`. Условие блокирует публикацию, поэтому запись о нём обязана лечь
     * той же транзакцией.
     *
     * Двойник ниже фиксирует записи транзакции в «БД» только после успеха коллбэка: запись
     * мимо транзакции считается закоммиченной сразу и тест краснеет.
     */
    it('addCondition: отказ журнала не оставляет условие без записи о нём', async () => {
      const committed: string[] = [];

      const clientFor = (buffer: string[]) => ({
        ...prisma,
        rightsLawyerReviewCondition: {
          ...conditionDelegate(),
          create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
            buffer.push('condition.create');
            return Promise.resolve({ id: 'cond-1', ...data });
          }),
        },
        rightsLawyerReviewEvent: {
          ...eventDelegate(),
          create: jest.fn(() => {
            throw new Error('journal write failed');
          }),
        },
      });

      const root = clientFor(committed);
      const client = {
        ...root,
        $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
          const pending: string[] = [];
          const result = await callback(clientFor(pending));
          committed.push(...pending);
          return result;
        },
      };

      const atomicService = new RightsLawyerReviewService(
        client as unknown as PrismaService,
        notifications as unknown as RightsNotificationsService,
        lawyers,
        risk,
        { get: jest.fn() } as unknown as ConfigService,
      );

      await expect(
        atomicService.addCondition(
          'lr-1',
          { code: 'GEO_BLOCK_US', textRu: 'Заблокировать США' },
          'user-1',
        ),
      ).rejects.toThrow('journal write failed');

      expect(committed).toHaveLength(0);
    });
  });

  describe('withdraw and reopen', () => {
    it('withdraw clears the blocking flag and notifies', async () => {
      reviewDelegate().update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeReview({ ...(data as Partial<RightsLawyerReviewRecord>) })),
      );

      await service.withdraw('lr-1', { reasonRu: 'проверка больше не нужна' }, 'user-1');

      expect(eventTypes()).toContain(RightsLawyerReviewEventType.WITHDRAWN);
      expect(profileDelegate().update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lawyerReviewBlocking: false }),
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LAWYER_REVIEW_WITHDRAWN' }),
        expect.anything(),
      );
    });

    it('reopen clears the verdict but keeps opinions and conditions', async () => {
      reviewDelegate().findUnique.mockResolvedValue(
        makeReview({
          status: RightsLawyerReviewStatus.REJECTED,
          decision: RightsLawyerDecision.REJECTED,
          lawyerNameSnapshot: 'Иванова Анна',
        }),
      );

      await service.reopen('lr-1', 'user-1');

      const data = reviewDelegate().update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['status']).toBe(RightsLawyerReviewStatus.PENDING);
      expect(data['decision']).toBeNull();
      expect(data['lawyerNameSnapshot']).toBeNull();
      expect(conditionDelegate()).not.toHaveProperty('delete');
      expect(eventTypes()).toContain(RightsLawyerReviewEventType.REOPENED);
    });

    it('refuses to reopen an open review', async () => {
      await expect(service.reopen('lr-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_REVIEW_INVALID_TRANSITION', statusCode: 409 },
      });
    });
  });

  describe('evaluateVersionLawyerReview', () => {
    const withVersion = (reviews: RightsLawyerReviewRecord[], profile = makeProfile()) => {
      (prisma['bookVersion'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        id: 'v1',
        bookId: 'b1',
        language: 'en',
        status: 'draft',
        rightsProfileId: 'profile-1',
      });
      profileDelegate().findUnique.mockResolvedValue(profile);
      reviewDelegate().findMany.mockResolvedValue(reviews);
    };

    it('returns nothing when the version has no rights profile', async () => {
      (prisma['bookVersion'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        id: 'v1',
        bookId: 'b1',
        language: 'en',
        status: 'draft',
        rightsProfileId: null,
      });

      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.blockers).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('blocks with LAWYER_REVIEW_REQUIRED_NOT_APPROVED when no opinion is in force', async () => {
      withVersion([]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.blockers.map((item) => item.code)).toContain(
        'LAWYER_REVIEW_REQUIRED_NOT_APPROVED',
      );
    });

    it('blocks with LAWYER_REVIEW_PENDING for an open blocking review', async () => {
      withVersion([makeReview({ status: RightsLawyerReviewStatus.PENDING })]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.blockers.map((item) => item.code)).toContain('LAWYER_REVIEW_PENDING');
      expect(result.openReviewsCount).toBe(1);
    });

    it('blocks with LAWYER_REVIEW_REJECTED after a refusal', async () => {
      withVersion([
        makeReview({
          status: RightsLawyerReviewStatus.REJECTED,
          decision: RightsLawyerDecision.REJECTED,
          decidedAt: new Date('2026-07-10T00:00:00.000Z'),
        }),
      ]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.blockers.map((item) => item.code)).toContain('LAWYER_REVIEW_REJECTED');
    });

    it('blocks with LAWYER_OPINION_EXPIRED even when the stored status is still APPROVED', async () => {
      withVersion([
        makeReview({
          status: RightsLawyerReviewStatus.APPROVED,
          decision: RightsLawyerDecision.APPROVED,
          validUntil: new Date('2020-01-01T00:00:00.000Z'),
        }),
      ]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.blockers.map((item) => item.code)).toContain('LAWYER_OPINION_EXPIRED');
      expect(result.lawyerApproved).toBe(false);
    });

    it('blocks with LAWYER_CONDITIONS_UNMET while a blocking condition is pending', async () => {
      withVersion([
        makeReview({
          status: RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS,
          decision: RightsLawyerDecision.APPROVED_WITH_CONDITIONS,
          validUntil: new Date('2030-01-01T00:00:00.000Z'),
          conditions: [
            {
              id: 'cond-1',
              rightsLawyerReviewId: 'lr-1',
              code: 'GEO_BLOCK_US',
              textRu: 'Заблокировать США',
              status: RightsLawyerConditionStatus.PENDING,
              isBlocking: true,
              affectedCountryCodes: [],
              satisfiedAt: null,
              satisfiedByUserId: null,
              satisfiedNotesRu: null,
              waivedAt: null,
              waivedByUserId: null,
              waiveReasonRu: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        }),
      ]);

      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.blockers.map((item) => item.code)).toContain('LAWYER_CONDITIONS_UNMET');
      expect(result.pendingConditionsCount).toBe(1);
    });

    it('warns with LAWYER_REVIEW_OPEN_NON_BLOCKING for an informational review', async () => {
      // Профиль, который юриста действительно не требует: свежий расчёт должен дать LOW.
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', finalStatus: 'ALLOWED' },
      ]);
      withVersion(
        [makeReview({ blocksApproval: false })],
        makeProfile({ confidence: 'HIGH', lawyerReviewRequired: false }),
      );
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.warnings.map((item) => item.code)).toContain('LAWYER_REVIEW_OPEN_NON_BLOCKING');
      expect(result.blockers).toHaveLength(0);
    });

    it('warns with LAWYER_OPINION_EXPIRING_SOON near the end of validity', async () => {
      const soon = new Date(Date.now() + 10 * 86_400_000);
      withVersion([
        makeReview({
          status: RightsLawyerReviewStatus.APPROVED,
          decision: RightsLawyerDecision.APPROVED,
          validUntil: soon,
        }),
      ]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.warnings.map((item) => item.code)).toContain('LAWYER_OPINION_EXPIRING_SOON');
    });

    it('warns with LAWYER_APPROVED_WITH_CONDITIONS once every blocking condition is closed', async () => {
      withVersion([
        makeReview({
          status: RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS,
          decision: RightsLawyerDecision.APPROVED_WITH_CONDITIONS,
          validUntil: new Date('2030-01-01T00:00:00.000Z'),
          conditions: [],
        }),
      ]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.warnings.map((item) => item.code)).toContain('LAWYER_APPROVED_WITH_CONDITIONS');
      expect(result.blockers).toHaveLength(0);
    });

    it('warns with HIGH_RISK_WITHOUT_LAWYER_REVIEW when blocking is switched off', async () => {
      build({ RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK: '0' });
      withVersion([]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.warnings.map((item) => item.code)).toContain('HIGH_RISK_WITHOUT_LAWYER_REVIEW');
      expect(result.blockers).toHaveLength(0);
    });

    it('warns with LAWYER_REVIEW_OVERDUE for a late open review', async () => {
      withVersion([makeReview({ dueAt: new Date('2020-01-01T00:00:00.000Z') })]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.warnings.map((item) => item.code)).toContain('LAWYER_REVIEW_OVERDUE');
    });

    it('WP-E.4: drops the blocker when the fresh risk no longer requires a lawyer', async () => {
      // Снимок липкий: `lawyerReviewRequired = true`, а причина (LICENSE_REQUIRED в целевой
      // стране и confidence LOW) уже устранена.
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', finalStatus: 'ALLOWED' },
      ]);
      withVersion(
        [],
        makeProfile({ confidence: 'HIGH', lawyerReviewRequired: true, riskLevel: 'HIGH' }),
      );

      const result = await service.evaluateVersionLawyerReview('v1');

      expect(result.blockers.map((item) => item.code)).not.toContain(
        'LAWYER_REVIEW_REQUIRED_NOT_APPROVED',
      );
      expect(result.lawyerReviewRequired).toBe(false);
      expect(result.riskLevel).toBe(RightsRiskLevel.LOW);
    });

    it('WP-E.4: still blocks when the fresh risk is HIGH even if the snapshot says otherwise', async () => {
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', finalStatus: 'BLOCKED' },
      ]);
      withVersion(
        [],
        makeProfile({ confidence: 'LOW', lawyerReviewRequired: false, riskLevel: 'LOW' }),
      );

      const result = await service.evaluateVersionLawyerReview('v1');

      expect(result.blockers.map((item) => item.code)).toContain(
        'LAWYER_REVIEW_REQUIRED_NOT_APPROVED',
      );
      expect(result.lawyerReviewRequired).toBe(true);
      expect(result.riskLevel).toBe(RightsRiskLevel.HIGH);
    });

    it('returns empty blockers and warnings when the workflow is disabled', async () => {
      build({ RIGHTS_LAWYER_WORKFLOW_ENABLED: '0' });
      withVersion([makeReview()]);
      const result = await service.evaluateVersionLawyerReview('v1');
      expect(result.blockers).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('runExpiryScan', () => {
    it('materialises an expired opinion and notifies once', async () => {
      reviewDelegate().findMany.mockResolvedValue([
        makeReview({
          status: RightsLawyerReviewStatus.APPROVED,
          validUntil: new Date('2020-01-01T00:00:00.000Z'),
        }),
      ]);
      reviewDelegate().update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeReview({ ...(data as Partial<RightsLawyerReviewRecord>) })),
      );

      const result = await service.runExpiryScan('user-1');

      expect(result.expiredCount).toBe(1);
      expect(result.notificationsSent).toBe(1);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LAWYER_OPINION_EXPIRED', severity: 'ERROR' }),
        expect.anything(),
      );
    });

    it('is idempotent: an already materialised expiry is skipped', async () => {
      reviewDelegate().findMany.mockResolvedValue([
        makeReview({
          status: RightsLawyerReviewStatus.APPROVED,
          validUntil: new Date('2020-01-01T00:00:00.000Z'),
          expiredAt: new Date('2020-01-02T00:00:00.000Z'),
          expiryNotifiedAt: new Date('2020-01-02T00:00:00.000Z'),
        }),
      ]);

      const result = await service.runExpiryScan('user-1');

      expect(result.expiredCount).toBe(0);
      expect(result.notificationsSent).toBe(0);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('sends one expiring-soon warning and stays silent on the second run', async () => {
      const soon = new Date(Date.now() + 10 * 86_400_000);
      reviewDelegate().findMany.mockResolvedValue([
        makeReview({ status: RightsLawyerReviewStatus.APPROVED, validUntil: soon }),
      ]);
      reviewDelegate().update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeReview({ ...(data as Partial<RightsLawyerReviewRecord>) })),
      );

      const first = await service.runExpiryScan('user-1');
      expect(first.expiringSoonCount).toBe(1);

      reviewDelegate().findMany.mockResolvedValue([
        makeReview({
          status: RightsLawyerReviewStatus.APPROVED,
          validUntil: soon,
          expiryNotifiedAt: new Date(),
        }),
      ]);
      const second = await service.runExpiryScan('user-1');
      expect(second.expiringSoonCount).toBe(0);
      expect(second.notificationsSent).toBe(0);
    });
  });

  describe('list', () => {
    it('returns an empty page for `mine` when the user is not a lawyer', async () => {
      jest.spyOn(lawyers, 'findByUserId').mockResolvedValue(null);
      const result = await service.list({ mine: true }, 'user-1');
      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
      expect(reviewDelegate().findMany).not.toHaveBeenCalled();
    });

    it('scopes `mine` to the lawyer of the current user', async () => {
      await service.list({ mine: true }, 'user-lawyer');
      const where = reviewDelegate().findMany.mock.calls[0][0].where as Record<string, unknown>;
      expect(where['assignedLawyerId']).toBe('lawyer-1');
    });
  });
});
