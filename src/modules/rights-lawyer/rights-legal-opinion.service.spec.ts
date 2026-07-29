import { PrismaService } from '../../prisma/prisma.service';
import { RightsLawyerService } from './rights-lawyer.service';
import { RightsLegalOpinionService } from './rights-legal-opinion.service';
import {
  RightsLawyerReviewStatus,
  RightsLawyerType,
  RightsLegalOpinionKind,
  type RightsLawyerRecord,
} from './rights-lawyer-interface';
import { LAWYER_OPINION_MAX_BODY_LENGTH } from './rights-lawyer.constants';

const LAWYER: RightsLawyerRecord = {
  id: 'lawyer-1',
  fullName: 'Иванова Анна',
  lawyerType: RightsLawyerType.EXTERNAL_COUNSEL,
  organization: 'Юридическое бюро «Право»',
  barId: null,
  email: null,
  phone: null,
  jurisdictionCodes: ['RU'],
  specializationRu: null,
  notesRu: null,
  userId: null,
  isActive: true,
  deactivatedAt: null,
  deactivatedByUserId: null,
  deactivateReasonRu: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeReview = (overrides: Record<string, unknown> = {}) => ({
  id: 'lr-1',
  status: RightsLawyerReviewStatus.IN_PROGRESS,
  rightsProfileId: 'profile-1',
  assignedLawyerId: 'lawyer-1',
  ...overrides,
});

const makeOpinion = (overrides: Record<string, unknown> = {}) => ({
  id: 'op-1',
  rightsLawyerReviewId: 'lr-1',
  kind: RightsLegalOpinionKind.EXTERNAL_COUNSEL_MEMO,
  titleRu: 'Меморандум',
  bodyRu: 'Текст заключения',
  lawyerId: 'lawyer-1',
  lawyerNameSnapshot: 'Иванова Анна',
  documentUrl: null,
  documentSha256: null,
  fileName: null,
  mimeType: null,
  issuedAt: null,
  jurisdictionCodes: [],
  rightsEvidenceId: 'ev-1',
  uploadedByUserId: 'user-1',
  archivedAt: null,
  archivedByUserId: null,
  archiveReasonRu: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createPrismaStub = () => {
  const stub: Record<string, unknown> = {
    rightsLawyerReview: { findUnique: jest.fn().mockResolvedValue(makeReview()) },
    rightsLegalOpinion: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(makeOpinion()),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeOpinion(data)),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeOpinion(data)),
        ),
    },
    rightsLawyerReviewEvent: { create: jest.fn().mockResolvedValue({}) },
    rightsEvidence: { create: jest.fn().mockResolvedValue({ id: 'ev-1' }) },
  };
  stub['$transaction'] = jest.fn((callback: (client: unknown) => unknown) => callback(stub));
  return stub;
};

