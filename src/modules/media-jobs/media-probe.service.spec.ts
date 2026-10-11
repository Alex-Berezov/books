import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MediaProbeService, MEDIA_PROBE_QUEUE } from './media-probe.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { probeDuration } from './ffprobe.util';

jest.mock('./ffprobe.util', () => ({
  ...jest.requireActual<typeof import('./ffprobe.util')>('./ffprobe.util'),
  probeDuration: jest.fn(),
}));
const probeDurationMock = probeDuration as jest.MockedFunction<typeof probeDuration>;

describe('MediaProbeService', () => {
  const prisma = {
    mediaAsset: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const getPublicUrlMock = jest.fn<string, [string]>();
  const mockStorage: StorageService = {
    save: jest.fn(),
    delete: jest.fn(),
    exists: jest.fn(),
    stat: jest.fn(),
    getPublicUrl: getPublicUrlMock,
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
    // LEGACY-461: `asset.url` прежде приходил от клиента — проба идёт по адресу из ключа.
    it('probes the storage public URL built from the key, never asset.url', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({
        id: 'm1',
        key: 'audio/2026/07/21/test.mp3',
        url: 'http://169.254.169.254/latest/meta-data/',
        contentType: 'audio/mpeg',
        duration: null,
        isDeleted: false,
      });
      (mockStorage.getLocalPath as jest.Mock).mockReturnValue(null);
      getPublicUrlMock.mockReturnValue('https://media.example.com/audio/2026/07/21/test.mp3');
      probeDurationMock.mockResolvedValue({ durationSec: null });

      const result = await service.runProbe('m1');

      expect(getPublicUrlMock.mock.calls).toEqual([['audio/2026/07/21/test.mp3']]);
      expect(probeDurationMock.mock.calls).toEqual([
        ['https://media.example.com/audio/2026/07/21/test.mp3'],
      ]);
      expect(result.durationSec).toBeNull();
      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
    });

    it('skips the probe when the storage URL is not http(s)', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({
        id: 'm1',
        key: 'audio/k.mp3',
        url: 'http://169.254.169.254/latest/meta-data/',
        contentType: 'audio/mpeg',
        duration: null,
        isDeleted: false,
      });
      (mockStorage.getLocalPath as jest.Mock).mockReturnValue(null);
      getPublicUrlMock.mockReturnValue('/static/audio/k.mp3');

      const result = await service.runProbe('m1');

      expect(probeDurationMock).not.toHaveBeenCalled();
      expect(result.durationSec).toBeNull();
    });
  });
});
