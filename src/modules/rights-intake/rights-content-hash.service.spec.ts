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
    findFirst: jest.fn(),
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
    // LEGACY-036: парные записи (слепок + событие) идут транзакцией. Здесь она сведена
    // к вызову коллбэка тем же двойником — атомарность проверяет отдельный describe ниже,
    // где транзакционный клиент буферизует записи и откатывает их при отказе.
    mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
      cb(mockPrisma),
    );
    mockPrisma.rightsContentHashEvent.findFirst.mockResolvedValue(null);
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

    /**
     * WP-8.3 (R3-05). До этого пакета в хеш входили только метаданные источника, поэтому
     * замена файла по тому же адресу оставалась невидимой для клиренса — тот же класс, что
     * подмена обложки до WP-8.2.
     */
    const sourceEditionWith = (sourceFileSha256: string | null) => ({
      provider: 'PROJECT_GUTENBERG',
      externalId: 'id-1',
      sourceUrl: 'https://gutenberg.org/ebooks/1',
      sourceTitle: 'Source',
      sourceLanguage: 'en',
      sourceTextType: 'ORIGINAL_TEXT',
      gutenbergStatus: null,
      status: 'OK',
      sourceFileSha256,
      editionRights: null,
    });

    const versionWithSourceFile = (sourceFileSha256: string | null) => ({
      ...baseVersion,
      rightsProfile: {
        ...baseVersion.rightsProfile,
        sourceEdition: sourceEditionWith(sourceFileSha256),
      },
    });

    it('should change hash when the source file checksum changes', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithSourceFile('a'.repeat(64)));
      const hash1 = (await service.computeVersionHash('version-1')).hash;

      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithSourceFile('b'.repeat(64)));
      const hash2 = (await service.computeVersionHash('version-1')).hash;

      expect(hash1).not.toBe(hash2);
    });

    it('should change hash when a source file appears where there was none', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithSourceFile(null));
      const hashWithout = (await service.computeVersionHash('version-1')).hash;

      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithSourceFile('c'.repeat(64)));
      const hashWith = (await service.computeVersionHash('version-1')).hash;

      expect(hashWithout).not.toBe(hashWith);
    });

    it('should expose the source file checksum in the hash input', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue(versionWithSourceFile('d'.repeat(64)));

      const { input } = await service.computeVersionHash('version-1');
      const profile = input['rightsProfile'] as Record<string, unknown>;
      const sourceEdition = profile['sourceEdition'] as Record<string, unknown>;

      expect(sourceEdition['sourceFileSha256']).toBe('d'.repeat(64));
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

    /**
     * WP-D.1: окно наполнения открывается явной отметкой в аудите. Без неё окно считается
     * закрытым, поэтому версии, заведённые до выката пакета, остаются на строгом правиле.
     */
    it('opens the draft fill window for a version created as a draft', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue({ ...baseVersion, publishedAt: null });
      mockPrisma.bookVersion.update.mockResolvedValue(baseVersion);
      mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });

      await service.initializeVersionBaseline('version-1', 'INITIAL_VERSION_SNAPSHOT');

      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reasonCode: 'DRAFT_FILL_WINDOW_OPENED' }),
        }),
      );
    });

    it('does not open the window for a version created already published', async () => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue({
        ...baseVersion,
        status: 'published',
        publishedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      mockPrisma.bookVersion.update.mockResolvedValue(baseVersion);
      mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });

      await service.initializeVersionBaseline('version-1', 'INITIAL_VERSION_SNAPSHOT');

      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reasonCode: null }) }),
      );
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
     * WP-D.1: окно наполнения черновика. Клиренс снимается ради заливки текста — и первая же
     * глава этот клиренс аннулировала. В черновике расхождение хеша переснимает baseline;
     * во всех остальных случаях правило работает как прежде.
     */
    describe('draft fill window (WP-D.1)', () => {
      /**
       * Окно открывается отметкой в аудите при заведении версии черновиком
       * (`initializeVersionBaseline`) и закрывается отметкой публикации. Здесь задаётся,
       * какие из этих отметок есть у версии.
       */
      const auditMarkers = (codes: string[]): void => {
        mockPrisma.rightsContentHashEvent.findFirst.mockImplementation(
          (args: { where: { reasonCode: string } }) =>
            Promise.resolve(
              codes.includes(args.where.reasonCode)
                ? { id: `${args.where.reasonCode}-event` }
                : null,
            ),
        );
      };

      const setupMismatch = (overrides: Record<string, unknown> = {}): void => {
        mockPrisma.bookVersion.findUnique.mockResolvedValue({
          id: 'version-1',
          status: 'draft',
          publishedAt: null,
          rightsContentHash: 'baseline-hash',
          rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
          rightsRecheckRequired: false,
          rightsStaleReasonCode: null,
          rightsStaleReasonRu: null,
          rightsStaleDetectedAt: null,
          rightsProfileId: 'profile-1',
          approvedRightsReviewId: 'review-1',
          ...overrides,
        });
        jest.spyOn(service, 'computeVersionHash').mockResolvedValue({
          versionId: 'version-1',
          rightsProfileId: 'profile-1',
          approvedRightsReviewId: 'review-1',
          hash: 'hash-with-chapter',
          algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
          calculatedAt: new Date().toISOString(),
          input: {},
        });
        mockPrisma.bookVersion.findMany.mockResolvedValue([]);
        mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });
        mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
          cb(mockPrisma),
        );
        auditMarkers(['DRAFT_FILL_WINDOW_OPENED']);
      };

      it('re-takes the baseline instead of invalidating the clearance', async () => {
        setupMismatch();

        const result = await service.checkVersionStaleness(
          'version-1',
          'CHAPTER_CREATED',
          null,
          true,
        );

        expect(mockPrisma.rightsReview.update).not.toHaveBeenCalled();
        expect(mockPrisma.rightsProfile.update).not.toHaveBeenCalled();
        expect(result.isStale).toBe(false);
        expect(result.recheckRequired).toBe(false);

        const updateData = mockPrisma.bookVersion.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(updateData.data.rightsContentHash).toBe('hash-with-chapter');
        expect(updateData.data).not.toHaveProperty('rightsRecheckRequired');
      });

      it('always writes the audit event — the compensation for the relaxation', async () => {
        setupMismatch();

        await service.checkVersionStaleness('version-1', 'CHAPTER_CREATED', 'user-1', true);

        expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              bookVersionId: 'version-1',
              trigger: 'CHAPTER_CREATED',
              previousHash: 'baseline-hash',
              currentHash: 'hash-with-chapter',
              staleMarked: false,
              reasonCode: 'DRAFT_FILL_WINDOW',
              createdByUserId: 'user-1',
            }),
          }),
        );
      });

      it('still marks a published version stale', async () => {
        setupMismatch({ status: 'published' });

        const result = await service.checkVersionStaleness(
          'version-1',
          'CHAPTER_CREATED',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(result.recheckRequired).toBe(true);
        expect(mockPrisma.rightsReview.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
        expect(mockPrisma.rightsProfile.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
      });

      it('still marks a draft stale once the window was closed by a publication', async () => {
        setupMismatch();
        auditMarkers(['DRAFT_FILL_WINDOW_OPENED', 'DRAFT_FILL_WINDOW_CLOSED']);

        const result = await service.checkVersionStaleness(
          'version-1',
          'CHAPTER_UPDATED',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(mockPrisma.rightsReview.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
      });

      /**
       * Дыра в первой редакции WP-D.1: закрытие окна опознавалось исключительно по событию
       * `DRAFT_FILL_WINDOW_CLOSED`, которое пишет только новый код публикации. У версии,
       * опубликованной до выката, такого события в базе нет, а `unpublish` обнуляет
       * `publishedAt` — значит правка главы после снятия с публикации молча переснимала
       * baseline вместо `STALE`, хотя клиренс снимался с другого текста.
       */
      it('still marks a draft stale when it was published before the window mechanism existed', async () => {
        setupMismatch();
        auditMarkers([]);

        const result = await service.checkVersionStaleness(
          'version-1',
          'CHAPTER_UPDATED',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(result.recheckRequired).toBe(true);
        expect(mockPrisma.rightsReview.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
        expect(mockPrisma.rightsProfile.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
      });

      /** Дата публикации на черновике — тоже след публикации: сомнение трактуется в пользу `STALE`. */
      it('still marks a draft stale when it carries a publication date', async () => {
        setupMismatch({ publishedAt: new Date('2026-07-01T00:00:00.000Z') });

        const result = await service.checkVersionStaleness(
          'version-1',
          'CHAPTER_UPDATED',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(mockPrisma.rightsProfile.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
      });

      it('still marks a draft stale for a trigger outside the window', async () => {
        setupMismatch();

        const result = await service.checkVersionStaleness(
          'version-1',
          'AUDIO_CHAPTER_CREATED',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(mockPrisma.rightsProfile.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
      });

      it('does not clear a stale mark that was already there', async () => {
        setupMismatch({
          rightsRecheckRequired: true,
          rightsStaleReasonCode: 'SOURCE_EDITION_CHANGED',
          rightsStaleReasonRu: 'Изменены данные исходного издания',
        });

        const result = await service.checkVersionStaleness(
          'version-1',
          'CHAPTER_CREATED',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(result.recheckRequired).toBe(true);
        expect(result.reasonCode).toBe('SOURCE_EDITION_CHANGED');
      });

      it('still marks a draft stale when there is no baseline to re-take', async () => {
        setupMismatch({ rightsContentHash: null });

        const result = await service.checkVersionStaleness(
          'version-1',
          'CHAPTER_CREATED',
          null,
          true,
        );

        expect(result.isStale).toBe(true);
        expect(mockPrisma.rightsReview.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
        );
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
   * WP-D.4: жёсткий выход из окна. Публикация фиксирует слепок окончательно и оставляет
   * в аудите признак закрытия — снятие с публикации окно обратно не открывает.
   */
  describe('finalizeBaselineOnPublish (WP-D.4)', () => {
    beforeEach(() => {
      mockPrisma.bookVersion.findUnique.mockResolvedValue({
        id: 'version-1',
        rightsContentHash: 'draft-hash',
      });
      jest.spyOn(service, 'computeVersionHash').mockResolvedValue({
        versionId: 'version-1',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        hash: 'published-hash',
        algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        calculatedAt: new Date().toISOString(),
        input: {},
      });
      mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });
    });

    it('fixes the baseline and records the window as closed', async () => {
      await service.finalizeBaselineOnPublish('version-1');

      expect(mockPrisma.bookVersion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'version-1' },
          data: expect.objectContaining({ rightsContentHash: 'published-hash' }),
        }),
      );
      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            previousHash: 'draft-hash',
            currentHash: 'published-hash',
            staleMarked: false,
            reasonCode: 'DRAFT_FILL_WINDOW_CLOSED',
          }),
        }),
      );
    });

    it('does not clear stale marks', async () => {
      await service.finalizeBaselineOnPublish('version-1');

      const updateData = mockPrisma.bookVersion.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateData.data).not.toHaveProperty('rightsRecheckRequired');
      expect(updateData.data).not.toHaveProperty('rightsStaleDetectedAt');
    });
  });

  /**
   * WP-D.2: первое появление файла источника меняет вход хеша, но не произведение —
   * baseline переснимается, статусы клиренса не трогаются.
   */
  describe('rebaselineForRightsProfile (WP-D.2)', () => {
    const openWindow = (): void => {
      mockPrisma.rightsContentHashEvent.findFirst.mockImplementation(
        (args: { where: { reasonCode: string } }) =>
          Promise.resolve(
            args.where.reasonCode === 'DRAFT_FILL_WINDOW_OPENED' ? { id: 'opened-event' } : null,
          ),
      );
    };

    it('re-takes the baseline of every version of the profile without marking it stale', async () => {
      openWindow();
      mockPrisma.bookVersion.findMany.mockResolvedValue([
        { id: 'version-1', rightsContentHash: 'hash-before', status: 'draft', publishedAt: null },
        { id: 'version-2', rightsContentHash: null, status: 'draft', publishedAt: null },
      ]);
      jest.spyOn(service, 'computeVersionHash').mockResolvedValue({
        versionId: 'version-1',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        hash: 'hash-after',
        algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        calculatedAt: new Date().toISOString(),
        input: {},
      });
      mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });

      await service.rebaselineForRightsProfile(
        'profile-1',
        'SOURCE_EDITION_CHANGED',
        'SOURCE_FILE_FIRST_UPLOAD',
        'Первая загрузка файла источника',
        'user-1',
      );

      expect(mockPrisma.bookVersion.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.rightsReview.update).not.toHaveBeenCalled();
      expect(mockPrisma.rightsProfile.update).not.toHaveBeenCalled();
      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookVersionId: 'version-1',
            trigger: 'SOURCE_EDITION_CHANGED',
            previousHash: 'hash-before',
            currentHash: 'hash-after',
            staleMarked: false,
            reasonCode: 'SOURCE_FILE_FIRST_UPLOAD',
          }),
        }),
      );
    });

    /**
     * Дыра в первой редакции WP-D.2: пересъёмка шла по всем версиям профиля без проверки
     * статуса. У опубликованной версии окно закрыто публикацией, её слепок зафиксирован —
     * появление файла источника обязано уводить клиренс в `STALE`, как и прежде.
     */
    it('marks a published version stale instead of re-taking its baseline', async () => {
      openWindow();
      mockPrisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'version-1',
          rightsContentHash: 'hash-before',
          status: 'published',
          publishedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ]);
      mockPrisma.bookVersion.findUnique.mockResolvedValue({
        id: 'version-1',
        status: 'published',
        publishedAt: new Date('2026-07-01T00:00:00.000Z'),
        rightsContentHash: 'hash-before',
        rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        rightsRecheckRequired: false,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
        rightsStaleDetectedAt: null,
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
      });
      jest.spyOn(service, 'computeVersionHash').mockResolvedValue({
        versionId: 'version-1',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        hash: 'hash-after',
        algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
        calculatedAt: new Date().toISOString(),
        input: {},
      });
      mockPrisma.rightsContentHashEvent.create.mockResolvedValue({ id: 'event-1' });
      mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
        cb(mockPrisma),
      );

      await service.rebaselineForRightsProfile(
        'profile-1',
        'SOURCE_EDITION_CHANGED',
        'SOURCE_FILE_FIRST_UPLOAD',
        'Первая загрузка файла источника',
        'user-1',
      );

      expect(mockPrisma.rightsReview.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
      );
      expect(mockPrisma.rightsProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
      );
      expect(mockPrisma.rightsContentHashEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookVersionId: 'version-1',
            staleMarked: true,
            reasonCode: 'SOURCE_EDITION_CHANGED',
          }),
        }),
      );
      expect(mockPrisma.rightsContentHashEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reasonCode: 'SOURCE_FILE_FIRST_UPLOAD' }),
        }),
      );
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

