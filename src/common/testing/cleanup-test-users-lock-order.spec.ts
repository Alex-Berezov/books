import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as ts from 'typescript';
import { SRC_ROOT } from './controller-decorators';

/**
 * Сторож порядка замков в `prisma/scripts/cleanup-test-users.ts` (`LEGACY-015`, `T44`/`T60`).
 *
 * Скрипт запирает строку `User` первым оператором транзакции — тем же порядком, что держат
 * писатели ролей (`lockUserRow` в `UsersService.deleteById`), иначе каскадное удаление тестового
 * пользователя встречается с ними во взаимной блокировке (`40P01`). Скрипт лежит вне `src/`,
 * `jest` его не видит, и возврат обратного порядка компилируется молча.
 *
 * Разбор компилятором, а не регулярками (решение арбитра 28.09.2026, `decisions-log.md`): правило
 * «первым оператором» проверяется по дереву, и комментарии, ленивый `$queryRaw` без `await`,
 * `Promise.all`, запись через хелпер или сырой SQL до замка отсекаются структурой. Скрипт перейдёт
 * на `lockUserRow(tx, …)` — сторож правится вместе с ним, а не ослабляется.
 */

const SCRIPT_PATH = resolve(SRC_ROOT, '../prisma/scripts/cleanup-test-users.ts');

/** Замок одной строки `User` по id: сразу `WHERE id = ${…}`, конец на `FOR UPDATE`, без `OF`. */
const LOCK_SQL_RE =
  /^\s*SELECT\b[^`]*?\bFROM\s+"User"\s+WHERE\s+id\s*=\s*\$\{[^}]+\}\s+FOR\s+UPDATE\s*$/;

const NOT_CALLBACK = '$transaction без колбэка с одним клиентом';
const NOT_LOCK = 'первый оператор колбэка не замок "User" его клиентом';

type LockOrder = { transactions: number; violations: string[] };

const isUserLock = (statement: ts.Statement, client: string, source: ts.SourceFile): boolean => {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
    return false;
  }
  const tagged = statement.expression.expression;
  if (!ts.isTaggedTemplateExpression(tagged) || !ts.isPropertyAccessExpression(tagged.tag)) {
    return false;
  }
  const { expression, name } = tagged.tag;
  if (!ts.isIdentifier(expression) || expression.text !== client || name.text !== '$queryRaw') {
    return false;
  }
  return LOCK_SQL_RE.test(tagged.template.getText(source).slice(1, -1));
};

/** Колбэк транзакции с одним клиентом-идентификатором и телом-блоком: имя клиента и тело, иначе `null`. */
const transactionCallback = (
  arg: ts.Expression | undefined,
): { client: string; body: ts.Block } | null => {
  if (arg === undefined || !(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return null;
  const [param, ...rest] = arg.parameters;
  if (param === undefined || rest.length > 0 || !ts.isIdentifier(param.name)) return null;
  return ts.isBlock(arg.body) ? { client: param.name.text, body: arg.body } : null;
};

/** Каждый вызов `$transaction`: колбэк с одним клиентом, и его первый оператор — замок `User`. */
const checkLockOrder = (text: string): LockOrder => {
  const source = ts.createSourceFile('cleanup-test-users.ts', text, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  let transactions = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === '$transaction'
    ) {
      transactions++;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const callback = transactionCallback(node.arguments[0]);
      if (callback === null) {
        violations.push(`строка ${line}: ${NOT_CALLBACK}`);
      } else {
        const first = callback.body.statements[0];
        if (first === undefined || !isUserLock(first, callback.client, source)) {
          violations.push(`строка ${line}: ${NOT_LOCK}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { transactions, violations };
};

const LOCK = '    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;';
const ROLES = '    await tx.userRole.deleteMany({ where: { userId } });';

const script = (body: string[]): string =>
  [
    'async function drop(userId: string) {',
    '  await prisma.$transaction(async (tx) => {',
    ...body,
    '    await tx.user.delete({ where: { id: userId } });',
    '  });',
    '}',
  ].join('\n');

/** Подмена с проверкой якоря: пропавший якорь иначе молча оставляет вход чистым. */
const swap = (text: string, from: string, to: string): string => {
  if (!text.includes(from)) throw new Error(`якорь не найден: ${from}`);
  return text.replace(from, to);
};

const LINE = 'строка 2: ';

