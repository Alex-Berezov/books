import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import * as ts from 'typescript';

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
 *
 * ⚠️ Запись в `UserRole` бывает **двух форм**, и сторож ловит обе. Прямая —
 * `prisma.userRole.<op>(...)`. Вложенная — `roles: { create | connect | set | ... }`
 * внутри `user.create`/`user.update` (`T67`, `LEGACY-015`): роль пишется той же
 * вставкой, что и строка `User`, и слово `userRole` в исходнике не встречается
 * вовсе. До `T67` сторож видел только прямую форму, и вложенная запись
 * в `users.service.ts` (`create`) была для него слепым пятном.
 */

const SRC_ROOT = resolve(__dirname, '../..');

const WRITE_OPS = 'create|createMany|upsert|delete|deleteMany|update|updateMany';
const DIRECT_WRITE_RE = new RegExp(`userRole\\.(?<op>${WRITE_OPS})\\b`, 'g');

const NESTED_OPS = new Set([
  'create',
  'createMany',
  'connect',
  'connectOrCreate',
  'set',
  'upsert',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'disconnect',
]);

/**
 * Вложенная запись ищется по дереву компилятора, а не регуляркой: у сторожей
 * по исходнику в этом репозитории регулярки уже дважды латались после переноса
 * строк, комментариев и фигурной скобки в строковом литерале (`C7`/`LEGACY-190`,
 * `L-027`; тот же приём у шести сторожей в `src/common/testing`). Берётся каждое
 * свойство `roles` (со стороны `User`) или `users` (со стороны `Role`), чьё значение
 * дотягивается до объектного литерала — напрямую, через обе ветки тернарника,
 * `&&`/`??`/`||`, скобки, `as`/`satisfies`/`!` — и в нём **все** свойства первого
 * уровня с именем операции записи. `{ deleteMany: {}, create }` даёт две операции,
 * `roles: { some: }` / `{ select: }` / `{ where: }` — ни одной: их нет в `NESTED_OPS`.
 *
 * Чего разбор не видит: значение, собранное заранее (`roles: rolesInput`, `{ roles }`)
 * или присвоенное вне литерала (`data.roles = {...}`). Это записано, а не
 * подразумевается: такую форму ловит только ревью.
 */
const NESTED_RELATIONS = new Set(['roles', 'users']);

type NestedWrite = { relation: string; op: string };

const objectLiterals = (e: ts.Expression): ts.ObjectLiteralExpression[] => {
  if (ts.isObjectLiteralExpression(e)) return [e];
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    return objectLiterals(e.expression);
  }
  if (ts.isConditionalExpression(e)) {
    return [...objectLiterals(e.whenTrue), ...objectLiterals(e.whenFalse)];
  }
  if (ts.isBinaryExpression(e)) return [...objectLiterals(e.left), ...objectLiterals(e.right)];
  return [];
};

const propertyName = (p: ts.ObjectLiteralElementLike): string | null => {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
  return ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
};

