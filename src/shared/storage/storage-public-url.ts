import type { StorageService } from './storage.interface';

/**
 * Лежит ли адрес под публичной базой нашего хранилища — той, что отдаёт загрузка
 * (`StorageService.getPublicUrl`), со своим префиксом ключей (`LEGACY-455`, решение арбитра 10.10.2026).
 *
 * Сравниваются разобранные `origin` и путь, а не строка целиком: голый `startsWith` пропустил бы
 * `https://media.bibliaris.com.evil.com/...` и `https://media.bibliaris.com@evil.com/...`.
 * Путь базы сверяется по границе сегмента: база `/prefix` не принимает `/prefix-other/...`.
 */
export function isStoragePublicUrl(storage: StorageService, candidate: string): boolean {
  // Ключ-пробник: база — всё, что `getPublicUrl` ставит перед ключом.
  const probe = '__probe__';
  let base: URL;
  let url: URL;
  try {
    base = new URL(storage.getPublicUrl(probe));
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;
  const basePath = base.pathname.slice(0, -probe.length);
  return url.pathname.startsWith(basePath) && url.pathname.length > basePath.length;
}
