import { isStoragePublicUrl } from './storage-public-url';
import type { StorageService } from './storage.interface';

/** `LEGACY-455`: аватар — только адрес под публичной базой хранилища. */
describe('isStoragePublicUrl', () => {
  const storage = (base: string) =>
    ({ getPublicUrl: (key: string) => `${base}/${key}` }) as unknown as StorageService;
  const r2 = storage('https://media.example.test/uploads');

  it.each([
    ['файл под базой', 'https://media.example.test/uploads/avatars/u1/a.png', true],
    ['запрос и якорь не меняют файла', 'https://media.example.test/uploads/a.png?v=2#x', true],
    ['чужой хост', 'https://tracker.example.com/uploads/a.png', false],
    ['наш хост префиксом чужого', 'https://media.example.test.evil.com/uploads/a.png', false],
    ['наш хост учёткой чужого', 'https://media.example.test@evil.com/uploads/a.png', false],
    ['соседний префикс', 'https://media.example.test/uploads-other/a.png', false],
    [
      'выход из базы закодированными точками',
      'https://media.example.test/uploads/%2e%2e/x.png',
      false,
    ],
    ['выход из базы точками', 'https://media.example.test/uploads/../x.png', false],
    ['другая схема', 'http://media.example.test/uploads/a.png', false],
    ['сама база', 'https://media.example.test/uploads/', false],
    ['не адрес', 'not a url', false],
  ])('%s', (_name, candidate, expected) => {
    expect(isStoragePublicUrl(r2, candidate)).toBe(expected);
  });

  it('база без пути (локальный драйвер) — весь хост', () => {
    const local = storage('https://api.example.test');
    expect(isStoragePublicUrl(local, 'https://api.example.test/avatars/a.png')).toBe(true);
    expect(isStoragePublicUrl(local, 'https://other.example.test/avatars/a.png')).toBe(false);
  });

  it('относительная база — отказ, а не исключение', () => {
    expect(isStoragePublicUrl(storage(''), 'https://api.example.test/a.png')).toBe(false);
  });
});
