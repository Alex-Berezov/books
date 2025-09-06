import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalStorageService } from './local.storage';

describe('LocalStorageService (unit)', () => {
  const tmpBase = resolve('var/test-uploads');
  const prevEnv = { ...process.env };

  beforeAll(() => {
    process.env.LOCAL_UPLOADS_DIR = tmpBase;
    process.env.LOCAL_PUBLIC_BASE_URL = 'http://localhost:5000/static';
  });

  afterAll(() => {
    process.env = prevEnv;
  });

  beforeEach(async () => {
    // clean test dir between cases
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('saves buffer to disk, exists/stat return values, delete is idempotent', async () => {
    const storage = new LocalStorageService();
    const key = 'foo/bar.txt';
    const data = Buffer.from('hello');

    const abs = await storage.save(key, data, { contentType: 'text/plain' });
    expect(abs).toBe(resolve(join(tmpBase, key)));
    await expect(fs.readFile(abs, 'utf8')).resolves.toBe('hello');

    await expect(storage.exists(key)).resolves.toBe(true);
    const st = await storage.stat(key);
    expect(st).toEqual({ size: 5 });

    await expect(storage.delete(key)).resolves.toBeUndefined();
    await expect(storage.exists(key)).resolves.toBe(false);
    // second delete should be a no-op (idempotent)
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('prevents directory traversal by sanitizing key', async () => {
    const storage = new LocalStorageService();
    const tricky = '../outside/..//evil.txt';
    const abs = await storage.save(tricky, Buffer.from('x'));
    // After sanitization, file is placed under base with underscores
    const sanitizedPart = tricky.replace(/\\|\.{2,}/g, '_');
    const expected = resolve(join(tmpBase, sanitizedPart));
    expect(abs).toBe(expected);
    await storage.delete(tricky);
  });

  it('builds public URL from env base and key', () => {
    const storage = new LocalStorageService();
    const url = storage.getPublicUrl('/nested/file.png');
    expect(url).toBe('http://localhost:5000/static/nested/file.png');
  });
});
