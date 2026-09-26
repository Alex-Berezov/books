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
 * ⚠️ Стережёт объявления формы, а не вычисление: сервисы, считающие `totalPages` сами мимо
 * `paginated()`, отсюда не видны — они перечислены в теле `LEGACY-016`.
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
