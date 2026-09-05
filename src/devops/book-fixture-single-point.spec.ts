import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { listFiles } from '../common/testing/controller-decorators';

/**
 * Инвариант единственной точки шортката для `LEGACY-039`: запись в `Book` внутри `test/`
 * живёт ровно в одном файле — `test/helpers/book-fixture.ts`.
 *
 * Пара к нему — `test/book-creation-ban.e2e-spec.ts`: там HTTP-половина того же запрета
 * (`POST /books` отбивается и не создаёт строки; `create-book` по неутверждённому клиренсу
 * отбивается и не создаёт строки). Один без другого закрывает запись наполовину: тот проверяет,
 * что продуктовый путь закрыт, этот — что фикстуры не растащили обход обратно по файлам.
 *
 * Почему не в `test/`, где лежит пара. Гейт `e2e` включается только правкой контроллеров —
 * его `when` в `.claude/hooks/rules.books.json` сужен до глоба по `src/modules` и суффиксу
 * `.controller.ts`, — а нарушают этот инвариант ровно тест-онли диффы: на них он молчал бы
 * до job `e2e` в CI, то есть уже после коммита. Здесь он идёт под `yarn test` (`when: always`): гейты, `pre-push`, шаг unit
 * в `scripts/ci.sh`. Решение арбитра от 05.09.2026, `books-app-docs/ai-context/decisions-log.md`.
 *
 * Почему компилятором, а не регулярками. Текстовый сторож надо чистить от комментариев,
 * и чистка регуляркой роет себе яму: открывающая пара символов внутри строкового литерала —
 * а такая живёт в `test/import-taxonomy.e2e-spec.ts`, в заголовке `describe` про маршрут
 * импорта, — открывает «комментарий», который не закрывается до конца файла, и хвост перестаёт
 * просматриваться вовсе при зелёном стороже. У разбора такой
 * ямы нет: строки и комментарии для него не код. Приём в репозитории не новый: тем же
 * компилятором сажался инвариант `select` в `auth.service.spec.ts` (`LEGACY-190`).
 *
 * ⚠️ Периметр — `test/`. Второй прямой вход в `Book` в контуре e2e существует и сюда не входит:
 * `prisma/seed.ts` заводит книгу `upsert`'ом в шаблонную базу, откуда она разливается по базам
 * воркеров. Это продуктовый сид, а не фикстура набора; зелёный сторож не означает, что книг мимо
 * клиренса в базе нет.
 */
const TEST_ROOT = path.resolve(__dirname, '../../test');

/** Все методы Prisma, которыми создаётся строка. Только `create` оставляло четыре обхода. */
const WRITE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

/** Вложенная запись через связь: `bookVersion.create({ data: { book: { create: … } } })`. */
const NESTED_WRITE_KEYS = new Set(['create', 'connectOrCreate', 'createMany']);

/** Имя ключа объекта: идентификатор или строковый литерал. */
const nameOf = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;

/** `a.b.c` и `a['b'].c` — в плоский список сегментов; всё остальное — `null`. */
const segmentsOf = (expression: ts.Expression): string[] | null => {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
  if (ts.isPropertyAccessExpression(expression)) {
    const head = segmentsOf(expression.expression);
    return head ? [...head, expression.name.text] : null;
  }
  if (ts.isElementAccessExpression(expression)) {
    const head = segmentsOf(expression.expression);
    const key = expression.argumentExpression;
    if (!head || !ts.isStringLiteralLike(key)) return null;
    return [...head, key.text];
  }
  return null;
};

const writesBook = (file: string): boolean => {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isCallExpression(node)) {
      const segments = segmentsOf(node.expression);
      if (segments && segments.length >= 2) {
        // Форма вызова, а не литерал `prisma.book.create`: переименование клиента
        // (`db`, `tx`, деструктуризация `const { book } = prisma`) не выводит запись
        // из-под сторожа.
        const method = segments[segments.length - 1];
        const model = segments[segments.length - 2];
        if (model === 'book' && WRITE_METHODS.has(method)) found = true;
      }
    }

    if (ts.isPropertyAssignment(node) && nameOf(node.name) === 'book') {
      const nested = node.initializer;
      if (
        ts.isObjectLiteralExpression(nested) &&
        nested.properties.some((property) => {
          const key = property.name ? nameOf(property.name) : null;
          return key !== null && NESTED_WRITE_KEYS.has(key);
        })
      ) {
        found = true;
      }
    }

    // Сырой SQL мимо делегата: `$executeRawUnsafe('INSERT INTO "Book" …')`.
    if (ts.isStringLiteralLike(node) && /insert\s+into\s+"?book"?/i.test(node.text)) {
      found = true;
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
};

describe('LEGACY-039: запись в Book из тестов идёт одной точкой', () => {
  it('в test/ книгу заводит ровно один файл', () => {
    // Обход каталога — общий `listFiles` (`LEGACY-290`): восьмая рукописная копия
    // `readdirSync` расходится с остальными молча.
    const offenders = listFiles(TEST_ROOT, (file) => file.endsWith('.ts'))
      .filter((file) => writesBook(file))
      .map((file) => path.relative(TEST_ROOT, file).split(path.sep).join('/'));

    expect(offenders).toEqual(['helpers/book-fixture.ts']);
  });

  it('сама точка шортката на месте и заводит книгу', () => {
    const fixture = path.join(TEST_ROOT, 'helpers', 'book-fixture.ts');

    expect(fs.existsSync(fixture)).toBe(true);
    expect(writesBook(fixture)).toBe(true);
  });
});
