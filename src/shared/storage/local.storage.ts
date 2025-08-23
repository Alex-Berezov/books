import { Injectable } from '@nestjs/common';
import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { StorageService, StorageSaveOptions, StorageStat } from './storage.interface';

@Injectable()
export class LocalStorageService implements StorageService {
  private baseDir: string;
  private publicBaseUrl: string | undefined;

  constructor() {
    // Defaults match TASKS.md suggestions
    const configured = process.env.LOCAL_UPLOADS_DIR || './var/uploads';
    this.baseDir = resolve(configured);
    this.publicBaseUrl = process.env.LOCAL_PUBLIC_BASE_URL || 'http://localhost:3000/static';
  }

  private resolvePath(key: string) {
    // prevent directory traversal
    const safeKey = key.replace(/\\|\.{2,}/g, '_');
    return resolve(join(this.baseDir, safeKey));
  }

  async save(key: string, data: Buffer | Readable, options?: StorageSaveOptions): Promise<string> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(dirname(filePath), { recursive: true });
    // touch options to avoid unused var lint and allow future extension
    void options?.contentType;
    const ws = createWriteStream(filePath);
    await new Promise<void>((resolvePromise, reject) => {
      if (Buffer.isBuffer(data)) {
        ws.write(data);
        ws.end();
      } else {
        data.pipe(ws);
      }
      ws.on('finish', () => resolvePromise());
      ws.on('error', (err) => reject(err));
    });
    return filePath;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === 'ENOENT') return; // idempotent
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<StorageStat | null> {
    const filePath = this.resolvePath(key);
    try {
      const s = await fs.stat(filePath);
      return { size: s.size };
    } catch {
      return null;
    }
  }

  getPublicUrl(key: string): string {
    const base = this.publicBaseUrl?.replace(/\/$/, '') || '';
    const safeKey = key.replace(/^\/+/, '');
    return `${base}/${safeKey}`;
  }
}
