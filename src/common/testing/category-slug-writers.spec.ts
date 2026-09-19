import { readFileSync } from 'fs';
import { SRC_ROOT, listFiles, relativeToSrc } from './controller-decorators';

/**
 * Сторож перечня писателей `Category.slug` (`LEGACY-276`).
 *
 * Пару «проверил слаг — записал» держат **два** рубежа, и они не взаимозаменяемы:
 * advisory-замок по хешу слага, который берут входы `CategoryTreeService.runInTree`
 * и `runInLockedTree` необязательным вторым аргументом, и `@@unique([slug])` в базе —
 * индекс `Category_slug_key`, снесённый `20250830151000_add_taxonomy_translations`
 * и возвращённый `20260919170000_legacy_276_category_slug_unique` (релиз 2 записи).
 *
 * Индекс отвергает дубль, но отвечает на него `P2002`; замок не даёт гонке до него
 * дойти, чтобы ответом оператору был внятный 400 от `assertSlugFree`, а не отказ базы,
 * пойманный в последний момент. Поэтому перечень ниже нужен и после появления индекса.
 *
 * 🔴 Именно «необязательным» и делает этот перечень нужным. Писатель, позвавший вход без
 * слага, получает верные типы, зелёный линт и зелёные спеки — и открытое окно, в котором
 * два термина садятся на один публичный адрес. Ровно такую форму («верный тип при неверном
 * использовании») уже разбирал `LEGACY-310`, и держать её может либо посадка на каждом пути,
 * либо вот такой замороженный перечень.
 *
 * ⚠️ Морозится **перечень мест**, а не поведение: спека на конкретный метод молчит про метод,
 * который допишут завтра. Любой новый вызов входов — где угодно в `src` — роняет эту спеку
 * и требует решения: писатель слага передаёт слаг, не писатель прописывается сюда с причиной.
 *
 * ⚠️ Обход дерева берётся из `controller-decorators.ts`, а не пишется заново (`LEGACY-290`).
 */

/** Вызов входа: имя метода и то, передан ли второй аргумент (слаг). */
const ENTRY_RE = /\.(runInTree|runInLockedTree)\(/g;

type Site = { file: string; entry: string; withSlug: number; withoutSlug: number };

/**
 * Замороженный перечень. `withSlug` — вызовы, передающие слаг (писатели слага);
 * `withoutSlug` — вызовы без него, и каждый обязан быть объяснён в `why`.
 */
const EXPECTED: Array<Site & { why: string }> = [
  {
    file: 'modules/category/category.service.ts',
    entry: 'runInTree',
    withSlug: 2,
    withoutSlug: 0,
    why: 'создание корневого термина и PATCH, не трогающий дерево: оба пишут слаг, оба передают его; у PATCH без слага в теле аргумент приходит `undefined` и замок не берётся — это та же ветка, а не отдельный вызов',
  },
  {
    file: 'modules/category/category.service.ts',
    entry: 'runInLockedTree',
    withSlug: 2,
    withoutSlug: 2,
    why: 'со слагом — создание термина под родителем и PATCH, трогающий дерево; без слага — удаление термина и удаление перевода: они слаг не пишут, а занимают его разве что освобождением',
  },
  {
    file: 'modules/import/import.service.ts',
    entry: 'runInLockedTree',
    withSlug: 1,
    withoutSlug: 0,
    why: 'upsertCategory: ветка создания пишет базовый слаг, и замок берётся на весь термин — развилку «создать или обновить» нельзя решать до замка',
  },
];

/**
 * Второй аргумент вызова. Разбор посимвольный, а не регуляркой: аргументом входа идёт
 * стрелочная функция с телом в несколько десятков строк, внутри которой есть и запятые,
 * и вложенные скобки, и литералы объектов.
 */
const hasSecondArgument = (source: string, openParenIndex: number): boolean => {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return false;
    } else if (char === ',' && depth === 1) return true;
  }
  return false;
};

const collect = (): Site[] => {
  const sites = new Map<string, Site>();

  for (const file of listFiles(
    SRC_ROOT,
    (path) => path.endsWith('.ts') && !path.includes('.spec.'),
  )) {
    const source = readFileSync(file, 'utf8');
    // Объявления самих входов в перечень не идут: это не вызовы.
    if (relativeToSrc(file).endsWith('category/category-tree.service.ts')) continue;

    for (const match of source.matchAll(ENTRY_RE)) {
      const key = `${relativeToSrc(file)}::${match[1]}`;
      const site = sites.get(key) ?? {
        file: relativeToSrc(file),
        entry: match[1],
        withSlug: 0,
        withoutSlug: 0,
      };
      const openParen = match.index + match[0].length - 1;
      if (hasSecondArgument(source, openParen)) site.withSlug += 1;
      else site.withoutSlug += 1;
      sites.set(key, site);
    }
  }

  return [...sites.values()].sort((a, b) =>
    `${a.file}${a.entry}`.localeCompare(`${b.file}${b.entry}`),
  );
};

describe('LEGACY-276: перечень писателей Category.slug заморожен', () => {
  it('вызовы входов транзакции дерева совпадают с перечнем', () => {
    const expected = EXPECTED.map(({ file, entry, withSlug, withoutSlug }) => ({
      file,
      entry,
      withSlug,
      withoutSlug,
    })).sort((a, b) => `${a.file}${a.entry}`.localeCompare(`${b.file}${b.entry}`));

    expect(collect()).toEqual(expected);
  });

  /**
   * Обратная сторона: перечень обязан ловить именно **пропуск слага**, а не просто
   * считать вызовы. Спека, сверяющая одну сумму, зеленела бы на писателе, который
   * слаг потерял, — сумма-то прежняя.
   */
  it('писатель, потерявший слаг, ломает перечень', () => {
    const sites = collect();
    const withSlug = sites.reduce((sum, site) => sum + site.withSlug, 0);
    const withoutSlug = sites.reduce((sum, site) => sum + site.withoutSlug, 0);

    expect(withSlug).toBe(5);
    expect(withoutSlug).toBe(2);
  });
});