describe('cleanup-test-users.ts запирает User первым оператором транзакции (LEGACY-015, T60)', () => {
  const result = checkLockOrder(readFileSync(SCRIPT_PATH, 'utf8'));

  it('в скрипте найдена ровно одна транзакция — пустой разбор не сходит за порядок', () => {
    expect(result.transactions).toBe(1);
  });

  it('первый оператор транзакции — замок "User" её клиентом', () => {
    expect(result.violations).toEqual([]);
  });

  describe('самопроверка разбора', () => {
    it('пропускает верный порядок и при другом имени клиента', () => {
      const clean = script([LOCK, ROLES]);
      expect(checkLockOrder(clean)).toEqual({ transactions: 1, violations: [] });
      const renamed = clean.replace(/\btx\b/g, 'trx');
      expect(renamed).toContain('async (trx)');
      expect(checkLockOrder(renamed)).toEqual({ transactions: 1, violations: [] });
    });

    it.each([
      ['запись раньше замка', [ROLES, LOCK]],
      ['замок без await (ленивый PrismaPromise)', [swap(LOCK, 'await tx', 'void tx'), ROLES]],
      [
        'замок и запись в Promise.all',
        [
          '    await Promise.all([',
          `      ${swap(LOCK, '    await ', '').replace(/;$/, ',')}`,
          '      tx.userRole.deleteMany({ where: { userId } }),',
          '    ]);',
        ],
      ],
      [
        'сырая запись через $queryRaw раньше замка',
        ['    await tx.$queryRaw`DELETE FROM "UserRole" WHERE "userId" = ${userId}`;', LOCK],
      ],
      ['запись через хелпер раньше замка', ['    await wipeRoles(tx, userId);', LOCK]],
      [
        'цепочка с переносом строки раньше замка',
        ['    await tx.userRole', '      .deleteMany({ where: { userId } });', LOCK],
      ],
      ['замок в комментарии', [`    // ${LOCK.trim()}`, ROLES]],
      ['замок в хвостовом комментарии', [`${ROLES} // ${LOCK.trim()}`]],
      ['замок корневым клиентом', [swap(LOCK, 'tx.$queryRaw', 'prisma.$queryRaw'), ROLES]],
      ['замок чужой таблицы', [swap(LOCK, '"User"', '"UserRole"'), ROLES]],
      [
        'замок через JOIN',
        [
          swap(LOCK, '"User" WHERE', '"User" u JOIN "UserRole" r ON r."userId" = u.id WHERE'),
          ROLES,
        ],
      ],
      ['FOR UPDATE OF', [swap(LOCK, 'FOR UPDATE', 'FOR UPDATE OF "User"'), ROLES]],
      ['замок не по id', [swap(LOCK, 'WHERE id =', 'WHERE email ='), ROLES]],
      ['слабее: FOR NO KEY UPDATE', [swap(LOCK, 'FOR UPDATE', 'FOR NO KEY UPDATE'), ROLES]],
      ['слабее: FOR SHARE', [swap(LOCK, 'FOR UPDATE', 'FOR SHARE'), ROLES]],
      ['без ожидания: SKIP LOCKED', [swap(LOCK, 'FOR UPDATE', 'FOR UPDATE SKIP LOCKED'), ROLES]],
      ['без ожидания: NOWAIT', [swap(LOCK, 'FOR UPDATE', 'FOR UPDATE NOWAIT'), ROLES]],
    ])('ловит: %s', (_case, body) => {
      expect(checkLockOrder(script(body))).toEqual({
        transactions: 1,
        violations: [`${LINE}${NOT_LOCK}`],
      });
    });

    it('ловит транзакцию массивом и колбэк не с одним клиентом', () => {
      const asArray = [
        'async function drop(userId: string) {',
        '  await prisma.$transaction([prisma.userRole.deleteMany({ where: { userId } })]);',
        '}',
      ].join('\n');
      const twoParams = swap(script([LOCK, ROLES]), 'async (tx)', 'async (tx, extra)');

      expect(checkLockOrder(asArray).violations).toEqual([`${LINE}${NOT_CALLBACK}`]);
      expect(checkLockOrder(twoParams).violations).toEqual([`${LINE}${NOT_CALLBACK}`]);
    });

    it('считает каждую транзакцию: вторая без замка не прячется за первой', () => {
      const two = [script([LOCK, ROLES]), script([ROLES])].join('\n');
      expect(checkLockOrder(two)).toEqual({
        transactions: 2,
        violations: [`строка 9: ${NOT_LOCK}`],
      });
    });
  });
});
