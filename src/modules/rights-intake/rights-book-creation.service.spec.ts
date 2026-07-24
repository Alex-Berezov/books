import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RightsBookCreationService } from './rights-book-creation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookFromClearanceDto } from './dto/create-book-from-clearance.dto';

const createPrismaStub = () => {
  const stub: Record<string, unknown> = {
    book: { create: jest.fn(), findUnique: jest.fn() },
    bookVersion: { create: jest.fn() },
    rightsIntake: { findUnique: jest.fn(), update: jest.fn() },
    rightsReview: { findUnique: jest.fn() },
    rightsProfile: { findFirst: jest.fn() },
    rightsAction: { findMany: jest.fn() },
    territoryDecision: { findMany: jest.fn() },
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

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new RightsBookCreationService(prisma as unknown as PrismaService);
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

    it('should throw BadRequestException if there are unresolved blocking actions', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { id: 'action-1', isBlocking: true, status: 'PENDING' },
      ]);

      await expect(service.createBookFromApprovedClearance('intake-1', makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow creation if blocking action is COMPLETED', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      const findManyMock = (prisma['rightsAction'] as Record<string, jest.Mock>).findMany;
      findManyMock
        .mockResolvedValueOnce([{ id: 'action-1', isBlocking: true, status: 'COMPLETED' }])
        .mockResolvedValueOnce([
          {
            id: 'action-1',
            isBlocking: true,
            status: 'COMPLETED',
            actionType: 'LICENSE_CHECK',
            descriptionRu: 'Test',
            affectedCountryCodes: [],
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

      const result = await service.createBookFromApprovedClearance('intake-1', makeDto());
      expect(result).toBeDefined();
    });

    it('should allow creation if blocking action is WAIVED', async () => {
      (prisma['rightsIntake'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeIntake(),
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeReview(),
      );
      const findManyMock = (prisma['rightsAction'] as Record<string, jest.Mock>).findMany;
      findManyMock
        .mockResolvedValueOnce([{ id: 'action-1', isBlocking: true, status: 'WAIVED' }])
        .mockResolvedValueOnce([
          {
            id: 'action-1',
            isBlocking: true,
            status: 'WAIVED',
            actionType: 'LICENSE_CHECK',
            descriptionRu: 'Test',
            affectedCountryCodes: [],
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

      const result = await service.createBookFromApprovedClearance('intake-1', makeDto());
      expect(result).toBeDefined();
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
      const findManyMock = (prisma['rightsAction'] as Record<string, jest.Mock>).findMany;
      findManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
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
});
