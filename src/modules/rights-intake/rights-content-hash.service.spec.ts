import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RightsContentHashService } from './rights-content-hash.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RIGHTS_CONTENT_HASH_ALGORITHM_VERSION } from './rights-content-hash.util';

const mockPrisma = {
  bookVersion: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  rightsReview: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  rightsProfile: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  rightsContentHashEvent: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('RightsContentHashService', () => {
  let service: RightsContentHashService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [RightsContentHashService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    service = module.get<RightsContentHashService>(RightsContentHashService);
  });

  const baseVersion = {
    id: 'version-1',
    bookId: 'book-1',
    language: 'en',
    title: 'Test Book',
    author: 'Test Author',
    description: 'A test book',
    coverImageUrl: 'https://example.com/cover.jpg',
    type: 'text',
    isFree: true,
    status: 'draft',
    slug: 'test-book',
    book: { id: 'book-1', currentRightsProfileId: 'profile-1', approvedRightsReviewId: 'review-1' },
    chapters: [],
    audioChapters: [],
    previewMedia: null,
    previewMediaId: null,
    primaryCategoryId: null,
    firstPublishedYear: null,
    editionPublishedYear: null,
    originalLanguage: null,
    copyrightStatus: null,
    authorPageUrl: null,
    authorId: null,
    characters: null,
    quotes: null,
    faq: null,
    themes: null,
    originalTitle: null,
    alternativeTitles: null,
    shortDescription: null,
    summaryShort: null,
    symbols: null,
    coverAlt: null,
    rightsProfileId: 'profile-1',
    approvedRightsReviewId: 'review-1',
    rightsStatus: 'APPROVED',
    rightsAllowedCountryCodes: [],
    rightsBlockedCountryCodes: [],
    rightsLicenseRequiredCountryCodes: [],
    rightsPendingCountryCodes: [],
    rightsRequiredActions: [],
    rightsGeoBlockRequired: false,
    rightsGeoBlockConfigured: false,
    rightsGeoBlockConfiguredAt: null,
    rightsGeoBlockNotesRu: null,
    rightsContentHash: 'existing-hash',
    rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
    rightsRecheckRequired: false,
    rightsStaleDetectedAt: null,
    rightsStaleReasonCode: null,
    rightsStaleReasonRu: null,
    rightsProfile: {
      id: 'profile-1',
      status: 'APPROVED',
      isCurrent: true,
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Summary',
      conclusionRu: 'Conclusion',
      nextReviewAt: null,
      sourceEdition: null,
      components: [],
      territoryDecisions: [],
      evidence: [],
      actions: [],
    },
    approvedRightsReview: {
      id: 'review-1',
      status: 'HUMAN_APPROVED',
      schemaVersion: '1.0',
      reviewerType: 'EXTERNAL_CHATGPT_AGENT',
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Summary',
      conclusionRu: 'Conclusion',
      nextReviewAt: null,
      rightsReviewImport: null,
    },
  };

  describe('computeVersionHash', () => {
    it('should throw NotFoundException for unknown version', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(null);
      await expect(service.computeVersionHash('unknown')).rejects.toThrow(NotFoundException);
    });

    it('should include version metadata in hash', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
      const result = await service.computeVersionHash('version-1');
      expect(result.hash).toBeTruthy();
      expect(result.hash).toHaveLength(64);
      expect(result.versionId).toBe('version-1');
      expect(result.algorithmVersion).toBe(RIGHTS_CONTENT_HASH_ALGORITHM_VERSION);
    });

    it('should change hash when title changes', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = { ...baseVersion, title: 'Different Title' };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when coverImageUrl changes', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        coverImageUrl: 'https://example.com/new-cover.jpg',
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when author/authorId changes', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = { ...baseVersion, author: 'New Author', authorId: 'author-2' };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when chapter content changes', async () => {
      const versionWithChapters = {
        ...baseVersion,
        chapters: [{ number: 1, title: 'Chapter 1', content: 'Original content' }],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithChapters);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        chapters: [{ number: 1, title: 'Chapter 1', content: 'Modified content' }],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when chapter order changes', async () => {
      const versionWithChapters = {
        ...baseVersion,
        chapters: [
          { number: 1, title: 'Ch1', content: 'First' },
          { number: 2, title: 'Ch2', content: 'Second' },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithChapters);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const reorderedVersion = {
        ...baseVersion,
        chapters: [
          { number: 2, title: 'Ch2', content: 'Second' },
          { number: 1, title: 'Ch1', content: 'First' },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(reorderedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when chapter is added', async () => {
      const versionWithOneChapter = {
        ...baseVersion,
        chapters: [{ number: 1, title: 'Ch1', content: 'Content' }],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithOneChapter);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const versionWithTwoChapters = {
        ...baseVersion,
        chapters: [
          { number: 1, title: 'Ch1', content: 'Content' },
          { number: 2, title: 'Ch2', content: 'More' },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithTwoChapters);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when chapter is removed', async () => {
      const versionWithTwoChapters = {
        ...baseVersion,
        chapters: [
          { number: 1, title: 'Ch1', content: 'Content' },
          { number: 2, title: 'Ch2', content: 'More' },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithTwoChapters);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const versionWithOneChapter = {
        ...baseVersion,
        chapters: [{ number: 1, title: 'Ch1', content: 'Content' }],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithOneChapter);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when audioUrl changes', async () => {
      const versionWithAudio = {
        ...baseVersion,
        audioChapters: [
          {
            number: 1,
            title: 'Audio 1',
            audioUrl: 'https://old.mp3',
            duration: 300,
            description: null,
            transcript: null,
            mediaId: null,
            media: null,
          },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithAudio);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        audioChapters: [
          {
            number: 1,
            title: 'Audio 1',
            audioUrl: 'https://new.mp3',
            duration: 300,
            description: null,
            transcript: null,
            mediaId: null,
            media: null,
          },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when audio transcript changes', async () => {
      const versionWithAudio = {
        ...baseVersion,
        audioChapters: [
          {
            number: 1,
            title: 'Audio 1',
            audioUrl: 'https://test.mp3',
            duration: 300,
            description: null,
            transcript: 'Original transcript',
            mediaId: null,
            media: null,
          },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithAudio);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        audioChapters: [
          {
            number: 1,
            title: 'Audio 1',
            audioUrl: 'https://test.mp3',
            duration: 300,
            description: null,
            transcript: 'Modified transcript',
            mediaId: null,
            media: null,
          },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when media hash changes', async () => {
      const versionWithMedia = {
        ...baseVersion,
        audioChapters: [
          {
            number: 1,
            title: 'Audio 1',
            audioUrl: 'https://test.mp3',
            duration: 300,
            description: null,
            transcript: null,
            mediaId: 'media-1',
            media: {
              id: 'media-1',
              key: 'audio1',
              url: 'https://test.mp3',
              contentType: 'audio/mpeg',
              size: 1000,
              duration: 300,
              hash: 'old-hash',
              isDeleted: false,
            },
          },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithMedia);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        audioChapters: [
          {
            number: 1,
            title: 'Audio 1',
            audioUrl: 'https://test.mp3',
            duration: 300,
            description: null,
            transcript: null,
            mediaId: 'media-1',
            media: {
              id: 'media-1',
              key: 'audio1',
              url: 'https://test.mp3',
              contentType: 'audio/mpeg',
              size: 1000,
              duration: 300,
              hash: 'new-hash',
              isDeleted: false,
            },
          },
        ],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when rights country snapshot changes', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        rightsBlockedCountryCodes: ['RU'],
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when source edition externalId changes', async () => {
      const versionWithSource = {
        ...baseVersion,
        rightsProfile: {
          ...baseVersion.rightsProfile,
          sourceEdition: {
            provider: 'PROJECT_GUTENBERG',
            externalId: 'old-id',
            sourceUrl: 'https://old.url',
            sourceTitle: 'Source',
            sourceLanguage: 'en',
            sourceTextType: 'ORIGINAL_TEXT',
            gutenbergStatus: null,
            status: 'OK',
            editionRights: null,
          },
        },
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithSource);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        rightsProfile: {
          ...baseVersion.rightsProfile,
          sourceEdition: {
            provider: 'PROJECT_GUTENBERG',
            externalId: 'new-id',
            sourceUrl: 'https://new.url',
            sourceTitle: 'Source',
            sourceLanguage: 'en',
            sourceTextType: 'ORIGINAL_TEXT',
            gutenbergStatus: null,
            status: 'OK',
            editionRights: null,
          },
        },
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when reportJsonSha256 changes', async () => {
      const versionWithImport = {
        ...baseVersion,
        approvedRightsReview: {
          ...baseVersion.approvedRightsReview,
          rightsReviewImport: {
            schemaVersion: '1.0',
            sourceFileName: 'report.json',
            reportJsonSha256: 'old-json-hash',
            reportMarkdownSha256: 'old-md-hash',
            rawAgentOutputSha256: null,
          },
        },
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithImport);
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      const modifiedVersion = {
        ...baseVersion,
        approvedRightsReview: {
          ...baseVersion.approvedRightsReview,
          rightsReviewImport: {
            schemaVersion: '1.0',
            sourceFileName: 'report.json',
            reportJsonSha256: 'new-json-hash',
            reportMarkdownSha256: 'old-md-hash',
            rawAgentOutputSha256: null,
          },
        },
      };
      mockPrisma.bookVersion.findUnique.mockResolvedValue(modifiedVersion);
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('initializeVersionBaseline', () => {
    it('should save hash to BookVersion', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
      mockPrisma.bookVersion.update.mockResolvedValue(baseVersion);
      mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });

      const result = await service.initializeVersionBaseline(
        'version-1',
        'INITIAL_VERSION_SNAPSHOT',
      );

      expect(result.hash).toBeTruthy();
      expect(mockPrisma.bookVersion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'version-1' },
          data: expect.objectContaining({
            rightsContentHash: result.hash,
            rightsRecheckRequired: false,
          }),
        }),
      );
      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalled();
    });
  });

  describe('checkVersionStaleness', () => {
    it('should return matchesBaseline true for unchanged version', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue({
        id: 'version-1',
        rightsContentHash: 'test-hash',
        rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        rightsRecheckRequired: false,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
      });
      // Mock computeVersionHash to return the same hash
      const computeSpy = jest.spyOn(service, 'computeVersionHash');
      computeSpy.mockResolvedValue({
        versionId: 'version-1',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: null,
        hash: 'test-hash',
        algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        calculatedAt: new Date().toISOString(),
        input: {},
      });

      const result = await service.checkVersionStaleness('version-1', 'BOOK_VERSION_UPDATED');

      expect(result.matchesBaseline).toBe(true);
      expect(result.isStale).toBe(false);
      expect(result.recheckRequired).toBe(false);
    });

    it('should return mismatch after content change', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue({
        id: 'version-1',
        rightsContentHash: 'original-hash',
        rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        rightsRecheckRequired: false,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
      });
      const computeSpy = jest.spyOn(service, 'computeVersionHash');
      computeSpy.mockResolvedValue({
        versionId: 'version-1',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: null,
        hash: 'different-hash',
        algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        calculatedAt: new Date().toISOString(),
        input: {},
      });

      const result = await service.checkVersionStaleness('version-1', 'BOOK_VERSION_UPDATED');

      expect(result.matchesBaseline).toBe(false);
      expect(result.isStale).toBe(true);
    });

    it('should set recheckRequired when mismatch with persist=true', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue({
        id: 'version-1',
        rightsContentHash: 'original-hash',
        rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        rightsRecheckRequired: false,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
      });
      const computeSpy = jest.spyOn(service, 'computeVersionHash');
      computeSpy.mockResolvedValue({
        versionId: 'version-1',
        rightsProfileId: null,
        approvedRightsReviewId: null,
        hash: 'different-hash',
        algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        calculatedAt: new Date().toISOString(),
        input: {},
      });

      mockPrisma.bookVersion.findUnique.mockResolvedValue({
        id: 'version-1',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        rightsStaleDetectedAt: null,
      });
      mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
        cb(mockPrisma),
      );
      mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });

      const result = await service.checkVersionStaleness(
        'version-1',
        'BOOK_VERSION_UPDATED',
        null,
        true,
      );

      expect(result.matchesBaseline).toBe(false);
      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalled();
    });
  });
});
