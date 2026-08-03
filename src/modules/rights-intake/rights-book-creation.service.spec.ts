import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RightsBookCreationService } from './rights-book-creation.service';
import { RightsContentHashService } from './rights-content-hash.service';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookFromClearanceDto } from './dto/create-book-from-clearance.dto';

const createPrismaStub = () => {
  const stub: Record<string, unknown> = {
    book: { create: jest.fn(), findUnique: jest.fn() },
    bookVersion: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    rightsIntake: { findUnique: jest.fn(), update: jest.fn() },
    rightsReview: { findUnique: jest.fn() },
    rightsProfile: { findFirst: jest.fn() },
    rightsAction: { findMany: jest.fn() },
    territoryDecision: { findMany: jest.fn() },
    rightsComponent: { findMany: jest.fn().mockResolvedValue([]) },
    rightsLicense: { findMany: jest.fn().mockResolvedValue([]) },
    rightsLicenseLink: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  return stub;
};

const makeIntake = (overrides: Record<string, unknown> = {}) => ({
  id: 'intake-1',
  workflowStatus: 'APPROVED',
  approvedReviewId: 'review-1',
  createdBookId: null,
  targetLanguages: ['en', 'es'],
  originalLanguage: 'en',
  originalTitle: 'Original Title',
  ...overrides,
});

const makeReview = (overrides: Record<string, unknown> = {}) => ({
  id: 'review-1',
  status: 'HUMAN_APPROVED',
  rightsProfile: {
    id: 'profile-1',
    rightsIntakeId: 'intake-1',
    isCurrent: true,
    status: 'APPROVED',
    publicationGate: 'ALLOW',
  },
  ...overrides,
});

const makeDto = (overrides: Record<string, unknown> = {}): CreateBookFromClearanceDto => ({
  slug: 'test-book',
  versions: [
    {
      language: 'en',
      title: 'Test Book',
      author: 'Test Author',
      description: 'Test Description',
      coverImageUrl: 'https://example.com/cover.jpg',
      type: 'text',
      isFree: true,
    },
  ],
  ...overrides,
});

describe('RightsBookCreationService', () => {
  let service: RightsBookCreationService;
  let prisma: Record<string, unknown>;
  let mockRightsContentHashService: jest.Mocked<RightsContentHashService>;

  beforeEach(() => {
    prisma = createPrismaStub();
    mockRightsContentHashService = {
      computeVersionHash: jest.fn(),
      initializeVersionBaseline: jest.fn(),
      checkVersionStaleness: jest.fn(),
      markVersionAndClearanceStale: jest.fn(),
    } as unknown as jest.Mocked<RightsContentHashService>;
    service = new RightsBookCreationService(
      prisma as unknown as PrismaService,
      mockRightsContentHashService,
      new RightsLicenseCoverageService(
        prisma as unknown as PrismaService,
        new RightsClearanceResolverService(prisma as unknown as PrismaService),
      ),
    );
  });

  describe('createBookFromApprovedClearance', () => {
    it('should throw NotFoundException if intake not found', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.createBookFromApprovedClearance('nonexistent', makeDto()),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if intake is not APPROVED', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'HUMAN_REVIEW_REQUIRED' }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if approvedReviewId is null', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ approvedReviewId: null }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if createdBookId already exists', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ createdBookId: 'book-1' }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if approved review not found', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if review is not HUMAN_APPROVED', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({ status: 'HUMAN_REVIEW_REQUIRED' }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if profile is not current', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({
          rightsProfile: {
            id: 'profile-1',
            rightsIntakeId: 'intake-1',
            isCurrent: false,
            status: 'APPROVED',
            publicationGate: 'ALLOW',
          },
        }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if profile is not APPROVED', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({
          rightsProfile: {
            id: 'profile-1',
            rightsIntakeId: 'intake-1',
            isCurrent: true,
            status: 'HUMAN_REVIEW_REQUIRED',
            publicationGate: 'ALLOW',
          },
        }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if profile belongs to different intake', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({
          rightsProfile: {
            id: 'profile-1',
            rightsIntakeId: 'intake-2',
            isCurrent: true,
            status: 'APPROVED',
            publicationGate: 'ALLOW',
          },
        }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if publicationGate is BLOCK', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({
          rightsProfile: {
            id: 'profile-1',
            rightsIntakeId: 'intake-1',
            isCurrent: true,
            status: 'APPROVED',
            publicationGate: 'BLOCK',
          },
        }),
      );

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    // WP-H: создание книги — подготовка, а не выпуск. Незакрытое блокирующее действие здесь
    // больше не отказывает: сделать его часто нельзя, пока книги нет. Проверка осталась при
    // утверждении интейка и в гейте публикации (блок 6.12) — см. тесты обеих сторон там.
    describe.each([
      ['PENDING', 'unresolved'],
      ['COMPLETED', 'closed'],
      ['WAIVED', 'waived'],
    ])('with a %s blocking action (%s)', (status) => {
      it('creates the book and carries the action into the rights snapshot', async () => {
        (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
          makeIntake(),
        );
        (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
          makeReview(),
        );
        (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
          {
            id: 'action-1',
            isBlocking: true,
            status,
            actionType: 'LICENSE_CHECK',
            descriptionRu: 'Test',
            affectedCountryCodes: [],
          },
        ]);
        (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
        (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

        const bookVersionCreate = jest.fn().mockResolvedValue({ id: 'version-1' });
        const txStub = {
          book: {
            create: jest.fn().mockResolvedValue({
              id: 'book-1',
              slug: 'test-book',
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          },
          bookVersion: { create: bookVersionCreate },
          rightsIntake: { update: jest.fn().mockResolvedValue({}) },
        };
        (prisma['$transaction'] as jest.Mock).mockImplementation((fn) =>
          Promise.resolve(fn(txStub)),
        );

        const result = await service.createBookFromApprovedClearance('intake-1', makeDto());

        expect(result).toBeDefined();
        const createArgs = bookVersionCreate.mock.calls[0]?.[0] as {
          data: Record<string, unknown>;
        };
        expect(createArgs.data.rightsRequiredActions).toEqual([
          expect.objectContaining({ id: 'action-1', status, isBlocking: true }),
        ]);
      });
    });

    // WP-H: каждый отказ несёт машинный код — фронт отличает «интейк не утверждён» от «слаг занят».
    it('carries a machine-readable code in every refusal', async () => {
      const readCode = async (arrange: () => void): Promise<unknown> => {
        arrange();
        try {
          await service.createBookFromApprovedClearance('intake-1', makeDto());
        } catch (e) {
          const response = (e as BadRequestException).getResponse() as Record<string, unknown>;
          return response.code;
        }
        return undefined;
      };

      const intakeFindUnique = (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique;
      const reviewFindUnique = (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique;

      await expect(readCode(() => intakeFindUnique.mockResolvedValue(null))).resolves.toBe(
        'BOOK_CREATION_INTAKE_NOT_FOUND',
      );
      await expect(
        readCode(() =>
          intakeFindUnique.mockResolvedValue(
            makeIntake({ workflowStatus: 'HUMAN_REVIEW_REQUIRED' }),
          ),
        ),
      ).resolves.toBe('BOOK_CREATION_INTAKE_NOT_APPROVED');
      await expect(
        readCode(() => {
          intakeFindUnique.mockResolvedValue(makeIntake());
          reviewFindUnique.mockResolvedValue(
            makeReview({
              rightsProfile: {
                id: 'profile-1',
                rightsIntakeId: 'intake-1',
                isCurrent: true,
                status: 'APPROVED',
                publicationGate: 'BLOCK',
              },
            }),
          );
        }),
      ).resolves.toBe('BOOK_CREATION_PUBLICATION_GATE_BLOCK');
      await expect(
        readCode(() => {
          intakeFindUnique.mockResolvedValue(makeIntake());
          reviewFindUnique.mockResolvedValue(makeReview());
          (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
          (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
            id: 'book-1',
          });
        }),
      ).resolves.toBe('BOOK_CREATION_SLUG_TAKEN');
    });

    it('should throw ConflictException if slug already exists', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({ id: 'book-1' });

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw BadRequestException if version language not in targetLanguages', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake({ targetLanguages: ['en'] }),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.createBookFromApprovedClearance(
          'intake-1',
          makeDto({
            versions: [
              {
                language: 'fr',
                title: 'Test',
                author: 'Test',
                description: 'Test',
                coverImageUrl: 'https://example.com/cover.jpg',
                type: 'text',
                isFree: true,
              },
            ],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create Book with rights links', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            rightsIntakeId: 'intake-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      const result = await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.book.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsIntakeId: 'intake-1',
          currentRightsProfileId: 'profile-1',
          approvedRightsReviewId: 'review-1',
        }),
      });
      expect(result.book.rightsIntakeId).toBe('intake-1');
    });

    it('should create BookVersion in draft status', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'draft',
        }),
      });
    });

    it('should fill rightsAllowedCountryCodes', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', accessPolicy: 'ALLOW', finalStatus: 'ALLOWED' },
        { countryCode: 'GB', accessPolicy: 'ALLOW', finalStatus: 'ALLOWED' },
      ]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsAllowedCountryCodes: ['US', 'GB'],
        }),
      });
    });

    it('should fill rightsBlockedCountryCodes', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'RU', accessPolicy: 'BLOCK', finalStatus: 'BLOCKED' },
      ]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsBlockedCountryCodes: ['RU'],
        }),
      });
    });

    it('should fill rightsLicenseRequiredCountryCodes', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'DE', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'LICENSE_REQUIRED' },
      ]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsLicenseRequiredCountryCodes: ['DE'],
        }),
      });
    });

    it('should fill rightsRequiredActions', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      // WP-H: действия читаются один раз — только для слепка прав; проверки на блокирующее
      // действие в этом пути больше нет.
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        {
          id: 'action-1',
          actionType: 'LICENSE_CHECK',
          status: 'PENDING',
          descriptionRu: 'Проверка лицензии',
          affectedCountryCodes: ['US'],
          isBlocking: false,
        },
      ]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsRequiredActions: expect.arrayContaining([
            expect.objectContaining({
              id: 'action-1',
              actionType: 'LICENSE_CHECK',
            }),
          ]),
        }),
      });
    });

    it('should update intake to BOOK_CREATED', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.rightsIntake.update).toHaveBeenCalledWith({
        where: { id: 'intake-1' },
        data: {
          workflowStatus: 'BOOK_CREATED',
          createdBookId: 'book-1',
        },
      });
    });

    it('should write createdBookId to intake', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.rightsIntake.update).toHaveBeenCalledWith({
        where: { id: 'intake-1' },
        data: expect.objectContaining({
          createdBookId: 'book-1',
        }),
      });
    });

    it('should rollback transaction on version creation error', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = {
        book: { create: jest.fn().mockResolvedValue({ id: 'book-1', slug: 'test-book' }) },
        bookVersion: { create: jest.fn().mockRejectedValue(new Error('DB Error')) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        'DB Error',
      );
    });
  });
  // Phase 15: license snapshot on created versions
  describe('license snapshot', () => {
    const licenseRow = () => ({
      id: 'lic-1',
      licenseKey: 'license:penguin-2019',
      licenseType: 'DIRECT_LICENSE',
      status: 'ACTIVE',
      title: 'Лицензия',
      licensor: 'Penguin',
      isPerpetual: true,
      expiresAt: null,
      effectiveFrom: null,
      revokedAt: null,
      territoryScope: 'COUNTRY_LIST',
      countryCodes: ['DE'],
      excludedCountryCodes: null,
      languageCodes: null,
      mediaFormats: null,
      attributionRequired: false,
      requiredAttributionText: null,
      translationAllowed: true,
      sublicensingAllowed: true,
    });

    const arrange = (options: { licensed: boolean }) => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { countryCode: 'US', accessPolicy: 'ALLOW', finalStatus: 'ALLOWED_BY_LICENSE' },
        { countryCode: 'DE', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'LICENSE_REQUIRED' },
      ]);

      if (options.licensed) {
        (prisma['rightsLicenseLink'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
          { rightsLicenseId: 'lic-1' },
        ]);
        (prisma['rightsLicense'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
          licenseRow(),
        ]);
      }

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
        rightsLicenseLink: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      return txStub;
    };

    it('treats ALLOWED_BY_LICENSE countries as allowed markets', async () => {
      const txStub = arrange({ licensed: true });

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsAllowedCountryCodes: ['US'],
          rightsLicenseRequiredCountryCodes: ['DE'],
        }),
      });
    });

    it('writes the license snapshot and sets APPROVED_WITH_LICENSES when covered', async () => {
      const txStub = arrange({ licensed: true });

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsStatus: 'APPROVED_WITH_LICENSES',
          rightsLicenseCoverageStatus: 'COVERED',
          rightsLicenseIds: ['lic-1'],
          rightsLicenseUncoveredCountryCodes: [],
        }),
      });
      expect(txStub.rightsLicenseLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            linkType: 'BOOK_VERSION',
            bookVersionId: 'version-1',
            rightsLicenseId: 'lic-1',
          }),
        }),
      );
    });

    it('keeps APPROVED_WITH_LICENSE_LIMITATIONS when no license covers the market', async () => {
      const txStub = arrange({ licensed: false });

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsStatus: 'APPROVED_WITH_LICENSE_LIMITATIONS',
          rightsLicenseCoverageStatus: 'NOT_COVERED',
          rightsLicenseUncoveredCountryCodes: ['DE'],
        }),
      });
      expect(txStub.rightsLicenseLink.create).not.toHaveBeenCalled();
    });
  });

  /**
   * WP-A.1. `ALLOW_AFTER_GEO_CONFIGURATION` без единой закрытой страны поднимал
   * `rightsGeoBlockRequired`, после чего гейт требовал правило для страны, которой нет в списке:
   * тупик без выхода. Флаг теперь поднимает только закрытый рынок.
   */
  describe('WP-A.1 geo-block flag follows the closed markets', () => {
    const arrange = (options: {
      publicationGate: string;
      territories: Array<Record<string, unknown>>;
    }) => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview({
          rightsProfile: {
            id: 'profile-1',
            rightsIntakeId: 'intake-1',
            isCurrent: true,
            status: 'APPROVED',
            publicationGate: options.publicationGate,
          },
        }),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue(
        options.territories,
      );

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      return txStub;
    };

    it('leaves the flag down when the clearance closed no country', async () => {
      const txStub = arrange({
        publicationGate: 'ALLOW_AFTER_GEO_CONFIGURATION',
        territories: [{ countryCode: 'US', accessPolicy: 'ALLOW', finalStatus: 'ALLOWED' }],
      });

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsGeoBlockRequired: false,
          rightsStatus: 'APPROVED_WITH_GEO_RESTRICTIONS',
        }),
      });
    });

    it('raises the flag as soon as one country is closed', async () => {
      const txStub = arrange({
        publicationGate: 'ALLOW_AFTER_GEO_CONFIGURATION',
        territories: [
          { countryCode: 'US', accessPolicy: 'ALLOW', finalStatus: 'ALLOWED' },
          { countryCode: 'RU', accessPolicy: 'BLOCK', finalStatus: 'BLOCKED' },
        ],
      });

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsGeoBlockRequired: true,
          rightsBlockedCountryCodes: ['RU'],
        }),
      });
    });
  });

  /**
   * WP-8.1 (регрессия, найдена в CI). Участники версии входят в content hash, а baseline
   * снимался до их проекции из профиля — живой хеш сразу расходился со снимком, и книга,
   * созданная из клиренса, не проходила гейт с `RIGHTS_CONTENT_HASH_CHANGED`.
   */
  describe('content hash baseline vs projected contributors', () => {
    const arrangeWithContributor = () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const order: string[] = [];

      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            rightsIntakeId: 'intake-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: {
          create: jest.fn().mockResolvedValue({ id: 'version-1', language: 'en', type: 'text' }),
        },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
        rightsProfileContributor: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'rpc-1',
              personId: 'person-1',
              role: 'AUTHOR',
              displayName: 'Test Author',
              creditedName: 'Test Author',
              rightsComponent: null,
            },
          ]),
        },
        bookVersionContributor: {
          create: jest.fn().mockImplementation(() => {
            order.push('contributor');
            return Promise.resolve({ id: 'bvc-1' });
          }),
        },
      };

      (mockRightsContentHashService.initializeVersionBaseline as jest.Mock).mockImplementation(
        () => {
          order.push('baseline');
          return Promise.resolve({});
        },
      );

      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));

      return { txStub, order };
    };

    it('projects contributors before taking the baseline', async () => {
      const { txStub, order } = arrangeWithContributor();

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      expect(txStub.bookVersionContributor.create).toHaveBeenCalled();
      // Порядок и есть проверяемое свойство: baseline снимается уже с участниками.
      expect(order).toEqual(['contributor', 'baseline']);
    });
  });

  // ---------------------------------------------------------------------------
  // WP-L.1: описание и обложка перестали быть обязательными в этом канале.
  // ---------------------------------------------------------------------------
  describe('optional content fields (WP-L.1)', () => {
    const arrangeCreate = () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const bookVersionCreate = jest
        .fn()
        .mockResolvedValue({ id: 'version-1', language: 'en', type: 'text' });
      const txStub = {
        book: {
          create: jest.fn().mockResolvedValue({
            id: 'book-1',
            slug: 'test-book',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: { create: bookVersionCreate },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      return bookVersionCreate;
    };

    it('writes empty strings when the request carries no description and no cover', async () => {
      const bookVersionCreate = arrangeCreate();
      const dto = makeDto();
      delete dto.versions[0].description;
      delete dto.versions[0].coverImageUrl;

      await service.createBookFromApprovedClearance('intake-1', dto);

      // Колонки `NOT NULL` без дефолта (инцидент R4-01): `undefined` уронил бы вставку.
      const data = bookVersionCreate.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['description']).toBe('');
      expect(data['coverImageUrl']).toBe('');
      expect(data['status']).toBe('draft');
    });

    // Обратная сторона: переданный контент по-прежнему записывается как есть — будущий агент
    // переноса из Gutenberg пришлёт описание и обложку сразу.
    it('keeps the description and the cover when the request does carry them', async () => {
      const bookVersionCreate = arrangeCreate();

      await service.createBookFromApprovedClearance('intake-1', makeDto());

      const data = bookVersionCreate.mock.calls[0][0].data as Record<string, unknown>;
      expect(data['description']).toBe('Test Description');
      expect(data['coverImageUrl']).toBe('https://example.com/cover.jpg');
    });
  });

  // ---------------------------------------------------------------------------
  // WP-L.2: привязка клиренса к уже существующей книге.
  // ---------------------------------------------------------------------------
  describe('attaching the clearance to an existing book (WP-L.2)', () => {
    const existingBook = {
      id: 'book-9',
      slug: 'test-book',
      currentRightsProfileId: null,
      approvedRightsReviewId: null,
    };

    const arrangeAttach = (
      bookOverrides: Record<string, unknown> = {},
      versions: Array<Record<string, unknown>> = [
        { id: 'version-9', language: 'en', type: 'text' },
      ],
    ) => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        ...existingBook,
        ...bookOverrides,
      });
      (prisma['bookVersion'] as Record<string, jest.Mock>).findMany.mockResolvedValue(versions);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const txStub = {
        book: {
          create: jest.fn(),
          update: jest.fn().mockResolvedValue({
            ...existingBook,
            ...bookOverrides,
            currentRightsProfileId: 'profile-1',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        bookVersion: {
          create: jest.fn(),
          update: jest.fn().mockResolvedValue({ id: 'version-9', language: 'en', type: 'text' }),
        },
        rightsIntake: { update: jest.fn().mockResolvedValue({}) },
        rightsProfileContributor: { findMany: jest.fn().mockResolvedValue([]) },
        bookVersionContributor: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
      };
      (prisma['$transaction'] as jest.Mock).mockImplementation((fn) => Promise.resolve(fn(txStub)));
      return txStub;
    };

    const attachDto = () =>
      ({ slug: 'test-book', attachToExistingBook: true }) as CreateBookFromClearanceDto;

    it('binds the profile to the existing book instead of creating a duplicate', async () => {
      const txStub = arrangeAttach();

      const result = await service.createBookFromApprovedClearance('intake-1', attachDto());

      expect(txStub.book.create).not.toHaveBeenCalled();
      expect(txStub.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'book-9' },
          data: expect.objectContaining({
            currentRightsProfileId: 'profile-1',
            approvedRightsReviewId: 'review-1',
            rightsIntakeId: 'intake-1',
          }),
        }),
      );
      expect(result.rightsProfileId).toBe('profile-1');
    });

    it('writes the rights snapshot onto the existing versions without touching their content', async () => {
      const txStub = arrangeAttach();

      await service.createBookFromApprovedClearance('intake-1', attachDto());

      expect(txStub.bookVersion.create).not.toHaveBeenCalled();
      const call = txStub.bookVersion.update.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: 'version-9' });
      expect(call.data['rightsProfileId']).toBe('profile-1');
      // Контент существующей версии привязка прав не трогает.
      expect(call.data).not.toHaveProperty('title');
      expect(call.data).not.toHaveProperty('description');
      expect(call.data).not.toHaveProperty('coverImageUrl');
      expect(call.data).not.toHaveProperty('status');
    });

    it('takes a content hash baseline for the attached version', async () => {
      arrangeAttach();

      await service.createBookFromApprovedClearance('intake-1', attachDto());

      const calls = (mockRightsContentHashService.initializeVersionBaseline as jest.Mock).mock
        .calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('version-9');
      expect(calls[0][1]).toBe('INITIAL_VERSION_SNAPSHOT');
    });

    it('leaves the contributors of an existing version alone', async () => {
      const txStub = arrangeAttach();
      txStub.bookVersionContributor.count.mockResolvedValue(2);

      await service.createBookFromApprovedClearance('intake-1', attachDto());

      expect(txStub.bookVersionContributor.create).not.toHaveBeenCalled();
    });

    it('covers only the versions whose language the clearance assessed', async () => {
      const txStub = arrangeAttach({}, [
        { id: 'version-en', language: 'en', type: 'text' },
        { id: 'version-de', language: 'de', type: 'text' },
      ]);

      await service.createBookFromApprovedClearance('intake-1', attachDto());

      const touched = txStub.bookVersion.update.mock.calls.map(
        (call) => (call[0] as { where: { id: string } }).where.id,
      );
      expect(touched).toEqual(['version-en']);
    });

    it('refuses when the book carries another live rights profile', async () => {
      arrangeAttach({ currentRightsProfileId: 'profile-other' });

      await expect(
        service.createBookFromApprovedClearance('intake-1', attachDto()),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses when the book has no version in a target language', async () => {
      arrangeAttach({}, [{ id: 'version-de', language: 'de', type: 'text' }]);

      await expect(
        service.createBookFromApprovedClearance('intake-1', attachDto()),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses when the book does not exist', async () => {
      arrangeAttach();
      (prisma['book'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(
        service.createBookFromApprovedClearance('intake-1', attachDto()),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses when versions are passed along with the attach flag', async () => {
      arrangeAttach();
      const dto = makeDto({ attachToExistingBook: true });

      await expect(service.createBookFromApprovedClearance('intake-1', dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    // Строгая сторона не тронута: без флага занятый слаг по-прежнему конфликт.
    it('still refuses a taken slug when not attaching', async () => {
      arrangeAttach();

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
