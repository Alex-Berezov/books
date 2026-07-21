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

  describe('constructor key prefix normalization', () => {
    it('normalizes trailing slash', () => {
      process.env.R2_KEY_PREFIX = 'prod/';
      const svc = new R2StorageService();
      expect((svc as unknown as { keyPrefix: string }).keyPrefix).toBe('prod');
      process.env.R2_KEY_PREFIX = '';
    });

    it('normalizes leading slash', () => {
      process.env.R2_KEY_PREFIX = '/prod';
      const svc = new R2StorageService();
      expect((svc as unknown as { keyPrefix: string }).keyPrefix).toBe('prod');
      process.env.R2_KEY_PREFIX = '';
    });

    it('normalizes both slashes', () => {
      process.env.R2_KEY_PREFIX = '/prod/';
      const svc = new R2StorageService();
      expect((svc as unknown as { keyPrefix: string }).keyPrefix).toBe('prod');
      process.env.R2_KEY_PREFIX = '';
    });

    it('strips path traversal from prefix', () => {
      process.env.R2_KEY_PREFIX = '../prod';
      const svc = new R2StorageService();
      expect((svc as unknown as { keyPrefix: string }).keyPrefix).toBe('prod');
      process.env.R2_KEY_PREFIX = '';
    });
  });

  describe('getPublicUrl', () => {
    it('builds correct URL without prefix', () => {
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('covers/2026/07/21/test.jpg');
      expect(url).toBe('https://media.example.com/covers/2026/07/21/test.jpg');
    });

    it('includes key prefix when set', () => {
      process.env.R2_KEY_PREFIX = 'prod';
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('covers/test.jpg');
      expect(url).toBe('https://media.example.com/prod/covers/test.jpg');
      process.env.R2_KEY_PREFIX = '';
    });

    it('normalizes prefix in public URL (/prod/)', () => {
      process.env.R2_KEY_PREFIX = '/prod/';
      const svc = new R2StorageService();
      const url = svc.getPublicUrl('covers/test.jpg');
      expect(url).toBe('https://media.example.com/prod/covers/test.jpg');
      process.env.R2_KEY_PREFIX = '';
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
  });

  describe('save', () => {
    it('calls PutObjectCommand with correct params (no prefix)', async () => {
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

    it('calls PutObjectCommand with prefixed key', async () => {
      process.env.R2_KEY_PREFIX = 'prod';
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockResolvedValue({});

      await svc.save('covers/test.jpg', Buffer.from('data'), { contentType: 'image/jpeg' });

      const cmd = sendMock.mock.calls[0][0];
      expect(cmd.input.Key).toBe('prod/covers/test.jpg');
      process.env.R2_KEY_PREFIX = '';
    });
  });

  describe('delete', () => {
    it('calls DeleteObjectCommand with prefixed key', async () => {
      process.env.R2_KEY_PREFIX = 'prod';
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockResolvedValue({});

      await svc.delete('covers/test.jpg');

      const cmd = sendMock.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(DeleteObjectCommand);
      expect(cmd.input.Key).toBe('prod/covers/test.jpg');
      process.env.R2_KEY_PREFIX = '';
    });

    it('does not throw on NotFound (name)', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      const err = Object.assign(new Error('Not Found'), { name: 'NotFound' });
      sendMock.mockRejectedValue(err);

      await expect(svc.delete('covers/missing.jpg')).resolves.toBeUndefined();
    });

    it('does not throw on 404 via $metadata', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      const err = Object.assign(new Error('Not Found'), { $metadata: { httpStatusCode: 404 } });
      sendMock.mockRejectedValue(err);

      await expect(svc.delete('covers/missing.jpg')).resolves.toBeUndefined();
    });

    it('does not throw on NoSuchKey', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      const err = Object.assign(new Error('No Such Key'), { name: 'NoSuchKey' });
      sendMock.mockRejectedValue(err);

      await expect(svc.delete('covers/missing.jpg')).resolves.toBeUndefined();
    });

    it('throws on AccessDenied', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      const err = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      sendMock.mockRejectedValue(err);

      await expect(svc.delete('covers/protected.jpg')).rejects.toThrow('Access Denied');
    });

    it('throws on network error', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockRejectedValue(new Error('Network error'));

      await expect(svc.delete('covers/test.jpg')).rejects.toThrow('Network error');
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

    it('throws on non-404 errors in exists', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockRejectedValue(new Error('ServiceUnavailable'));

      await expect(svc.exists('covers/test.jpg')).rejects.toThrow('ServiceUnavailable');
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

    it('throws on non-404 errors in stat', async () => {
      const svc = new R2StorageService();
      const sendMock = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;
      sendMock.mockRejectedValue(new Error('InternalError'));

      await expect(svc.stat('covers/test.png')).rejects.toThrow('InternalError');
    });
  });

  describe('getLocalPath', () => {
    it('returns null', () => {
      const svc = new R2StorageService();
      expect(svc.getLocalPath('covers/test.jpg')).toBeNull();
    });
  });
});
