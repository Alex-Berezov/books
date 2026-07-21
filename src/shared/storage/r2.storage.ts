import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { StorageService, StorageSaveOptions, StorageStat } from './storage.interface';

@Injectable()
export class R2StorageService implements StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly keyPrefix: string;
  private readonly cacheControl: string;

  constructor() {
    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;
    const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL;

    if (!endpoint) throw new Error('R2 storage is enabled but R2_ENDPOINT is missing');
    if (!accessKeyId) throw new Error('R2 storage is enabled but R2_ACCESS_KEY_ID is missing');
    if (!secretAccessKey)
      throw new Error('R2 storage is enabled but R2_SECRET_ACCESS_KEY is missing');
    if (!bucket) throw new Error('R2 storage is enabled but R2_BUCKET is missing');
    if (!publicBaseUrl) throw new Error('R2 storage is enabled but R2_PUBLIC_BASE_URL is missing');

    this.client = new S3Client({
      endpoint,
      region: 'auto',
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bucket = bucket;
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
    this.keyPrefix = this.normalizePrefix(process.env.R2_KEY_PREFIX || '');
    this.cacheControl = process.env.R2_CACHE_CONTROL || '';
  }

  private normalizePrefix(prefix: string): string {
    let normalized = prefix.replace(/\\/g, '/');
    normalized = normalized.replace(/\.{2,}/g, '');
    normalized = normalized.replace(/^\/+|\/+$/g, '');
    return normalized;
  }

  private normalizeKey(key: string): string {
    let normalized = key.replace(/\\/g, '/');
    normalized = normalized.replace(/\.{2,}/g, '');
    normalized = normalized.replace(/^\/+/, '');
    return normalized;
  }

  private prefixedKey(key: string): string {
    const normalized = this.normalizeKey(key);
    return this.keyPrefix ? `${this.keyPrefix}/${normalized}` : normalized;
  }

  private isNotFoundError(e: unknown): boolean {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return (
      err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404
    );
  }

  async save(key: string, data: Buffer | Readable, options?: StorageSaveOptions): Promise<string> {
    const objectKey = this.prefixedKey(key);
    const body = Buffer.isBuffer(data) ? data : await this.streamToBuffer(data);
    const contentType = options?.contentType || 'application/octet-stream';
    const cacheControl = this.cacheControl || this.inferCacheControl(contentType);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );

    return this.getPublicUrl(key);
  }

  async delete(key: string): Promise<void> {
    const objectKey = this.prefixedKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch (e) {
      if (this.isNotFoundError(e)) return;
      this.logger.error(`Delete failed for ${objectKey}: ${(e as Error).message}`);
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    const objectKey = this.prefixedKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return true;
    } catch (e) {
      if (this.isNotFoundError(e)) return false;
      this.logger.error(`exists() check failed for ${objectKey}: ${(e as Error).message}`);
      throw e;
    }
  }

  async stat(key: string): Promise<StorageStat | null> {
    const objectKey = this.prefixedKey(key);
    try {
      const resp = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return {
        size: resp.ContentLength ?? 0,
        contentType: resp.ContentType,
      };
    } catch (e) {
      if (this.isNotFoundError(e)) return null;
      this.logger.error(`stat() failed for ${objectKey}: ${(e as Error).message}`);
      throw e;
    }
  }

  getPublicUrl(key: string): string {
    const objectKey = this.prefixedKey(key);
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
    return `${this.publicBaseUrl}/${encodedKey}`;
  }

  getLocalPath(_key: string): string | null {
    void _key;
    return null;
  }

  private inferCacheControl(contentType: string): string {
    if (
      contentType.startsWith('image/') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/')
    ) {
      return 'public, max-age=31536000, immutable';
    }
    return 'public, max-age=86400';
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
