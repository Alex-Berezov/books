import { Readable } from 'node:stream';

export interface StorageSaveOptions {
  contentType?: string;
}

export interface StorageStat {
  size: number;
  contentType?: string;
}

export interface StorageService {
  save(key: string, data: Buffer | Readable, options?: StorageSaveOptions): Promise<string>; // returns absolute file path or identifier
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StorageStat | null>;
  getPublicUrl(key: string): string;
  /**
   * Returns absolute local filesystem path for a key, when available.
   * Non-local drivers (S3 etc.) may return null.
   */
  getLocalPath?(key: string): string | null;
  /**
   * WP-9: reads an object back into memory. Needed by the rights file store, whose objects
   * are never exposed through a public URL and can only be served by the backend itself.
   * Returns null when the key does not exist.
   */
  read?(key: string): Promise<Buffer | null>;
}

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
