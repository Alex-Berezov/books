import { Language } from '@prisma/client';
import { robotsTokens } from '../../../shared/seo/term-indexable.util';

const LANGUAGES = new Set<string>(Object.values(Language));

/**
 * Служебные разделы: первый сегмент после языка (`/:lang/search`, `/:lang/auth/sign-in`) или первый
 * сегмент пути без языка (`/account`). `auth`, `profile`, `bookshelf` — каталоги фронта
 * `books-front/app/[lang]/`, прежняя подстрока `/sign-in` закрывала `/:lang/auth/sign-in`
 * (решение арбитра 03.10.2026, ревью `T90`).
 */
const SERVICE_SECTIONS = new Set([
  'sign-in',
  'sign-up',
  'account',
  'my-bookshelf',
  'checkout',
  'search',
  'auth',
  'profile',
  'bookshelf',
]);

/** Служебные разделы без языка: `/api/...`, `/admin/...`, `/debug/...`. */
const ROOT_SERVICE_SECTIONS = new Set(['api', 'admin', 'debug']);

/**
 * Служебный ли путь — по **первому сегменту** после языка или первому сегменту пути без языка,
 * а не по подстроке: слаг `search-engines` или тег `/en/tag/search`
 * служебными не считаются (`LEGACY-422`, `T90`, слово владельца 02.10.2026, решение арбитра 03.10.2026).
 * `path` — канонический URL целиком или относительный путь.
 */
function isServicePath(path: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(path).pathname;
  } catch {
    pathname = path.split(/[?#]/)[0];
  }
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  const [first, second] = segments;
  if (first === undefined) return false;
  if (ROOT_SERVICE_SECTIONS.has(first)) return true;
  const section = LANGUAGES.has(first) ? second : first;
  return section !== undefined && SERVICE_SECTIONS.has(section);
}

export function detectIndexability(
  status?: string,
  path?: string,
  robotsOverride?: string | null,
  indexable?: boolean,
): string {
  if (indexable === false) {
    if (robotsOverride) {
      const parts = robotsTokens(robotsOverride);
      const hasNofollow = parts.some((p) => p === 'nofollow');
      const hasNone = parts.some((p) => p === 'none');
      if (hasNone) return 'none';
      if (hasNofollow) return 'noindex, nofollow';
      return 'noindex, follow';
    }
    return 'noindex, follow';
  }

  if (robotsOverride) {
    return robotsOverride;
  }

  if (status && status !== 'published') {
    return 'noindex, follow';
  }

  if (path && isServicePath(path)) {
    return 'noindex, follow';
  }

  return 'index, follow';
}
