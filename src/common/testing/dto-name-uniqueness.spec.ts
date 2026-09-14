import { readFileSync } from 'fs';
import * as ts from 'typescript';
import { SRC_ROOT, listFiles, relativeToSrc } from './controller-decorators';

/**
 * Сторож «имя экспортируемого класса уникально по всему `src`» (`LEGACY-016`, 14.09.2026).
 *
 * `@nestjs/swagger` именует схему по имени класса. Два экспортируемых класса с одинаковым именем
 * дают одну схему в `components.schemas`: второй молча вытесняет первого, а вместе с ним
 * из документа выпадают DTO, на которые ссылался только он. Сторож схемы ответа
 * (`scripts/check-response-schema.mjs`) сверяет маршрут с той схемой, что осталась, и отвечает
 * зелёным — на чужой форме. Ни `tsc`, ни линт, ни снимок OpenAPI этого не видят: снимок
 * сравнивает документ с закоммиченным и на уже вытесненном состоянии зелен.
 *
 * На 14.09.2026 таких имён было три (`CheckSlugQueryDto` в трёх разных формах, `PaginationMeta`
 * и `TagFaqDto` — попарно тождественные). Тождественные сведены в один класс, разные формы
 * переименованы по модулям. Вытеснения при этом ни разу не наблюдалось наружу — но только
 * потому, что совпадали формы; разойдись они, отличить это от исправной схемы было бы нечем.
 *
 * 🔴 Списка исключений здесь нет и быть не должно. Список — это baseline, запрещённый пачкой
 * `C19`: он разрешал бы конкретные пары навсегда, тогда как красное чинится именем класса.
 *
 * Проверяются **все** файлы `src`, а не только `dto/`: схему Swagger заводит по имени класса
 * независимо от того, где он объявлен, и одноимённый ответный класс за пределами `dto/`
 * вытеснит схему ровно так же.
 */

/** Ниже этого числа сломан обход, а не поредел репозиторий. */
const MIN_EXPORTED_CLASSES = 400;

const listSourceFiles = (): string[] =>
  listFiles(
    SRC_ROOT,
    (path) => path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.d.ts'),
  );

const exportedClassesOf = (file: string): string[] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const exported = (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported) names.push(node.name.text);
  });
  return names;
};

describe('имена экспортируемых классов уникальны по src', () => {
  const byName = new Map<string, string[]>();
  let total = 0;

  for (const file of listSourceFiles()) {
    for (const name of exportedClassesOf(file)) {
      total += 1;
      const where = byName.get(name) ?? [];
      where.push(relativeToSrc(file));
      byName.set(name, where);
    }
  }

  it('обход дошёл до всех классов', () => {
    expect(total).toBeGreaterThanOrEqual(MIN_EXPORTED_CLASSES);
  });

  it('ни одно имя класса не объявлено дважды', () => {
    const duplicated = [...byName.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(', ')}`)
      .sort();

    // Сообщение несёт и имя, и оба места: иначе красное читается как «где-то есть дубль».
    expect(duplicated).toEqual([]);
  });
});