describe('RightsLegalOpinionService', () => {
  let prisma: ReturnType<typeof createPrismaStub>;
  let lawyers: RightsLawyerService;
  let service: RightsLegalOpinionService;

  const opinionDelegate = () => prisma['rightsLegalOpinion'] as Record<string, jest.Mock>;
  const evidenceDelegate = () => prisma['rightsEvidence'] as Record<string, jest.Mock>;
  const reviewDelegate = () => prisma['rightsLawyerReview'] as Record<string, jest.Mock>;
  const eventDelegate = () => prisma['rightsLawyerReviewEvent'] as Record<string, jest.Mock>;

  const baseDto = {
    titleRu: 'Меморандум о правах',
    bodyRu: 'Произведение перешло в общественное достояние в 1978 году.',
  };

  beforeEach(() => {
    prisma = createPrismaStub();
    lawyers = new RightsLawyerService(prisma as unknown as PrismaService);
    jest.spyOn(lawyers, 'requireLawyer').mockResolvedValue(LAWYER);
    service = new RightsLegalOpinionService(prisma as unknown as PrismaService, lawyers);
  });

  describe('attach', () => {
    it('creates LEGAL_OPINION evidence tied to the rights profile', async () => {
      await service.attach('lr-1', baseDto, 'user-1');

      const evidence = evidenceDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(evidence['rightsProfileId']).toBe('profile-1');
      expect(evidence['evidenceType']).toBe('LEGAL_OPINION');
      expect(evidence['sourceLevel']).toBe('SECONDARY');
      expect(evidence['authority']).toBe('Юридическое бюро «Право»');
      expect(evidence['relevantExcerpt']).toBe(baseDto.bodyRu);

      const opinion = opinionDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(opinion['rightsEvidenceId']).toBe('ev-1');
      expect(opinion['lawyerNameSnapshot']).toBe('Иванова Анна');
    });

    it('still creates the opinion when the review has no rights profile', async () => {
      reviewDelegate().findUnique.mockResolvedValue(makeReview({ rightsProfileId: null }));

      await service.attach('lr-1', baseDto, 'user-1');

      expect(evidenceDelegate().create).not.toHaveBeenCalled();
      const opinion = opinionDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(opinion['rightsEvidenceId']).toBeNull();
    });

    it('deduplicates by documentSha256 within the same review', async () => {
      const sha = 'a'.repeat(64);
      opinionDelegate().findFirst.mockResolvedValue(makeOpinion({ documentSha256: sha }));

      const result = await service.attach('lr-1', { ...baseDto, documentSha256: sha }, 'user-1');

      expect(opinionDelegate().create).not.toHaveBeenCalled();
      expect(result.documentSha256).toBe(sha);
    });

    it('rejects a body longer than the limit', async () => {
      await expect(
        service.attach(
          'lr-1',
          { ...baseDto, bodyRu: 'x'.repeat(LAWYER_OPINION_MAX_BODY_LENGTH + 1) },
          'user-1',
        ),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_OPINION_TOO_LARGE', statusCode: 400 } });
    });

    it('requires a lawyer when the review has none assigned', async () => {
      reviewDelegate().findUnique.mockResolvedValue(makeReview({ assignedLawyerId: null }));

      await expect(service.attach('lr-1', baseDto, 'user-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_OPINION_LAWYER_REQUIRED', statusCode: 400 },
      });
    });

    it('refuses to attach to a withdrawn review', async () => {
      reviewDelegate().findUnique.mockResolvedValue(
        makeReview({ status: RightsLawyerReviewStatus.WITHDRAWN }),
      );

      await expect(service.attach('lr-1', baseDto, 'user-1')).rejects.toMatchObject({
        response: { code: 'LAWYER_REVIEW_ALREADY_CLOSED', statusCode: 409 },
      });
    });

    it('records an OPINION_ATTACHED event', async () => {
      await service.attach('lr-1', baseDto, 'user-1');
      const event = eventDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect(event['eventType']).toBe('OPINION_ATTACHED');
    });

    it('truncates the evidence excerpt to 2000 characters', async () => {
      await service.attach('lr-1', { ...baseDto, bodyRu: 'y'.repeat(5000) }, 'user-1');
      const evidence = evidenceDelegate().create.mock.calls[0][0].data as Record<string, unknown>;
      expect((evidence['relevantExcerpt'] as string).length).toBe(2000);
    });
  });

  describe('archive', () => {
    it('is soft and keeps the evidence', async () => {
      await service.archive('lr-1', 'op-1', { reasonRu: 'заключение устарело' }, 'user-1');

      const data = opinionDelegate().update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['archivedAt']).toBeInstanceOf(Date);
      expect(data['archiveReasonRu']).toBe('заключение устарело');
      expect(opinionDelegate()).not.toHaveProperty('delete');
      expect(evidenceDelegate()).not.toHaveProperty('delete');
    });

    it('rejects archiving twice', async () => {
      opinionDelegate().findUnique.mockResolvedValue(makeOpinion({ archivedAt: new Date() }));

      await expect(
        service.archive('lr-1', 'op-1', { reasonRu: 'заключение устарело' }, 'user-1'),
      ).rejects.toMatchObject({
        response: { code: 'LAWYER_OPINION_ALREADY_ARCHIVED', statusCode: 409 },
      });
    });

    it('rejects an opinion belonging to another review', async () => {
      opinionDelegate().findUnique.mockResolvedValue(
        makeOpinion({ rightsLawyerReviewId: 'lr-other' }),
      );

      await expect(
        service.archive('lr-1', 'op-1', { reasonRu: 'заключение устарело' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_OPINION_NOT_FOUND', statusCode: 404 } });
    });

    it('requires a reason of at least 10 characters', async () => {
      await expect(
        service.archive('lr-1', 'op-1', { reasonRu: 'нет' }, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'LAWYER_REASON_TOO_SHORT', statusCode: 400 } });
    });
  });
});