/**
 * LEGACY-036. Слепок контента и событие о нём — пара: по событию восстанавливается, откуда взялся
 * baseline и почему клиренс ушёл в `STALE`. До этой правки пара писалась двумя независимыми
 * `await` на корневом клиенте всякий раз, когда вызывающий не передал свою транзакцию. Правка глав
 * и метаданных версии сюда **не** относится: `chapter.service.ts`, `audio-chapter.service.ts`
 * и `book-version.service.ts` свой `tx` передают. Без транзакции идут три пути, все три —
 * из `rights-files.service.ts` и админской ручки: ручная проверка хеша
 * (`book-version.controller.ts`), первая загрузка файла источника
 * (`rebaselineForRightsProfile`) и замена уже известной суммы файла
 * (`checkStalenessForRightsProfile` → `checkVersionStaleness` по всем версиям профиля).
 *
 * Двойник ниже имитирует транзакцию: запись через tx-клиент попадает в «БД» только после
 * успешного завершения коллбэка, поэтому тесты проверяют атомарность, а не форму вызова.
 */
describe('RightsContentHashService — атомарность аудита (LEGACY-036)', () => {
  interface Write {
    model: string;
    data: Record<string, unknown>;
    /** Каким клиентом сделана запись: `tx` — транзакционным, `root` — корневым. */
    via: 'tx' | 'root';
  }

  const computation = {
    versionId: 'version-1',
    rightsProfileId: 'profile-1',
    approvedRightsReviewId: 'review-1',
    hash: 'new-hash',
    algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
    calculatedAt: '2026-07-28T00:00:00.000Z',
    input: { version: {} },
  };

  const draftVersion = {
    id: 'version-1',
    bookId: 'book-1',
    status: 'draft',
    publishedAt: null,
    rightsProfileId: 'profile-1',
    approvedRightsReviewId: 'review-1',
    rightsContentHash: 'old-hash',
    rightsContentHashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
    rightsRecheckRequired: false,
    rightsStaleDetectedAt: null,
    rightsStaleReasonCode: null,
    rightsStaleReasonRu: null,
  };

  const createDouble = (
    options: {
      version?: Record<string, unknown>;
      onEventCreate?: () => void;
      onRelatedUpdate?: () => void;
      windowOpenedEvent?: boolean;
    } = {},
  ) => {
    const committed: Write[] = [];
    const version = options.version ?? draftVersion;

    // `immediate` — признак корневого клиента: его запись видна снаружи сразу, без коммита
    // транзакции. Транзакционный клиент пишет в свой буфер, и тот переносится в `committed`
    // только после успешного завершения коллбэка.
    const clientFor = (buffer: Write[], immediate = false) => {
      const push = (write: Omit<Write, 'via'>) => {
        const entry: Write = { ...write, via: immediate ? 'root' : 'tx' };
        buffer.push(entry);
        if (immediate) committed.push(entry);
      };

      return {
        bookVersion: {
          findUnique: jest.fn().mockResolvedValue(version),
          findFirst: jest.fn().mockResolvedValue(null),
          // Соседняя версия того же клиренса: её помечает фан-аут, вынесенный за транзакцию.
          findMany: jest.fn().mockResolvedValue([{ ...version, id: 'version-2' }]),
          update: jest.fn((args: { data: Record<string, unknown> }) => {
            if (args.data.rightsStaleReasonCode === 'SHARED_CLEARANCE_STALE') {
              options.onRelatedUpdate?.();
            }
            push({ model: 'bookVersion.update', data: args.data });
            return Promise.resolve(version);
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        rightsReview: {
          findUnique: jest.fn().mockResolvedValue({ id: 'review-1' }),
          update: jest.fn((args: { data: Record<string, unknown> }) => {
            push({ model: 'rightsReview.update', data: args.data });
            return Promise.resolve({ id: 'review-1' });
          }),
        },
        rightsProfile: {
          findUnique: jest.fn().mockResolvedValue({ id: 'profile-1' }),
          update: jest.fn((args: { data: Record<string, unknown> }) => {
            push({ model: 'rightsProfile.update', data: args.data });
            return Promise.resolve({ id: 'profile-1' });
          }),
        },
        rightsContentHashEvent: {
          // Отметка открытого окна наполнения: её читает `isDraftFillWindowOpen` двумя запросами —
          // сперва ищет событие закрытия окна, потом событие открытия. Двойник обязан различать их
          // по `reasonCode`, иначе окно всегда оказывается закрытым.
          findFirst: jest.fn((args: { where: { reasonCode?: string } }) =>
            Promise.resolve(
              options.windowOpenedEvent && args.where.reasonCode === 'DRAFT_FILL_WINDOW_OPENED'
                ? { id: 'event-0' }
                : null,
            ),
          ),
          create: jest.fn((args: { data: Record<string, unknown> }) => {
            options.onEventCreate?.();
            push({ model: 'rightsContentHashEvent.create', data: args.data });
            return Promise.resolve({ id: 'event-1' });
          }),
        },
        mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) },
        bookVersionContributor: { findMany: jest.fn().mockResolvedValue([]) },
        rightsProfileContributor: { findMany: jest.fn().mockResolvedValue([]) },
      };
    };

    // Запись корневым клиентом видна снаружи сразу — она и есть дефект, который ловят эти тесты.
    const outsideTransaction: Write[] = [];
    const base = clientFor(outsideTransaction, true);

    const client = {
      ...base,
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
        const pending: Write[] = [];
        const result = await callback(clientFor(pending));
        committed.push(...pending);
        return result;
      },
    };

    return { committed, outsideTransaction, client, clientFor };
  };

  const buildService = (client: unknown): RightsContentHashService => {
    const service = new RightsContentHashService(client as PrismaService);
    jest.spyOn(service, 'computeVersionHash').mockResolvedValue(computation);
    return service;
  };

  const failingJournal = () => () => {
    throw new Error('journal write failed');
  };

  it('initializeVersionBaseline: отказ журнала не оставляет версию со слепком без записи о нём', async () => {
    const double = createDouble({ onEventCreate: failingJournal() });

    await expect(
      buildService(double.client).initializeVersionBaseline(
        'version-1',
        'INITIAL_VERSION_SNAPSHOT',
      ),
    ).rejects.toThrow('journal write failed');

    expect(double.committed).toHaveLength(0);
  });

  it('checkVersionStaleness: отказ журнала откатывает пометку версии и клиренса', async () => {
    const double = createDouble({
      version: { ...draftVersion, status: 'published', publishedAt: new Date('2026-07-01') },
      onEventCreate: failingJournal(),
    });

    await expect(
      buildService(double.client).checkVersionStaleness(
        'version-1',
        'CHAPTER_UPDATED',
        'user-42',
        true,
      ),
    ).rejects.toThrow('journal write failed');

    expect(double.committed).toHaveLength(0);
  });

  /**
   * Решение арбитра от 04.09.2026: в транзакции лежит аудит-пара, пометка родственных версий
   * (`SHARED_CLEARANCE_STALE`) идёт после её коммита. Тест смотрит на **происхождение клиента**
   * каждой записи, а не на её наличие: без этого возврат дефекта (запись аудита корневым
   * клиентом) остаётся зелёным — записи те же, меняется только клиент.
   */
  it('checkVersionStaleness: аудит-пара пишется транзакцией, соседние версии — после неё', async () => {
    const double = createDouble({
      version: { ...draftVersion, status: 'published', publishedAt: new Date('2026-07-01') },
    });

    await buildService(double.client).checkVersionStaleness(
      'version-1',
      'CHAPTER_UPDATED',
      'user-42',
      true,
    );

    const via = (model: string) =>
      double.committed.filter((write) => write.model === model).map((write) => write.via);

    expect(via('rightsContentHashEvent.create')).toEqual(['tx']);
    expect(via('rightsReview.update')).toEqual(['tx']);
    expect(via('rightsProfile.update')).toEqual(['tx']);

    // Своя версия — внутри транзакции; всё, что помечено `SHARED_CLEARANCE_STALE`, — вне её.
    const versionWrites = double.committed.filter((write) => write.model === 'bookVersion.update');
    const ownVersion = versionWrites.filter(
      (write) => write.data.rightsStaleReasonCode !== 'SHARED_CLEARANCE_STALE',
    );
    const relatedVersions = versionWrites.filter(
      (write) => write.data.rightsStaleReasonCode === 'SHARED_CLEARANCE_STALE',
    );

    expect(ownVersion.map((write) => write.via)).toEqual(['tx']);
    expect(relatedVersions.length).toBeGreaterThan(0);
    expect(relatedVersions.every((write) => write.via === 'root')).toBe(true);
  });

  /**
   * Ветка `if (tx) return work(tx)` в `inTransaction` — единственное, что удерживает эти методы
   * внутри чужой транзакции. Без неё `markSelf` пошёл бы вторым соединением и встал на строке
   * `BookVersion`, которую держит вызывающий, до самого `timeout` — 500 через 30 секунд,
   * а десять таких запросов выбирают пул целиком.
   */
  it('вызывающий со своей транзакцией не получает второй: записи идут его клиентом', async () => {
    const double = createDouble({
      version: { ...draftVersion, status: 'published', publishedAt: new Date('2026-07-01') },
    });
    const openedTransactions = jest.spyOn(double.client, '$transaction');

    const callerWrites: Write[] = [];
    const callerTx = double.clientFor(callerWrites);

    await buildService(double.client).checkVersionStaleness(
      'version-1',
      'CHAPTER_UPDATED',
      'user-42',
      true,
      callerTx as unknown as Parameters<RightsContentHashService['checkVersionStaleness']>[4],
    );

    expect(openedTransactions).not.toHaveBeenCalled();
    expect(callerWrites.map((write) => write.model)).toEqual(
      expect.arrayContaining([
        'bookVersion.update',
        'rightsReview.update',
        'rightsContentHashEvent.create',
      ]),
    );
    // Ни одна запись не ушла мимо клиента вызывающего.
    expect(double.committed).toHaveLength(0);
  });

  it('отказ на пометке соседней версии не откатывает уже записанное событие аудита', async () => {
    const double = createDouble({
      version: { ...draftVersion, status: 'published', publishedAt: new Date('2026-07-01') },
      onRelatedUpdate: () => {
        throw new Error('related version update failed');
      },
    });

    await expect(
      buildService(double.client).checkVersionStaleness(
        'version-1',
        'CHAPTER_UPDATED',
        'user-42',
        true,
      ),
    ).rejects.toThrow('related version update failed');

    const events = double.committed.filter(
      (write) => write.model === 'rightsContentHashEvent.create',
    );
    expect(events).toHaveLength(1);
    expect(events[0].via).toBe('tx');
  });

  it('checkVersionStaleness: отказ журнала откатывает пересъёмку при смене версии алгоритма', async () => {
    const double = createDouble({
      version: { ...draftVersion, rightsContentHashAlgorithmVersion: 'v0' },
      onEventCreate: failingJournal(),
    });

    await expect(
      buildService(double.client).checkVersionStaleness(
        'version-1',
        'MANUAL_HASH_CHECK',
        'user-42',
        true,
      ),
    ).rejects.toThrow('journal write failed');

    expect(double.committed).toHaveLength(0);
  });

  it('checkVersionStaleness: отказ журнала откатывает пересъёмку в окне наполнения черновика', async () => {
    const double = createDouble({ windowOpenedEvent: true, onEventCreate: failingJournal() });

    await expect(
      buildService(double.client).checkVersionStaleness(
        'version-1',
        'CHAPTER_UPDATED',
        'user-42',
        true,
      ),
    ).rejects.toThrow('journal write failed');

    expect(double.committed).toHaveLength(0);
  });

  it('finalizeBaselineOnPublish: отказ журнала откатывает фиксацию слепка', async () => {
    const double = createDouble({ onEventCreate: failingJournal() });

    await expect(
      buildService(double.client).finalizeBaselineOnPublish('version-1', 'user-42'),
    ).rejects.toThrow('journal write failed');

    expect(double.committed).toHaveLength(0);
  });

  it('rebaselineForRightsProfile: отказ журнала откатывает пересъёмку версии профиля', async () => {
    const double = createDouble({ windowOpenedEvent: true, onEventCreate: failingJournal() });

    await expect(
      buildService(double.client).rebaselineForRightsProfile(
        'profile-1',
        'SOURCE_EDITION_CHANGED',
        'SOURCE_FILE_FIRST_UPLOAD',
        'Первая загрузка файла источника',
        'user-42',
      ),
    ).rejects.toThrow('journal write failed');

    expect(double.committed).toHaveLength(0);
  });
});
