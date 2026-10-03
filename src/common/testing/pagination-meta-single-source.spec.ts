import { readFileSync } from 'fs';
import * as ts from 'typescript';
import { SRC_ROOT, listFiles, relativeToSrc } from './controller-decorators';

/**
 * Мета пагинации `{page, limit, total, totalPages}` описана один раз — `PaginationInfoDto`
 * в `shared/dto/paginated-response.dto.ts` (`LEGACY-016`, пачка `T42`).
 *
 * До 26.09.2026 рядом жили копия-класс `BookCardsPaginationDto` (пять DTO-импортёров,
 * отдельный компонент в снимке OpenAPI) и семь рукописных повторов формы в сервисах.
 * Правка формы — например, `hasNext` из `LEGACY-177` — шла бы по всем копиям, и пропущенная
 * давала бы фронту красный `check:type-sync` на маршруте, чей код никто не трогал.
 *
 * Сторож ищет в `src` класс, интерфейс или литерал типа, чьи собственные поля — ровно эти
 * четыре имени. Наследник с добавленным полем (`PaginationWithNextDto`) копией не считается.
 * Вычисление стережёт второй блок ниже (`T82`): `totalPages` считается только через
 * `totalPagesOf`, кроме названного исключения аудиоглав.
 */
const META_FIELDS = ['limit', 'page', 'total', 'totalPages'];
const SOURCE = 'shared/dto/paginated-response.dto.ts#PaginationInfoDto';

const memberNames = (members: ts.NodeArray<ts.ClassElement | ts.TypeElement>): string[] =>
  members
    .filter((m) => ts.isPropertyDeclaration(m) || ts.isPropertySignature(m))
    .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : ''))
    .sort();

const findMetaShapes = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let members: ts.NodeArray<ts.ClassElement | ts.TypeElement> | undefined;
    let name = '<литерал типа>';
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      members = node.members;
      name = node.name?.text ?? '<без имени>';
    } else if (ts.isTypeLiteralNode(node)) {
      members = node.members;
    }
    if (members && memberNames(members).join(',') === META_FIELDS.join(',')) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${relativeToSrc(file)}:${line + 1}#${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('LEGACY-016: мета пагинации описана одним классом', () => {
  it('в src нет второй формы {page, limit, total, totalPages}', () => {
    const files = listFiles(SRC_ROOT, (p) => p.endsWith('.ts') && !p.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(500);
    const shapes = files.flatMap((file) => findMetaShapes(file, readFileSync(file, 'utf8')));
    const copies = shapes.filter((s) => !s.startsWith('shared/dto/paginated-response.dto.ts:'));
    expect(shapes.map((s) => s.replace(/:\d+#/, '#'))).toContain(SOURCE);
    expect(copies).toEqual([]);
  });

  it('проба на отказ: копия-класс, интерфейс и литерал типа находятся', () => {
    const text = [
      'export class BookCardsPaginationDto { page!: number; limit!: number; total!: number; totalPages!: number; }',
      'interface Meta { page: number; limit: number; total: number; totalPages: number }',
      'type R = { pagination: { page: number; limit: number; total: number; totalPages: number } };',
      'class WithNext { page!: number; limit!: number; total!: number; totalPages!: number; hasNext!: boolean; }',
    ].join('\n');
    const found = findMetaShapes(`${SRC_ROOT}/probe.ts`, text);
    expect(found).toEqual([
      'probe.ts:1#BookCardsPaginationDto',
      'probe.ts:2#Meta',
      'probe.ts:3#<литерал типа>',
    ]);
  });
});

/**
 * `T82` (`LEGACY-016`): число страниц считается одним правилом — `totalPagesOf`.
 *
 * До 01.10.2026 десять мест в сервисах считали его сами голым `Math.ceil(total / limit)`,
 * и при `limit = 0` давали `NaN`/`Infinity` везде, где мета уходила в ответ как есть.
 * Сторож ищет значение, которое уходит в `totalPages`: поле объекта (с любым ключом),
 * переменную того же имени (её потом кладут сокращённой записью) или присваивание
 * `totalPages = …` / `x.totalPages = …`. Ручной подсчёт — деление или вызов `Math.*`
 * **вне** вызова `totalPagesOf`, а также числовой литерал (`totalPages: 0` на пустом раннем
 * выходе): пустой ответ собирается `paginated([], …)` (`T91`, 03.10.2026).
 * ⚠️ Чего сторож не видит — поток данных синтаксисом не прослеживается: подсчёт в переменной
 * с другим именем (`const pages = Math.ceil(…); … totalPages: pages`), в обёртке-помощнике
 * с другим именем (`totalPages: pageCount(total, limit)`), в поле класса и геттере
 * (`totalPages = …` в теле класса, `get totalPages()`). Сторож держит привычные формы,
 * а не любой обход.
 */
const TOTAL_PAGES_EXCEPTIONS = [
  // Плоская форма аудиоглав отдаёт на пустом списке 1 (арбитр 01.10.2026, `decisions-log.md`).
  // Одно место на файл: второе такое же в нём же — уже новое исключение, а не это.
  'modules/audio-chapter/audio-chapter.service.ts',
];

const isTotalPagesName = (name: ts.Node): boolean =>
  (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'totalPages';

/** Литерал и под скобками, `as`, `satisfies` и унарным знаком: `(0)`, `0 as number`, `-1`. */
const isNumberLiteral = (node: ts.Node): boolean => {
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isPrefixUnaryExpression(node)) return isNumberLiteral(node.operand);
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return isNumberLiteral(node.expression);
  }
  return false;
};

const countsByHand = (value: ts.Node): boolean => {
  if (isNumberLiteral(value)) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'totalPagesOf'
    ) {
      return;
    }
    if (
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.SlashToken) ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Math')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(value);
  return found;
};

