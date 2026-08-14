import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

/**
 * Сторож перечня мест записи в `UserRole` (`LEGACY-112`).
 *
 * Кэш ролей живёт до истечения `ROLES_CACHE_TTL_MS`, поэтому каждая запись
 * в таблицу обязана либо сбросить его, либо иметь записанную причину, по
 * которой сброс не нужен. Проверка спеки на конкретный метод такой гарантии не
 * даёт: она молчит про метод, который допишут завтра.
 *
 * ⚠️ Считаются **места, а не методы**. В пачке `B3` защиту утверждали для
 * четырёх операций, а наложена она была на тринадцать, и дыру нашло ревью.
 * Здесь перечень заморожен вместе с числом вхождений: любая новая запись
 * в `UserRole` — где угодно в `src` — роняет спеку и требует решения.
 */

const SRC_ROOT = resolve(__dirname, '../..');

const WRITE_OPS = 'create|createMany|upsert|delete|deleteMany|update|updateMany';
const WRITE_RE = new RegExp(`userRole\\.(?:${WRITE_OPS})\\b`, 'g');

type Site = { file: string; op: string };

/**
 * Замороженный перечень. `invalidated` — сброс кэша стоит рядом с записью;
 * `exempt` — сброс не нужен, и почему.
 */
const EXPECTED: Array<Site & { count: number; verdict: 'invalidated' | 'exempt'; why: string }> = [
  {
    file: 'modules/users/users.service.ts',
    op: 'upsert',
    count: 1,
    verdict: 'invalidated',
    why: 'assignRole — роль выдана уже существующему пользователю',
  },
  {
    file: 'modules/users/users.service.ts',
    op: 'delete',
    count: 1,
    verdict: 'invalidated',
    why: 'revokeRole — снятая роль обязана перестать действовать сразу',
  },
  {
    file: 'modules/users/users.service.ts',
    op: 'deleteMany',
    count: 2,
    verdict: 'invalidated',
    why: 'deleteById и замена набора ролей в админском update',
  },
  {
    file: 'modules/users/users.service.ts',
    op: 'createMany',
    count: 1,
    verdict: 'invalidated',
    why: 'админский update: новый набор ролей вместо прежнего',
  },
  {
    file: 'modules/auth/auth.service.ts',
    op: 'upsert',
    count: 4,
    verdict: 'exempt',
    why: 'register и вход через провайдера пишут роли пользователю, созданному строкой выше: записи в кэше для такого userId ещё нет',
  },
];

const listSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    return entry.name.endsWith('.spec.ts') ? [] : [full];
  });

const key = (site: Site): string => `${site.file} → userRole.${site.op}`;

describe('места записи в UserRole и сброс кэша ролей', () => {
  const found = new Map<string, number>();
  const filesWithWrites = new Set<string>();

  for (const file of listSources(SRC_ROOT)) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
    for (const match of content.matchAll(WRITE_RE)) {
      const op = match[0].split('.')[1];
      const id = key({ file: rel, op });
      found.set(id, (found.get(id) ?? 0) + 1);
      filesWithWrites.add(rel);
    }
  }

  it('перечень мест записи не изменился', () => {
    const expected = Object.fromEntries(EXPECTED.map((s) => [key(s), s.count]));
    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries(Object.entries(expected).sort()),
    );
  });

  it('каждое место, которому нужен сброс, стоит рядом с вызовом invalidate', () => {
    const missing = EXPECTED.filter((s) => s.verdict === 'invalidated')
      .map((s) => s.file)
      .filter((file) => {
        const content = readFileSync(join(SRC_ROOT, file), 'utf8');
        return !content.includes('rolesCache.invalidate(');
      });
    expect(missing).toEqual([]);
  });

  it('освобождённых от сброса мест ровно столько, сколько записано причин', () => {
    const exemptFiles = EXPECTED.filter((s) => s.verdict === 'exempt').map((s) => s.file);
    for (const file of filesWithWrites) {
      const listed = EXPECTED.some((s) => s.file === file);
      expect(listed ? file : `${file} (нет в перечне)`).toBe(file);
    }
    // Причина у освобождённого места обязана быть непустой: без неё запись
    // в перечне превращается в разрешение молчать.
    for (const site of EXPECTED.filter((s) => s.verdict === 'exempt')) {
      expect(site.why.length).toBeGreaterThan(20);
    }
    expect(exemptFiles.length).toBeGreaterThan(0);
  });
});