const nestedWrites = (text: string): NestedWrite[] => {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const out: NestedWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const relation = propertyName(node);
      if (relation !== null && NESTED_RELATIONS.has(relation)) {
        for (const literal of objectLiterals(node.initializer)) {
          for (const p of literal.properties) {
            const op = propertyName(p);
            if (op !== null && NESTED_OPS.has(op)) out.push({ relation, op });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
};

type Site = { file: string; op: string };

/**
 * Замороженный перечень. `invalidated` — сброс кэша стоит рядом с записью;
 * `exempt` — сброс не нужен, и почему.
 */
const EXPECTED: Array<Site & { count: number; verdict: 'invalidated' | 'exempt'; why: string }> = [
  {
    file: 'modules/users/users.service.ts',
    op: 'createMany',
    count: 2,
    verdict: 'invalidated',
    why: 'assignRole (вставка с skipDuplicates: count даёт признак изменения состояния для журнала LEGACY-015) и админский update (новый набор ролей вместо прежнего)',
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
    file: 'modules/auth/auth.service.ts',
    op: 'createMany',
    count: 1,
    verdict: 'exempt',
    why: 'register (grantRegistrationRoles, LEGACY-015 T43) пишет роли пользователю, созданному строкой выше: записи в кэше для такого userId ещё нет; count вставки — признак изменения для журнала',
  },
  {
    file: 'modules/auth/auth.service.ts',
    op: 'roles.create',
    count: 1,
    verdict: 'exempt',
    why: 'вход через провайдера (createSocialUser, LEGACY-015 T67) пишет базовую роль вложенной записью в сам user.create: строка User появляется уже с ролью, записи в кэше для такого userId ещё нет',
  },
  {
    file: 'modules/users/users.service.ts',
    op: 'roles.create',
    count: 1,
    verdict: 'exempt',
    why: 'админский create пишет роли вложенной записью в user.create: записи в кэше для нового userId ещё нет (место лежало в коде до T67, сторож его не видел)',
  },
];

const listSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    return entry.name.endsWith('.spec.ts') ? [] : [full];
  });

const key = (site: Site): string =>
  site.op.includes('.') ? `${site.file} → data.${site.op}` : `${site.file} → userRole.${site.op}`;

describe('места записи в UserRole и сброс кэша ролей', () => {
  const found = new Map<string, number>();
  const filesWithWrites = new Set<string>();

  for (const file of listSources(SRC_ROOT)) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
    for (const match of content.matchAll(DIRECT_WRITE_RE)) {
      const id = key({ file: rel, op: match.groups!.op });
      found.set(id, (found.get(id) ?? 0) + 1);
      filesWithWrites.add(rel);
    }
    for (const w of nestedWrites(content)) {
      const id = key({ file: rel, op: `${w.relation}.${w.op}` });
      found.set(id, (found.get(id) ?? 0) + 1);
      filesWithWrites.add(rel);
    }
  }

  // Проба самого разбора на плохом и чистом входе: сторож, который не проверен
  // на образцах, стережёт только те формы, что уже лежат в `src` (L-017).
  it('разбор вложенной записи ловит формы записи и не считает чтения', () => {
    const inData = (body: string): string => `const q = { data: { ${body} } };`;
    const probe = (source: string): string[] =>
      nestedWrites(source).map((w) => `${w.relation}.${w.op}`);

    const writes: Array<[string, string[]]> = [
      [inData('roles: { create: { roleId } }'), ['roles.create']],
      [
        inData('roles: userRole ? { create: { roleId: userRole.id } } : undefined'),
        ['roles.create'],
      ],
      [
        inData('roles: dto.roles?.length ? { deleteMany: {}, create: [] } : undefined'),
        ['roles.deleteMany', 'roles.create'],
      ],
      [inData('roles: !skip && { connect: { id } }'), ['roles.connect']],
      [
        inData('roles: keep ? { connect: { id } } : { create: { roleId } }'),
        ['roles.connect', 'roles.create'],
      ],
      [
        inData('roles: cond ? undefined : { create: { roleId } }, name: { set: x }'),
        ['roles.create'],
      ],
      [
        inData('roles: veryLongCondition\n  ? { create: { roleId } }\n  : undefined,'),
        ['roles.create'],
      ],
      [inData("'roles' : {\n  // comment\n  /* multi */ set: [] }"), ['roles.set']],
      [inData('roles: { deleteMany: {}, create }'), ['roles.deleteMany', 'roles.create']],
      [
        inData("avatarUrl: 'https://x.test/a.png', roles: { create: { roleId } }"),
        ['roles.create'],
      ],
      [inData("roles: fn('{') ? { create: x } : undefined"), ['roles.create']],
      [inData('users: { connectOrCreate: { where, create } }'), ['users.connectOrCreate']],
      [
        inData(
          'roles: {\n  create: (list || []).map((r) => ({ role: { connect: { name: r } } })),\n}',
        ),
        ['roles.create'],
      ],
    ];
    for (const [input, expected] of writes) {
      expect({ input, ops: probe(input) }).toEqual({ input, ops: expected });
    }

    const reads = [
      inData('roles: { some: { role: { name: { in: names } } } }'),
      inData('roles: { select: { role: { select: { name: true } } } }'),
      inData('roles: { where: { roleId } }'),
      inData('NOT: { roles: { some: { role: { name: x } } } }'),
      inData('roles: rolesByUser.get(u.id) ?? new Set()'),
      inData('users: items.map((u) => ({ id: u.id, set: true }))'),
      'type Entry = { roles: Set<Role>; exp: number };',
      'const { roles } = dto; const y = { roles };',
    ];
    for (const input of reads) {
      expect({ input, ops: probe(input) }).toEqual({ input, ops: [] });
    }
  });

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
