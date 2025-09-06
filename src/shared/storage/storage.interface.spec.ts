import { Readable } from 'node:stream';
import { StorageService, StorageSaveOptions, StorageStat } from './storage.interface';

class InMemoryStorage implements StorageService {
  private files = new Map<string, { data: Buffer; contentType?: string }>();
  private base = 'http://example/static';

  async save(key: string, data: Buffer | Readable, options?: StorageSaveOptions): Promise<string> {
    let buf: Buffer;
    if (Buffer.isBuffer(data)) buf = data;
    else {
      const chunks: Uint8Array[] = [];
      await new Promise<void>((resolve, reject) => {
        data.on('data', (c: any) => {
          const u8: Uint8Array = Buffer.isBuffer(c) ? c : Buffer.from(c);
          chunks.push(u8);
        });
        data.on('end', () => resolve());
        data.on('error', reject);
      });
      buf = Buffer.concat(chunks);
    }
    this.files.set(key, { data: buf, contentType: options?.contentType });
    return key; // mimic identifier
  }

  delete(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.files.has(key));
  }

  stat(key: string): Promise<StorageStat | null> {
    const f = this.files.get(key);
    if (!f) return Promise.resolve(null);
    return Promise.resolve({ size: f.data.length, contentType: f.contentType });
  }

  getPublicUrl(key: string): string {
    return `${this.base}/${key.replace(/^\/+/, '')}`;
  }
}

describe('StorageService contract (unit)', () => {
  it('implements save/delete/exists/stat/getPublicUrl', async () => {
    const storage: StorageService = new InMemoryStorage();
    const key = 'a/b/c.txt';

    await expect(storage.exists(key)).resolves.toBe(false);
    await storage.save(key, Buffer.from('abc'), { contentType: 'text/plain' });
    await expect(storage.exists(key)).resolves.toBe(true);
    await expect(storage.stat(key)).resolves.toEqual({ size: 3, contentType: 'text/plain' });
    expect(storage.getPublicUrl(key)).toBe('http://example/static/a/b/c.txt');
    await storage.delete(key);
    await expect(storage.stat(key)).resolves.toBeNull();
  });
});
