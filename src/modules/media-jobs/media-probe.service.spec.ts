import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MediaProbeService, MEDIA_PROBE_QUEUE } from './media-probe.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';

describe('MediaProbeService', () => {
  const prisma = {
    mediaAsset: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockStorage: StorageService = {
    save: jest.fn(),
    delete: jest.fn(),
    exists: jest.fn(),
    stat: jest.fn(),
    getPublicUrl: jest.fn(),
    getLocalPath: jest.fn(),
  };

  const config = { get: jest.fn() };

  let service: MediaProbeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MediaProbeService,
        { provide: PrismaService, useValue: prisma },
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: ConfigService, useValue: config },
        { provide: MEDIA_PROBE_QUEUE, useValue: undefined },
      ],
    }).compile();
    service = module.get<MediaProbeService>(MediaProbeService);
  });

  describe('runProbe', () => {
    it('uses asset.url when getLocalPath returns null and url is http/https', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({
        id: 'm1',
        key: 'audio/2026/07/21/test.mp3',
        url: 'https://media.example.com/audio/2026/07/21/test.mp3',
        contentType: 'audio/mpeg',
        duration: null,
        isDeleted: false,
      });
      (mockStorage.getLocalPath as jest.Mock).mockReturnValue(null);

      const result = await service.runProbe('m1');

      expect(result.durationSec).toBeNull();
      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
    });
  });
});
