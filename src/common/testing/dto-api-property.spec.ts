import { readFileSync } from 'fs';
import { relative } from 'path';
import * as ts from 'typescript';
import { SRC_ROOT, listControllerFiles, listDtoFiles } from './controller-decorators';

/**
 * Сторож «поле DTO описано в OpenAPI» (`LEGACY-133`).
 *
 * Класс без `@ApiProperty` попадает в документ **пустым объектом**: валидация
 * при этом работает, в бэкенде последствий не видно вовсе, а во фронт уезжает
 * тип без полей — вместо ошибки компиляции получается молчаливое поведение
 * в духе `any`. Ни линт, ни `tsc`, ни тесты маршрутов этого не видят.
 *
 * ⚠️ Разбор через TypeScript compiler API, а не регуляркой. Текстовый сторож
 * того же назначения уже пробивали мутациями в этом репозитории: комментарий
 * `// @ApiProperty()` сходил за настоящий декоратор, а перенос строки прятал
 * объявление поля (`LEGACY-190`, решение арбитра 04.09.2026).
 *
 * ⚠️ Двух исключений не избежать, и оба заданы **признаком объявления**, а не
 * списком имён файлов: список пришлось бы дополнять при каждом новом DTO, и
 * первый же незаполненный случай выглядел бы как нарушение.
 *
 * - `private` — якорь валидатора вроде `_targetChoice` в `CreateCommentDto`:
 *   он не поле ответа и в документе ему делать нечего;
 * - `declare` — переобъявление унаследованного поля (`page`/`limit` из
 *   `PaginationDto` в `ListCommentsQueryDto`): метаданные Swagger приходят
 *   от базового класса, а `declare` не порождает рантайм-кода вовсе.
 *
 * Классы без собственных полей (`extends PartialType(CreateXDto)`) проверка
 * проходит сама собой: полей нет — требовать нечего, а метаданные `PartialType`
 * наследует.
 */

/** Ниже этих чисел сломан обход, а не поредел репозиторий. */
const MIN_DTO_FILES = 150;
const MIN_PROPERTIES = 2000;
const MIN_CONTROLLERS = 40;

const DTO_DECORATORS = ['ApiProperty', 'ApiPropertyOptional'];

const decoratorNames = (node: ts.Node): string[] =>
  (ts.getDecorators(node as ts.HasDecorators) ?? []).map((decorator) => {
    const expression = ts.isCallExpression(decorator.expression)
      ? decorator.expression.expression
      : decorator.expression;
    return expression.getText();
  });

const hasModifier = (node: ts.PropertyDeclaration, kind: ts.SyntaxKind): boolean =>
  (node.modifiers ?? []).some((modifier) => modifier.kind === kind);

describe('every DTO property is described in OpenAPI', () => {
  const files = listDtoFiles();

  let properties = 0;
  const undocumented: string[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;
        if (hasModifier(member, ts.SyntaxKind.DeclareKeyword)) continue;

        properties += 1;
        const names = decoratorNames(member);
        if (names.some((name) => DTO_DECORATORS.includes(name))) continue;

        const where = relative(SRC_ROOT, file).replace(/\\/g, '/');
        undocumented.push(`${where} → ${node.name.text}.${member.name.getText()}`);
      }
    });
  }

  it(`находит не меньше ${MIN_DTO_FILES} файлов dto`, () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_DTO_FILES);
  });

  it(`находит не меньше ${MIN_PROPERTIES} полей — разбор не осыпался`, () => {
    expect(properties).toBeGreaterThanOrEqual(MIN_PROPERTIES);
  });

  it('не оставляет ни одного поля DTO без @ApiProperty', () => {
    expect(undocumented).toEqual([]);
  });
});

/**
 * Вторая половина `LEGACY-133`, и без неё первая половину дефекта не ловит
 * вовсе: `PublicUserDto` и `AuthResponse` до 05.09.2026 лежали **внутри**
 * `users.controller.ts` и `auth.controller.ts`, то есть под шаблон
 * `dto/**.dto.ts` не попадали. Сторож, проверяющий только каталог `dto/`,
 * зеленел бы на том самом коде, ради которого он написан (найдено ревью
 * в этом же заходе).
 *
 * Правило записи: «DTO не живут в файле контроллера — только в папке `dto/`».
 * Здесь оно и проверяется: единственный класс, которому место в
 * `*.controller.ts`, — сам контроллер.
 */
describe('controllers declare no DTO classes of their own', () => {
  const files = listControllerFiles();
  const declared: string[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      if (decoratorNames(node).includes('Controller')) return;

      const where = relative(SRC_ROOT, file).replace(/\\/g, '/');
      declared.push(`${where} → class ${node.name.text}`);
    });
  }

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it('не оставляет ни одного класса, объявленного в файле контроллера', () => {
    expect(declared).toEqual([]);
  });
});