const totalPagesValue = (node: ts.Node): ts.Expression | undefined => {
  if (ts.isPropertyAssignment(node) && isTotalPagesName(node.name)) return node.initializer;
  if (ts.isVariableDeclaration(node) && isTotalPagesName(node.name)) return node.initializer;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    (isTotalPagesName(node.left) ||
      (ts.isPropertyAccessExpression(node.left) && isTotalPagesName(node.left.name)) ||
      (ts.isElementAccessExpression(node.left) && isTotalPagesName(node.left.argumentExpression)))
  ) {
    return node.right;
  }
  return undefined;
};

const findHandCountedTotalPages = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const value = totalPagesValue(node);
    if (value && countsByHand(value)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${relativeToSrc(file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('LEGACY-016: totalPages считается одним правилом', () => {
  it('в src нет totalPages, посчитанного мимо totalPagesOf', () => {
    const files = listFiles(SRC_ROOT, (p) => p.endsWith('.ts') && !p.endsWith('.spec.ts'));
    const found = files.flatMap((file) =>
      findHandCountedTotalPages(file, readFileSync(file, 'utf8')),
    );
    // Лишняя строка в выводе — новое место ручного подсчёта (или второе в файле исключения).
    expect(found.map((f) => f.replace(/:\d+$/, ''))).toEqual(TOTAL_PAGES_EXCEPTIONS);
  });

  it('проба на отказ: все формы ручного подсчёта и литерал находятся, помощник — нет', () => {
    const text = [
      'const a = { totalPages: Math.ceil(total / limit) };',
      'const b = { totalPages: total === 0 ? 0 : Math.ceil(total / limit) };',
      'const totalPages = Math.ceil(total / limit);',
      "const c = { 'totalPages': Math.ceil(total / limit) };",
      'meta.totalPages = Math.ceil(total / limit);',
      "meta['totalPages'] = total / limit;",
      'totalPages = Math.ceil(total / limit);',
      'const d = { totalPages: 0 };',
      'const g = { totalPages: (0) as number };',
      'const h = { totalPages: -1 };',
      'const e = { totalPages: totalPagesOf(total, limit) };',
      'const f = { totalPages: totalPagesOf(Math.max(total, 0), limit / 2) };',
    ].join('\n');
    expect(findHandCountedTotalPages(`${SRC_ROOT}/probe.ts`, text)).toEqual([
      'probe.ts:1',
      'probe.ts:2',
      'probe.ts:3',
      'probe.ts:4',
      'probe.ts:5',
      'probe.ts:6',
      'probe.ts:7',
      'probe.ts:8',
      'probe.ts:9',
      'probe.ts:10',
    ]);
  });
});
