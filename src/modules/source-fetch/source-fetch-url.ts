import { isIP } from 'node:net';

export const MAX_URL_LENGTH = 2000;

/**
 * Проверка адреса до сети. `null` — адрес не годится. Возвращает разобранный URL без фрагмента.
 * Десятичная и шестнадцатеричная записи (2130706433, 0x7f.1) WHATWG-разбор сам сводит к
 * `127.0.0.1`, поэтому IP-литерал ловится одной проверкой `isIP` по нормализованному хосту.
 */
export function parseSourceUrl(raw: string, allowedPort?: number): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  // Порт 443 разбор отбрасывает, поэтому пустой порт и есть «443 или без порта».
  if (url.port !== '' && Number(url.port) !== allowedPort) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || isIP(host) !== 0) return null;
  url.hash = '';
  return url;
}

/** Ключ кэша хода: нормализованный адрес. */
export function normalizeSourceUrl(raw: string, allowedPort?: number): string {
  const url = parseSourceUrl(raw, allowedPort);
  return url ? url.href : `invalid:${String(raw).slice(0, 200)}`;
}
