import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RightsContentHashService } from './rights-content-hash.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RIGHTS_CONTENT_HASH_ALGORITHM_VERSION } from './rights-content-hash.util';

const mockPrisma = {
  bookVersion: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
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
  mediaAsset: {
    findFirst: jest.fn(),
  },
  bookVersionContributor: {
    findMany: jest.fn(),
  },
  rightsProfileContributor: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('RightsContentHashService', () => {
  let service: RightsContentHashService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.mediaAsset.findFirst.mockResolvedValue(null);
    mockPrisma.bookVersionContributor.findMany.mockResolvedValue([]);
    mockPrisma.rightsProfileContributor.findMany.mockResolvedValue([]);

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
    contributors: [],
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
      contributors: [],
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
      mockPrisma.bookVersion.findMany.mockResolvedValue([]);
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
      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledTimes(1);
    });

    /**
     * WP-7: состав входа хеша изменился вместе с моделью прав. Если бы несовпадение
     * baseline'а прошлой версии алгоритма считалось расхождением, выкат пакета отправил бы
     * в `STALE` клиренс всех уже опубликованных книг — по причине, которой не было.
     */
    describe('baseline taken under a previous algorithm version', () => {
      const setupPreviousAlgorithmBaseline = (recheckRequired = false) => {
        mockPrisma.bookVersion.findUnique.mockResolvedValue({
          id: 'version-1',
          rightsContentHash: 'v1-hash',
          rightsContentHashAlgorithmVersion: 'RIGHTS_CONTENT_HASH_V1',
          rightsRecheckRequired: recheckRequired,
          rightsStaleReasonCode: recheckRequired ? 'CHAPTER_UPDATED' : null,
          rightsStaleReasonRu: recheckRequired ? 'Изменена глава' : null,
        });
        jest.spyOn(service, 'computeVersionHash').mockResolvedValue({
          versionId: 'version-1',
          rightsProfileId: 'profile-1',
          approvedRightsReviewId: 'review-1',
          hash: 'v2-hash',
          algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
          calculatedAt: new Date().toISOString(),
          input: {},
        });
        mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });
      };

      it('does not mark the version stale', async () => {
        setupPreviousAlgorithmBaseline();

        const result = await service.checkVersionStaleness(
          'version-1',
          'MANUAL_HASH_CHECK',
          null,
          true,
        );

        expect(result.matchesBaseline).toBe(true);
        expect(result.isStale).toBe(false);
        expect(result.recheckRequired).toBe(false);
        expect(mockPrisma.rightsReview.update).not.toHaveBeenCalled();
      });

      it('re-takes the baseline under the new algorithm version and logs it as not stale', async () => {
        setupPreviousAlgorithmBaseline();

        await service.checkVersionStaleness('version-1', 'MANUAL_HASH_CHECK', null, true);

        expect(mockPrisma.bookVersion.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'version-1' },
            data: expect.objectContaining({
              rightsContentHash: 'v2-hash',
              rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
            }),
          }),
        );
        expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              staleMarked: false,
              reasonCode: 'HASH_ALGORITHM_CHANGED',
              previousHash: 'v1-hash',
              currentHash: 'v2-hash',
            }),
          }),
        );
      });

      it('does not clear a stale mark that was already there', async () => {
        setupPreviousAlgorithmBaseline(true);

        const result = await service.checkVersionStaleness(
          'version-1',
          'MANUAL_HASH_CHECK',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(result.recheckRequired).toBe(true);
        expect(result.reasonCode).toBe('CHAPTER_UPDATED');
        const updateData = mockPrisma.bookVersion.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(updateData.data).not.toHaveProperty('rightsRecheckRequired');
        expect(updateData.data).not.toHaveProperty('rightsStaleDetectedAt');
      });

      it('writes nothing when the check is read-only', async () => {
        setupPreviousAlgorithmBaseline();

        await service.checkVersionStaleness('version-1', 'MANUAL_HASH_CHECK', null, false);

        expect(mockPrisma.bookVersion.update).not.toHaveBeenCalled();
        expect(mockPrisma.rightsContentHashEvent.create).not.toHaveBeenCalled();
      });
    });

    /**
     * WP-7.1: права издания входят в хеш записью на язык. Смена правового статуса одного
     * языка обязана двигать хеш — иначе перевод можно подменить под старым клиренсом.
     */
    describe('edition rights per language', () => {
      const versionWithLanguages = (
        editionRights: Array<Record<string, unknown>>,
      ): Record<string, unknown> => ({
        ...baseVersion,
        rightsProfile: {
          ...baseVersion.rightsProfile,
          sourceEdition: {
            provider: 'PROJECT_GUTENBERG',
            externalId: 'id',
            sourceUrl: 'https://example.com',
            sourceTitle: 'Source',
            sourceLanguage: 'en',
            sourceTextType: 'ORIGINAL_TEXT',
            gutenbergStatus: null,
            status: 'OK',
            editionRights,
          },
        },
      });

      const enRow = {
        languageCode: 'en',
        status: 'ALLOWED',
        legalBasisRu: null,
        notesRu: null,
        translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
        translationSourceLanguage: null,
        requiresGeoBlock: false,
      };
      const ruRow = {
        languageCode: 'ru',
        status: 'ALLOWED',
        legalBasisRu: null,
        notesRu: null,
        translationOrigin: 'BIBLIARIS_TRANSLATION_FROM_ORIGINAL',
        translationSourceLanguage: 'en',
        requiresGeoBlock: false,
      };

      const hashOf = async (editionRights: Array<Record<string, unknown>>) => {
        mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithLanguages(editionRights));
        return (await service.computeVersionHash('version-1')).hash;
      };

      it('changes the hash when the legal status of one language changes', async () => {
        const before = await hashOf([enRow, ruRow]);
        const after = await hashOf([enRow, { ...ruRow, status: 'BLOCKED' }]);

        expect(before).not.toBe(after);
      });

      it('changes the hash when a language edition is added', async () => {
        const before = await hashOf([enRow]);
        const after = await hashOf([enRow, ruRow]);

        expect(before).not.toBe(after);
      });

      it('does not depend on the order the database returned the languages in', async () => {
        const straight = await hashOf([enRow, ruRow]);
        const reversed = await hashOf([ruRow, enRow]);

        expect(straight).toBe(reversed);
      });
    });

    /**
     * WP-8.1 (R1-01): участники — юридически значимый вход. Год смерти переводчика решает,
     * находится ли перевод в public domain, поэтому подмена участника обязана двигать хеш.
     */
    describe('contributors', () => {
      const translator = {
        id: 'bvc-1',
        role: 'TRANSLATOR',
        roleOtherRu: null,
        displayOrder: 0,
        isPrimary: false,
        creditedName: 'И. Иванов',
        creditedLanguage: 'ru',
        contributionNoteRu: null,
        confidence: 'HIGH',
        personId: 'person-1',
        person: {
          id: 'person-1',
          canonicalName: 'Иванов Иван',
          birthYear: 1870,
          deathYear: 1940,
          publicDomainFromYear: 2011,
          nationalityCountryCode: 'RU',
        },
      };
      const author = {
        ...translator,
        id: 'bvc-2',
        role: 'AUTHOR',
        displayOrder: 1,
        personId: 'person-2',
        creditedName: 'П. Петров',
        person: {
          id: 'person-2',
          canonicalName: 'Петров Пётр',
          birthYear: 1860,
          deathYear: 1930,
          publicDomainFromYear: 2001,
          nationalityCountryCode: 'RU',
        },
      };

      const hashOf = async (contributors: Array<Record<string, unknown>>) => {
        mockPrisma.bookVersion.findUnique.mockResolvedValue({ ...baseVersion, contributors });
        return (await service.computeVersionHash('version-1')).hash;
      };

      it('changes the hash when a translator is replaced', async () => {
        const before = await hashOf([translator]);
        const after = await hashOf([
          {
            ...translator,
            personId: 'person-3',
            person: {
              id: 'person-3',
              canonicalName: 'Сидоров Семён',
              birthYear: 1920,
              deathYear: 1990,
              publicDomainFromYear: 2061,
              nationalityCountryCode: 'RU',
            },
          },
        ]);

        expect(before).not.toBe(after);
      });

      it('changes the hash when the death year of a contributor changes', async () => {
        const before = await hashOf([translator]);
        const after = await hashOf([
          { ...translator, person: { ...translator.person, deathYear: 1990 } },
        ]);

        expect(before).not.toBe(after);
      });

      it('changes the hash when a contributor is added or removed', async () => {
        const one = await hashOf([translator]);
        const two = await hashOf([translator, author]);

        expect(one).not.toBe(two);
      });

      it('does not depend on the order the database returned the contributors in', async () => {
        const straight = await hashOf([translator, author]);
        const reversed = await hashOf([author, translator]);

        expect(straight).toBe(reversed);
      });

      it('does not change the hash on a pure reorder of the credits', async () => {
        const before = await hashOf([translator, author]);
        const after = await hashOf([
          { ...translator, displayOrder: 1 },
          { ...author, displayOrder: 0, isPrimary: true },
        ]);

        expect(before).toBe(after);
      });

      it('changes the hash when a rights profile contributor changes', async () => {
        const profileContributor = {
          id: 'rpc-1',
          role: 'TRANSLATOR',
          roleOtherRu: null,
          rightsComponentId: null,
          personId: 'person-1',
          displayName: 'Иванов Иван',
          canonicalName: 'Иванов Иван',
          creditedName: 'И. Иванов',
          birthYear: 1870,
          deathYear: 1940,
          publicDomainFromYear: 2011,
          nationalityCountryCode: 'RU',
          confidence: 'HIGH',
        };
        const withContributor = (contributors: Array<Record<string, unknown>>) => ({
          ...baseVersion,
          rightsProfile: { ...baseVersion.rightsProfile, contributors },
        });

        mockPrisma.bookVersion.findUnique.mockResolvedValue(withContributor([profileContributor]));
        const before = (await service.computeVersionHash('version-1')).hash;

        mockPrisma.bookVersion.findUnique.mockResolvedValue(
          withContributor([{ ...profileContributor, deathYear: 1990 }]),
        );
        const after = (await service.computeVersionHash('version-1')).hash;

        expect(before).not.toBe(after);
      });
    });

    /**
     * WP-8.2 (R1-04): обложка хешировалась по URL, поэтому подмена файла по тому же адресу
     * оставалась невидимой. Контрольная сумма берётся из `MediaAsset`, найденного по URL.
     */
    describe('cover file checksum', () => {
      const asset = (hash: string | null) => ({
        id: 'media-cover',
        key: 'covers/cover.jpg',
        url: 'https://example.com/cover.jpg',
        contentType: 'image/jpeg',
        size: 2048,
        hash,
        isDeleted: false,
      });

      it('changes the hash when the cover file is replaced at the same URL', async () => {
        mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);

        mockPrisma.mediaAsset.findFirst.mockResolvedValue(asset('sha-old'));
        const before = (await service.computeVersionHash('version-1')).hash;

        mockPrisma.mediaAsset.findFirst.mockResolvedValue(asset('sha-new'));
        const after = (await service.computeVersionHash('version-1')).hash;

        expect(before).not.toBe(after);
      });

      it('looks the cover asset up by its URL', async () => {
        mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
        mockPrisma.mediaAsset.findFirst.mockResolvedValue(asset('sha-old'));

        await service.computeVersionHash('version-1');

        expect(mockPrisma.mediaAsset.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ url: 'https://example.com/cover.jpg' }),
          }),
        );
      });

      it('still computes a hash when the cover has no media asset', async () => {
        mockPrisma.bookVersion.findUnique.mockResolvedValue(baseVersion);
        mockPrisma.mediaAsset.findFirst.mockResolvedValue(null);

        const result = await service.computeVersionHash('version-1');

        expect(result.hash).toHaveLength(64);
      });
    });
  });

  /**
   * WP-8.1: правка данных персоны и связей профиля не проходит через версию, поэтому
   * пересчёт разворачивается от участника ко всем затронутым версиям.
   */
  describe('checkStalenessForPerson', () => {
    let checkVersionStaleness: jest.SpyInstance;

    beforeEach(() => {
      checkVersionStaleness = jest.spyOn(service, 'checkVersionStaleness').mockResolvedValue({
        versionId: 'version-1',
        baselineHash: 'old',
        currentHash: 'new',
        algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        matchesBaseline: false,
        isStale: true,
        recheckRequired: true,
        reasonCode: 'CONTRIBUTOR_PERSON_CHANGED',
        reasonRu: null,
        checkedAt: new Date().toISOString(),
      });
    });

    it('checks every version the person contributes to', async () => {
      mockPrisma.bookVersionContributor.findMany.mockResolvedValue([
        { bookVersionId: 'version-1' },
        { bookVersionId: 'version-2' },
      ]);
      mockPrisma.rightsProfileContributor.findMany.mockResolvedValue([]);
      mockPrisma.bookVersion.findMany.mockResolvedValue([]);

      const result = await service.checkStalenessForPerson(
        'person-1',
        'CONTRIBUTOR_PERSON_CHANGED',
      );

      expect(result).toHaveLength(2);
      expect(checkVersionStaleness.mock.calls.map((call) => call[0] as string).sort()).toEqual([
        'version-1',
        'version-2',
      ]);
      expect(checkVersionStaleness).toHaveBeenCalledTimes(2);
      expect(checkVersionStaleness).toHaveBeenCalledWith(
        'version-1',
        'CONTRIBUTOR_PERSON_CHANGED',
        null,
        true,
        undefined,
      );
    });

    it('reaches versions through the rights profile the person is listed in', async () => {
      mockPrisma.bookVersionContributor.findMany.mockResolvedValue([]);
      mockPrisma.rightsProfileContributor.findMany.mockResolvedValue([
        { rightsProfileId: 'profile-1' },
      ]);
      mockPrisma.bookVersion.findMany.mockResolvedValue([{ id: 'version-3' }]);

      const result = await service.checkStalenessForPerson(
        'person-1',
        'CONTRIBUTOR_PERSON_CHANGED',
      );

      expect(result).toHaveLength(1);
      expect(mockPrisma.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ rightsProfileId: { in: ['profile-1'] } }),
        }),
      );
    });

    it('does nothing when the person is not linked to any version', async () => {
      mockPrisma.bookVersionContributor.findMany.mockResolvedValue([]);
      mockPrisma.rightsProfileContributor.findMany.mockResolvedValue([]);

      const result = await service.checkStalenessForPerson(
        'person-1',
        'CONTRIBUTOR_PERSON_CHANGED',
      );

      expect(result).toEqual([]);
      expect(checkVersionStaleness).not.toHaveBeenCalled();
    });
  });
});
