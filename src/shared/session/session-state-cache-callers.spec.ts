import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { stripComments } from '../../common/testing/module-registration';

/**
 * Сторож мест записи версии сессий (`LEGACY-451`) — по образцу
 * `src/common/roles/roles-cache-callers.spec.ts` (`LEGACY-112`).
 *
 * `JwtStrategy` читает `{isActive, tokenVersion}` через `sessionStateCache` на `ROLES_CACHE_TTL_MS`.
 * Каждый подъём `tokenVersion` обязан сбросить кэш на своём экземпляре (решение арбитра
 * 10.10.2026, «сброс во всех точках инкремента»): иначе погашенный токен проходит ещё весь TTL.
 * Проверка конкретного метода такой гарантии не даёт — она молчит про подъём, который допишут
 * завтра. Поэтому перечень мест заморожен вместе с числом вхождений: новый подъём где угодно
 * в `src` роняет спеку и требует решения, а файл с подъёмом обязан звать
 * `sessionStateCache.invalidate`.
 *
 * ⚠️ Чего сторож не видит: запись `isActive` приходит в `UsersService.update` спредом DTO
 * (`...rest`), слова `isActive:` в записи нет. Сброс для неё держит условие рядом с подъёмом
 * версии (`dto.isActive !== undefined`) и спека `users.service.spec.ts`, блок «версия сессий».
 */

const SRC_ROOT = resolve(__dirname, '../..');
const BUMP_RE = /tokenVersion\s*(?::|=)\s*\{\s*increment\b/g;
const INVALIDATE_RE = /sessionStateCache\.invalidate\(/;

const EXPECTED: Record<string, { count: number; why: string }> = {
  'modules/users/users.service.ts': {
    count: 3,
    why: 'bumpTokenVersion (assignRole, revokeRole), update: пароль или блокировка, update: смена набора ролей',
  },
  'modules/auth/auth.service.ts': {
    count: 2,
    why: 'logout: updateMany с условием на версию токена; dropPasswordOnFirstLink: снятие пароля при первой привязке провайдера (LEGACY-454)',
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

function bumpSites(): Map<string, { count: number; invalidates: boolean }> {
  const sites = new Map<string, { count: number; invalidates: boolean }>();
  for (const path of sourceFiles(SRC_ROOT)) {
    const code = stripComments(readFileSync(path, 'utf8'));
    const count = code.match(BUMP_RE)?.length ?? 0;
    if (count === 0) continue;
    const file = relative(SRC_ROOT, path).split('\\').join('/');
    sites.set(file, { count, invalidates: INVALIDATE_RE.test(code) });
  }
  return sites;
}

describe('места подъёма tokenVersion сбрасывают sessionStateCache (LEGACY-451)', () => {
  const sites = bumpSites();

  it('перечень мест заморожен: новый подъём версии требует решения', () => {
    const actual = Object.fromEntries([...sites].map(([file, s]) => [file, s.count]));
    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([file, e]) => [file, e.count]),
    );
    expect(actual).toEqual(expected);
  });

  it.each(Object.keys(EXPECTED))('%s зовёт sessionStateCache.invalidate', (file) => {
    expect(sites.get(file)?.invalidates).toBe(true);
  });

  it('разбор видит хотя бы одно место — сторож не ослеп', () => {
    expect(sites.size).toBeGreaterThan(0);
  });
});
