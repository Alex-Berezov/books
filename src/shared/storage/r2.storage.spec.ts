import { R2StorageService } from './r2.storage';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

jest.mock('@aws-sdk/client-s3', () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return {
    ...jest.requireActual('@aws-sdk/client-s3'),
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

describe('R2StorageService (unit)', () => {
  const prevEnv = { ...process.env };

  beforeAll(() => {
    process.env.R2_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET = 'test-bucket';
    process.env.R2_PUBLIC_BASE_URL = 'https://media.example.com';
    process.env.R2_KEY_PREFIX = '';
  });

  afterAll(() => {
    process.env = prevEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws on missing R2_BUCKET', () => {
    delete process.env.R2_BUCKET;
    expect(() => new R2StorageService()).toThrow('R2_BUCKET is missing');
    process.env.R2_BUCKET = 'test-bucket';
  });

  describe('getPublicUrl', () => {
    it('builds correct URL with encoded key', () => {
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('covers/2026/07/21/test.jpg');
      expect(url).toBe('https://media.example.com/covers/2026/07/21/test.jpg');
    });

    it('handles key with special characters', () => {
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('covers/2026/07/21/test file.jpg');
      expect(url).toBe('https://media.example.com/covers/2026/07/21/test%20file.jpg');
    });

    it('normalizes backslashes', () => {
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('covers\\2026\\07\\21\\test.jpg');
      expect(url).toBe('https://media.example.com/covers/2026/07/21/test.jpg');
    });

    it('strips leading slash', () => {
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('/covers/test.jpg');
      expect(url).toBe('https://media.example.com/covers/test.jpg');
    });

    it('includes key prefix when set', () => {
      process.env.R2_KEY_PREFIX = 'prod';
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('covers/test.jpg');
      expect(url).toBe('https://media.example.com/covers/test.jpg');
      process.env.R2_KEY_PREFIX = '';
    });
  });

  describe('save', () => {
    it('calls PutObjectCommand with correct params', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockResolvedValue({});

      await svc.save('covers/test.jpg', Buffer.from('data'), { contentType: 'image/jpeg' });

      expect(sendMock).toHaveBeenCalledTimes(1);
      const cmd = sendMock.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(PutObjectCommand);
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toBe('covers/test.jpg');
      expect(cmd.input.ContentType).toBe('image/jpeg');
      expect(Buffer.isBuffer(cmd.input.Body)).toBe(true);
      expect(cmd.input.CacheControl).toBe('public, max-age=31536000, immutable');
    });
  });

  describe('delete', () => {
    it('calls DeleteObjectCommand', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockResolvedValue({});

      await svc.delete('covers/test.jpg');

      expect(sendMock).toHaveBeenCalledTimes(1);
      const cmd = sendMock.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(DeleteObjectCommand);
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toBe('covers/test.jpg');
    });

    it('does not throw on NotFound', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      const err = Object.assign(new Error('Not Found'), { name: 'NotFound' });
      sendMock.mockRejectedValue(err);

      await expect(svc.delete('covers/missing.jpg')).resolves.toBeUndefined();
    });
  });

  describe('exists', () => {
    it('returns true on successful head', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockResolvedValue({});

      const result = await svc.exists('covers/test.jpg');
      expect(result).toBe(true);
      const cmd = sendMock.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(HeadObjectCommand);
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toBe('covers/test.jpg');
    });

    it('returns false on 404/NotFound', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      const err = Object.assign(new Error('Not Found'), { name: 'NotFound' });
      sendMock.mockRejectedValue(err);

      await expect(svc.exists('covers/missing.jpg')).resolves.toBe(false);
    });
  });

  describe('stat', () => {
    it('returns size and contentType from HeadObject response', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockResolvedValue({ ContentLength: 12345, ContentType: 'image/png' });

      const result = await svc.stat('covers/test.png');
      expect(result).toEqual({ size: 12345, contentType: 'image/png' });
    });

    it('returns null on 404', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      const err = Object.assign(new Error('Not Found'), { name: 'NotFound' });
      sendMock.mockRejectedValue(err);

      await expect(svc.stat('covers/missing.png')).resolves.toBeNull();
    });
  });

  describe('getLocalPath', () => {
    it('returns null', () => {
      const svc = new R2StorageService();
      expect(svc.getLocalPath('covers/test.jpg')).toBeNull();
    });
  });
});
