import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsRiskAssessmentService } from './rights-risk-assessment.service';
import { RightsRiskLevel } from './rights-lawyer-interface';

const createPrismaStub = () => ({
  rightsProfile: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  sourceEdition: { findUnique: jest.fn().mockResolvedValue(null) },
  rightsComponent: { findMany: jest.fn().mockResolvedValue([]) },
  territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
  rightsAction: { findMany: jest.fn().mockResolvedValue([]) },
  rightsProfileContributor: { findMany: jest.fn().mockResolvedValue([]) },
  rightsClaim: { findMany: jest.fn().mockResolvedValue([]) },
  rightsLawyerReview: { findUnique: jest.fn().mockResolvedValue(null) },
});

const createConfigStub = (values: Record<string, string> = {}) => ({
  get: jest.fn((key: string) => values[key]),
});

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  rightsIntakeId: 'intake-1',
  status: 'HUMAN_REVIEW_REQUIRED',
  isCurrent: true,
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  riskLevel: RightsRiskLevel.LOW,
  riskFactors: null,
  riskAssessedAt: null,
  lawyerReviewRequired: false,
  lawyerReviewBlocking: false,
  currentLawyerReviewId: null,
  lawyerApprovedAt: null,
  lawyerApprovedLawyerId: null,
  lawyerApprovedLawyerName: null,
  lawyerOpinionValidUntil: null,
  ...overrides,
});

describe('RightsRiskAssessmentService', () => {
  let prisma: ReturnType<typeof createPrismaStub>;
  let config: ReturnType<typeof createConfigStub>;
  let service: RightsRiskAssessmentService;

  const build = (configValues: Record<string, string> = {}) => {
    config = createConfigStub(configValues);
    service = new RightsRiskAssessmentService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  };

  beforeEach(() => {
    prisma = createPrismaStub();
    build();
  });

  describe('loadInput', () => {
    it('throws LAWYER_PROFILE_NOT_FOUND for an unknown profile', async () => {
      prisma.rightsProfile.findUnique.mockResolvedValue(null);
      await expect(service.loadInput('missing')).rejects.toMatchObject({
        response: { code: 'LAWYER_PROFILE_NOT_FOUND', statusCode: 404 },
      });
    });

    it('maps the contributor death year through the linked person', async () => {
      prisma.rightsProfile.findUnique.mockResolvedValue(makeProfile());
      prisma.rightsProfileContributor.findMany.mockResolvedValue([
        { role: 'TRANSLATOR', person: { fullName: 'Иванов', deathYear: null } },
        { role: 'AUTHOR', person: null },
      ]);

      const input = await service.loadInput('profile-1');
      expect(input.contributors).toEqual([
        { role: 'TRANSLATOR', fullName: 'Иванов', deathYear: null },
        { role: 'AUTHOR', fullName: '', deathYear: null },
      ]);
    });

    it('reads the source text type from the source edition', async () => {
      prisma.rightsProfile.findUnique.mockResolvedValue(makeProfile());
      prisma.sourceEdition.findUnique.mockResolvedValue({
        rightsProfileId: 'profile-1',
        sourceTextType: 'TRANSLATION',
      });

      const input = await service.loadInput('profile-1');
      expect(input.sourceTextType).toBe('TRANSLATION');
    });
  });

  describe('assessAndSync', () => {
    it('stores the snapshot when the risk changes', async () => {
      prisma.rightsProfile.findUnique.mockResolvedValue(makeProfile({ publicationGate: 'BLOCK' }));
      prisma.rightsProfile.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeProfile({ publicationGate: 'BLOCK', ...data })),
      );

      const snapshot = await service.assessAndSync('profile-1');

      expect(snapshot.riskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(snapshot.lawyerReviewRequired).toBe(true);
      const updateData = prisma.rightsProfile.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(updateData['riskLevel']).toBe(RightsRiskLevel.CRITICAL);
      expect(updateData['lawyerReviewRequired']).toBe(true);
      expect(updateData['riskAssessedAt']).toBeInstanceOf(Date);
    });

    it('is idempotent: an unchanged assessment only moves riskAssessedAt', async () => {
      prisma.rightsProfile.findUnique.mockResolvedValue(
        makeProfile({
          publicationGate: 'BLOCK',
          riskLevel: RightsRiskLevel.CRITICAL,
          lawyerReviewRequired: true,
          riskFactors: [{ code: 'PUBLICATION_GATE_BLOCK' }],
        }),
      );
      prisma.rightsProfile.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(
            makeProfile({
              publicationGate: 'BLOCK',
              riskLevel: RightsRiskLevel.CRITICAL,
              lawyerReviewRequired: true,
              ...data,
            }),
          ),
      );

      await service.assessAndSync('profile-1');

      const updateData = prisma.rightsProfile.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(Object.keys(updateData)).toEqual(['riskAssessedAt']);
    });

    it('never marks a lawyer as required when the workflow is disabled', async () => {
      build({ RIGHTS_LAWYER_WORKFLOW_ENABLED: '0' });
      prisma.rightsProfile.findUnique.mockResolvedValue(makeProfile({ publicationGate: 'BLOCK' }));
      prisma.rightsProfile.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeProfile({ publicationGate: 'BLOCK', ...data })),
      );

      const snapshot = await service.assessAndSync('profile-1');

      expect(snapshot.riskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(snapshot.lawyerReviewRequired).toBe(false);
    });

    it('honours a raised RIGHTS_LAWYER_MIN_RISK_LEVEL', async () => {
      build({ RIGHTS_LAWYER_MIN_RISK_LEVEL: 'CRITICAL' });
      prisma.rightsProfile.findUnique.mockResolvedValue(makeProfile({ confidence: 'LOW' }));
      prisma.rightsProfile.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeProfile({ confidence: 'LOW', ...data })),
      );

      const snapshot = await service.assessAndSync('profile-1');

      expect(snapshot.riskLevel).toBe(RightsRiskLevel.HIGH);
      expect(snapshot.minRiskLevel).toBe(RightsRiskLevel.CRITICAL);
      expect(snapshot.lawyerReviewRequired).toBe(false);
    });
  });

  describe('policy helpers', () => {
    it('isLawyerRequired follows the threshold', () => {
      expect(service.isLawyerRequired(RightsRiskLevel.HIGH)).toBe(true);
      expect(service.isLawyerRequired(RightsRiskLevel.MEDIUM)).toBe(false);
    });

    it('blocksApprovalByPolicy is false when blocking is switched off', () => {
      build({ RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK: '0' });
      expect(service.isLawyerRequired(RightsRiskLevel.CRITICAL)).toBe(true);
      expect(service.blocksApprovalByPolicy(RightsRiskLevel.CRITICAL)).toBe(false);
    });
  });
});
