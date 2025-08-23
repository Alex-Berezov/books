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
}

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
