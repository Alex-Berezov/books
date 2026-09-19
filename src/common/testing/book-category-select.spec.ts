import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SRC_ROOT, listFiles, relativeToSrc, stripComments } from './controller-decorators';

/**
 * Сторож перечня обращений к `BookCategory` (`LEGACY-005`).
 *
 * Заведён релизом 1: колонка `BookCategory.isPrimary` мертва — в `true` её не пишет ни один
 * путь, по значению её не читает никто, главную категорию версии держит
 * `BookVersion.primaryCategoryId`. По `ADR-018` (класс 1) снятие колонки возможно ровно при
 * одном условии: работающий образ не должен её называть, иначе `DROP COLUMN` даёт `42703`
 * на живых маршрутах, а откат образа перестаёт быть откатом.
 *
 * 🔴 **«Не читает» оказалось не тем критерием, и это стоило целого релиза.** Релиз 1 снял
 * все чтения, но оставил поле в `prisma/schema.prisma` — а клиент Prisma строит список
 * колонок `INSERT` из схемы, по которой собран, а не из `select` вызова. Прогон клиента
 * `v1.0.97` против базы без колонки: `findMany` со `select`, `findFirst`, `count`
 * и `deleteMany` — зелёные, а `create`, `createMany` и `upsert` — `P2022`. Отсюда
 * три релиза вместо двух: `v1.0.98` убрал поле из клиента (`@ignore`), и только третий
 * снял саму колонку. Критерий здесь двойной, и вторую его половину держит `describe` «поле
 * не уезжает в INSERT» ниже: колонки не должно быть ни в выборке, ни в клиенте.
 *
 * Колонки больше нет, и проверка схемы это состояние принимает наравне с `@ignore`:
 * сторож живёт дальше — он о перечне обращений к модели, а не об одном поле.
 *
 * ⚠️ «Выбирает» шире, чем «читает», и в этом вся суть сторожа. Колонка попадает в `SELECT`
 * тремя способами, из которых явное чтение — только первый:
 *   1. вызов делегата без `select` — `findMany`, `findFirst`, `findUnique`;
 *   2. запись без `select` — `create`, `update`, `delete`, `upsert` возвращают строку
 *      через `RETURNING`, то есть перечисляют все скаляры;
 *   3. обход связи через `include` (или `categories: true`) — `include` на связи тянет
 *      все скаляры самой связи, даже когда потребителю нужен только вложенный `category`.
 *
 * ⚠️ Посадка на конкретный вызов такой гарантии не даёт: она молчит про вызов, который допишут
 * завтра. Первый заход по этой записи ровно на этом и споткнулся — три точечные посадки были
 * зелёными, пока четыре других обращения к той же модели продолжали выбирать колонку. Поэтому
 * здесь заморожен **перечень обращений**, а не поведение трёх из них.
 *
 * ⚠️ `select` ищется **среди ключей верхнего уровня** аргумента, а не подстрокой. Вызов
 * `findMany({ where, include: { category: { select: { translations: true } } } })` содержит
 * слово `select`, но скаляры связи выбирает целиком — от той формы, что лежала здесь
 * до `LEGACY-005`, его отделяет одно слово.
 *
 * ⚠️ Обход идёт и по `prisma/`, а не только по `src`: `prisma/seed.ts` — такое же обращение
 * к модели, и у него три потребителя, включая конвейер **соседнего** репозитория
 * (`LEGACY-294`). Пропущенный там `upsert` красит чужой CI, а не свой.
 *
 * ⚠️ Обход дерева и снятие комментариев берутся из `controller-decorators.ts`, а не пишутся
 * заново: рукописных копий `readdirSync` в репозитории и так больше, чем нужно (`LEGACY-290`).
 *
 * Спека переживёт снятие колонки и останется осмысленной: белый список на выдаче —
 * требование `books/CLAUDE.md` само по себе, вне зависимости от судьбы `isPrimary`.
 */

const PRISMA_ROOT = resolve(SRC_ROOT, '../prisma');

/** Вызовы, возвращающие строку (а значит, выбирающие её колонки) — в отличие от `count`. */
const ROW_OPS = [
  'create',
  'createMany',
  'upsert',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'findFirst',
  'findUnique',
  'findMany',
] as const;

/** `createMany`/`updateMany`/`deleteMany` отдают только счётчик — колонок не выбирают. */
const COUNT_ONLY = new Set<string>(['createMany', 'updateMany', 'deleteMany']);

const CALL_RE = new RegExp(`\\bbookCategory\\.(${ROW_OPS.join('|')})\\s*\\(`, 'g');

/**
 * Имена связи, ведущей к `BookCategory`, с обеих сторон:
 * `BookVersion.categories` (`schema.prisma:77`) и `Category.books` (`:388`).
 */
const RELATION_FIELDS = new Set<string>(['categories', 'books']);

/** Начало блока выборки: только внутрь такого блока и смотрим на связь. */
const SELECTION_RE = /\b(?:select|include)\s*:\s*(?=\{)/g;

/**
 * Ключи фильтра: `where: { categories: { some: … } }` связь не выбирает, а сужает выборку.
 * Такой объект в перечень не идёт.
 */
const FILTER_KEYS = new Set<string>(['some', 'every', 'none', 'is', 'isNot']);

/**
 * Текст блока от открывающей скобки до парной ей закрывающей.
 * Скобки считаются, а не ищутся регэкспом, иначе вложенный объект обрывает разбор
 * на первой же `}` и вызов с `select` в глубине выглядел бы голым.
 */
const balanced = (text: string, open: number, pair: '()' | '{}' | '[]'): string => {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === pair[0]) depth += 1;
    else if (text[i] === pair[1]) {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
};

/** Пары «ключ верхнего уровня → текст значения»: вложенные в подобъекты сюда не попадают. */
const topLevelEntries = (objectBody: string): Map<string, string> => {
  const entries = new Map<string, string>();
  let depth = 0;
  for (let i = 0; i < objectBody.length; i += 1) {
    const ch = objectBody[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (depth === 0) {
      const key = /^([A-Za-z_$][\w$]*)\s*:\s*/.exec(objectBody.slice(i));
      if (key && (i === 0 || !/[\w$.]/.test(objectBody[i - 1]))) {
        entries.set(key[1], objectBody.slice(i + key[0].length));
      }
    }
  }
  return entries;
};

const topLevelKeys = (objectBody: string): Set<string> =>
  new Set(topLevelEntries(objectBody).keys());

/** Первый объектный литерал аргумента: `findMany({ … })` → тело фигурных скобок. */
const firstObjectOf = (args: string): string | null => {
  const brace = args.indexOf('{');
  return brace === -1 ? null : balanced(args, brace, '{}');
};

/** Ключи верхнего уровня у аргумента вызова — общая функция для обхода и для проб на отказ. */
const callArgumentKeys = (code: string, from = 0): Set<string> => {
  const re = new RegExp(CALL_RE.source, 'g');
  re.lastIndex = from;
  const match = re.exec(code);
  if (!match) return new Set();
  const args = balanced(code, match.index + match[0].length - 1, '()');
  return topLevelKeys(firstObjectOf(args) ?? '');
};

/**
 * Обращения к связи — общая функция для обхода и для проб на отказ.
 *
 * ⚠️ Смотрим **только внутрь `select:`/`include:`**, а не на `categories:` где попало.
 * Иначе в перечень попадает обычный объект настроек: `seo.controller.ts:121` передаёт
 * `{ categories: true, tags: true }` в пересчёт индексируемости, и к Prisma это отношения
 * не имеет. Ровно тот случай, ради которого `L-008` запрещает разбирать код регэкспом
 * без контекста.
 *
 * Вложенность закрывается сама: вложенные `select:`/`include:` — это свои совпадения
 * того же обхода.
 */
const relationFindings = (text: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(SELECTION_RE.source, 'g'))) {
    const body = balanced(text, match.index + match[0].length, '{}');
    for (const [field, value] of topLevelEntries(body)) {
      if (!RELATION_FIELDS.has(field)) continue;
      if (/^true\b/.test(value)) {
        out.push(`${field}: true`);
        continue;
      }
      if (!value.startsWith('{')) continue;
      const keys = topLevelKeys(balanced(value, 0, '{}'));
      if ([...keys].some((k) => FILTER_KEYS.has(k))) continue;
      if (keys.has('include')) out.push(`${field}: { include }`);
    }
  }
  return out;
};

/** Тело модели схемы — от её `{` до парной `}`; `null`, если модели нет вовсе. */
const modelBodyOf = (schema: string, model: string): string | null => {
  const at = schema.search(new RegExp(`\\bmodel\\s+${model}\\s*\\{`));
  return at === -1 ? null : balanced(schema, schema.indexOf('{', at), '{}');
};

/**
 * Видно ли поле клиенту Prisma. Клиент строит список колонок `INSERT` по схеме, поэтому
 * «не видно» означает ровно две формы: поля в модели нет либо оно под `@ignore`.
 * Пропавшая модель — не «поля нет», а отказ: искать было негде.
 */
const hiddenFromClient = (schema: string, model: string, field: string): boolean => {
  const body = modelBodyOf(schema, model);
  if (body === null) return false;
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => new RegExp(`^${field}\\b`).test(l));
  return line === undefined || line.includes('@ignore');
};

/**
 * Ключи полезной нагрузки записи: за ними идёт то, что уедет в `INSERT`/`UPDATE`.
 * `createMany`/`updateMany` нужны и здесь, и у вложенной записи через связь.
 */
const WRITE_KEYS = new Set<string>([
  'data',
  'create',
  'update',
  'createMany',
  'updateMany',
  'connectOrCreate',
  'upsert',
]);

/** Поле в полезной нагрузке, а не где угодно: `isPrimary:` как ключ объекта. */
const FIELD_AS_KEY = /\bisPrimary\s*:/;

/**
 * Текст одной пары «ключ — значение» до запятой своего уровня.
 *
 * ⚠️ `topLevelEntries` отдаёт весь остаток тела, поэтому без этой границы разбор цеплял
 * скобку **следующего** ключа: `{ data: rows, select: { isPrimary: true } }` назывался
 * записью, хотя это чтение. Брать же только первый символ значения тоже нельзя — живая
 * нагрузка бывает выражением: `data: rows.map((c) => ({ … }))` (`book-version.service.ts:360`).
 */
const entryExtent = (value: string): string => {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return value.slice(0, i);
      depth -= 1;
    } else if (ch === ',' && depth === 0) return value.slice(0, i);
  }
  return value;
};

/**
 * Запись поля в прямом вызове делегата.
 *
 * ⚠️ Значение берётся **целиком**, со счётом скобок, а не до первой `}`. Обрыв на первой
 * закрывающей скобке пропускал и вложенный объект до поля
 * (`data: { bookVersion: { connect: { id } }, isPrimary: true }`), и второй элемент массива
 * у `createMany` — то есть ровно те формы, ради которых сторож и заведён (`L-033`).
 *
 * 🔴 Нагрузка не литералом (`create({ data })`, `create({ data: rows })`) — **находка**,
 * а не пропуск. Сторож обязан отвечать «не знаю» громко: молча он утверждал бы, что поля
 * в записи нет, не увидев самой записи, — и на этом утверждении уедет `DROP COLUMN`.
 * Прежняя форма вдобавок брала скобку у **следующего** ключа, то есть
 * `{ data: rows, select: { isPrimary: true } }` называла записью чтение.
 */
const writeFindings = (callBody: string, op: string): string[] => {
  const out: string[] = [];

  // Сокращённая запись `{ data }`: пары «ключ → значение» здесь нет вовсе.
  for (const key of WRITE_KEYS) {
    const shorthand = new RegExp(`(^|[,{\\s])${key}\\s*(,|$)`);
    if (shorthand.test(callBody)) out.push(`${op}: ${key} — нагрузка не литерал`);
  }

  for (const [key, value] of topLevelEntries(callBody)) {
    if (!WRITE_KEYS.has(key)) continue;
    const extent = entryExtent(value);
    if (!/[{[]/.test(extent)) {
      out.push(`${op}: ${key} — нагрузка не литерал`);
      continue;
    }
    if (FIELD_AS_KEY.test(extent)) out.push(`${op}: ${key}.isPrimary`);
  }

  return out;
};

/**
 * Запись поля **через связь**, у любого делегата:
 * `bookVersion.update({ data: { categories: { create: { …, isPrimary: true } } } })`.
 * Прямой вызов `bookCategory.*` тут не обязателен, поэтому и обход отдельный: иначе такую
 * строку держит и компилятор — после снятия поля из схемы её нет в типах клиента вовсе.
 * Сторож нужен не вместо него, а там, где типов не хватает: нагрузка переменной
 * (`create: row`, `createMany: { data: rows }`) для `tsc` прозрачна, и такую запись
 * не видит никто, кроме этого обхода.
 *
 * ⚠️ Поле ищется **в нагрузке записи**, а не во всём теле связи: `categories: { where: {
 * isPrimary: true }, update: … }` — это фильтр, и записью он не является.
 */
const relationWriteFindings = (text: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(/\b(categories|books)\s*:\s*(?=\{)/g)) {
    const body = balanced(text, match.index + match[0].length, '{}');
    for (const [key, value] of topLevelEntries(body)) {
      if (!WRITE_KEYS.has(key)) continue;
      const extent = entryExtent(value);
      if (!/[{[]/.test(extent)) {
        out.push(`${match[1]}.${key} — нагрузка не литерал`);
        continue;
      }
      if (FIELD_AS_KEY.test(extent)) {
        out.push(`${match[1]}.${key}: запись isPrimary через связь`);
      }
    }
  }
  return out;
};

type Finding = { file: string; what: string };

/**
 * Один обход на оба перечня: и выборки, и аргумент `data` у записи. Второй проход по тому же
 * дереву стоил бы столько же, сколько первый, а дерево тут — весь `src` плюс `prisma`.
 */
const collectBare = (): {
  findings: Finding[];
  writes: Finding[];
  files: number;
  calls: number;
} => {
  const keep = (path: string) => path.endsWith('.ts') && !path.endsWith('.spec.ts');
  const files = [...listFiles(SRC_ROOT, keep), ...listFiles(PRISMA_ROOT, keep)];
  const findings: Finding[] = [];
  const writes: Finding[] = [];
  let calls = 0;

  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const where = relativeToSrc(file);

    for (const match of text.matchAll(CALL_RE)) {
      const args = balanced(text, match.index + match[0].length - 1, '()');
      for (const what of writeFindings(firstObjectOf(args) ?? '', match[1])) {
        writes.push({ file: where, what });
      }

      if (COUNT_ONLY.has(match[1])) continue;
      calls += 1;
      if (!callArgumentKeys(text, match.index).has('select')) {
        findings.push({ file: where, what: `${match[1]} без select` });
      }
    }

    for (const what of relationFindings(text)) findings.push({ file: where, what });
    for (const what of relationWriteFindings(text)) writes.push({ file: where, what });
  }

  return { findings, writes, files: files.length, calls };
};

describe('BookCategory читается только белым списком (LEGACY-005)', () => {
  const scan = collectBare();

  it('ни одно обращение к `BookCategory` не выбирает её скаляры', () => {
    expect(scan.findings).toEqual([]);
  });

  /**
   * 🔴 Пустой обход даёт тот же `[]`, что и чистое дерево (`L-015`). Без пола спека остаётся
   * зелёной, когда `SRC_ROOT` уехал при переносе файла или фильтр перестал попадать в `.ts`, —
   * и следующий релиз пишет `DROP COLUMN` по сторожу, не проверившему ни одного файла.
   */
  it('обход действительно дошёл до файлов и до самих вызовов', () => {
    expect(scan.files).toBeGreaterThan(400);
    expect(scan.calls).toBeGreaterThan(5);
  });

  /**
   * Пробы на отказ идут через **тот же** разбор, которым работает обход, а не через
   * отдельные регэкспы: иначе зелёной остаётся и спека со сломанным разбором.
   */
  describe('пробы на отказ разбора', () => {
    it('голый вызов отличается от вызова с белым списком', () => {
      expect([
        ...callArgumentKeys(`prisma.bookCategory.findFirst({ where: { id } })`),
      ]).not.toContain('select');
      expect([
        ...callArgumentKeys(
          `prisma.bookCategory.findFirst({ where: { id }, select: { id: true } })`,
        ),
      ]).toContain('select');
    });

    /** 🔴 Ровно та форма, что лежала в `seo.service.ts` до `LEGACY-005`: `select` есть, но вложенный. */
    it('вложенный `select` внутри `include` белым списком не считается', () => {
      const keys = [
        ...callArgumentKeys(`prisma.bookCategory.findMany({
          where: { bookVersionId },
          include: { category: { select: { translations: true } } },
        })`),
      ];
      expect(keys).not.toContain('select');
      expect(keys).toContain('include');
    });

    it('вложенный объект не обрывает разбор аргумента раньше времени', () => {
      expect([
        ...callArgumentKeys(
          `prisma.bookCategory.findMany({ where: { a: { b: 1 } }, select: { id: true } })`,
        ),
      ]).toContain('select');
    });

    it('ключ подобъекта за ключ верхнего уровня не выдаётся', () => {
      expect([...topLevelKeys(`where: { select: 1 }, include: { x: true }`)].sort()).toEqual([
        'include',
        'where',
      ]);
    });
  });

  describe('пробы на отказ по связи', () => {
    it('`include` на связи считается обращением, `select` — нет', () => {
      expect(relationFindings(`select: { categories: { include: { category: true } } }`)).toEqual([
        'categories: { include }',
      ]);
      expect(relationFindings(`select: { categories: { select: { category: true } } }`)).toEqual(
        [],
      );
    });

    it('`include` не первым ключом тоже виден', () => {
      expect(
        relationFindings(
          `select: { categories: { orderBy: { sortOrder: 'asc' }, include: { category: true } } }`,
        ),
      ).toEqual(['categories: { include }']);
    });

    it('`categories: true` и обратная сторона связи `books` видны', () => {
      expect(relationFindings(`include: { categories: true }`)).toEqual(['categories: true']);
      expect(relationFindings(`include: { books: true }`)).toEqual(['books: true']);
    });

    it('фильтр по связи выборкой не считается', () => {
      expect(relationFindings(`where: { categories: { some: { categoryId } } }`)).toEqual([]);
    });

    /**
     * 🔴 `seo.controller.ts:121` передаёт `{ categories: true, tags: true }` в пересчёт
     * индексируемости — это настройки, а не выборка Prisma. Без контекста `select`/`include`
     * сторож краснел на живом коде и требовал бы «починить» то, что не сломано (`L-008`).
     */
    it('обычный объект настроек за выборку не принимается', () => {
      expect(relationFindings(`const cold = { categories: true, tags: true };`)).toEqual([]);
    });
  });

  it('счётные вызовы колонок не выбирают и в перечень не идут', () => {
    expect([...COUNT_ONLY]).toEqual(['createMany', 'updateMany', 'deleteMany']);
  });

  /**
   * Вторая половина критерия: колонки не должно быть и в КЛИЕНТЕ, а не только в выборках.
   *
   * `select` на вызове списка колонок `INSERT` не сужает — его строит генератор по схеме.
   * Значит единственное, что отделяет `DROP COLUMN` от `P2022` на живых путях записи, —
   * отсутствие поля в `prisma/schema.prisma` предыдущего образа либо метка `@ignore` на нём.
   * Проверяется поэтому сама схема, а не вызовы: вызов тут ни при чём.
   */
  describe('поле не уезжает в INSERT (`ADR-018`, расширение перед сжатием)', () => {
    const schema = readFileSync(resolve(PRISMA_ROOT, 'schema.prisma'), 'utf8');

    it('модель `BookCategory` в схеме найдена', () => {
      expect(modelBodyOf(schema, 'BookCategory')).not.toBeNull();
    });

    it('`isPrimary` отсутствует или помечена `@ignore`', () => {
      expect(hiddenFromClient(schema, 'BookCategory', 'isPrimary')).toBe(true);
    });

    /**
     * 🔴 Пробы на отказ идут через **тот же** разбор, которым проверяется живая схема,
     * а не через `includes` на литерале рядом (`L-033`): иначе зелёным останется и случай,
     * в котором сломан сам разбор — например, перестал находить строку поля в теле модели.
     */
    describe('пробы на отказ разбора схемы', () => {
      const withField = (field: string) =>
        `model Other {\n  id String @id\n}\n\nmodel BookCategory {\n  id String @id\n  ${field}\n  sortOrder Int @default(0)\n}\n`;

      it('поле без `@ignore` проверку не проходит', () => {
        expect(
          hiddenFromClient(
            withField('isPrimary Boolean @default(false)'),
            'BookCategory',
            'isPrimary',
          ),
        ).toBe(false);
      });

      it('поле под `@ignore` проверку проходит', () => {
        expect(
          hiddenFromClient(
            withField('isPrimary Boolean @default(false) @ignore'),
            'BookCategory',
            'isPrimary',
          ),
        ).toBe(true);
      });

      it('снятое поле проверку проходит', () => {
        expect(hiddenFromClient(withField('categoryId String'), 'BookCategory', 'isPrimary')).toBe(
          true,
        );
      });

      /** Поле той же схемы, но в ЧУЖОЙ модели, за своё не выдаётся. */
      it('одноимённое поле соседней модели в счёт не идёт', () => {
        const other =
          'model BookVersionContributor {\n  isPrimary Boolean @default(false)\n}\n\nmodel BookCategory {\n  id String @id\n}\n';
        expect(hiddenFromClient(other, 'BookCategory', 'isPrimary')).toBe(true);
        expect(hiddenFromClient(other, 'BookVersionContributor', 'isPrimary')).toBe(false);
      });

      it('пропавшая модель — это отказ, а не молчаливое «поля нет»', () => {
        expect(modelBodyOf('model Foo {\n  id String @id\n}\n', 'BookCategory')).toBeNull();
      });
    });
  });

  /**
   * Аргумент записи: `create`/`upsert` перечисляют колонки по схеме, но явный `isPrimary`
   * в полезной нагрузке вернул бы колонку в `INSERT` даже при `@ignore`. Пока поле под
   * `@ignore`, такую строку не пропускал и компилятор. Колонка снята, и типы теперь режут
   * её сами; сторож остаётся ради того, чего типы не видят, — нагрузки переменной.
   */
  describe('запись поля (`ADR-018`, вторая половина критерия)', () => {
    it('ни одна запись не передаёт `isPrimary` в полезной нагрузке', () => {
      expect(scan.writes).toEqual([]);
    });

    /**
     * 🔴 Пробы идут через `writeFindings`/`relationWriteFindings` — те же функции, которыми
     * работает обход (`L-033`). Пустой `[]` на чистом дереве неотличим от `[]` у сломанного
     * разбора, и отличают их только эти случаи.
     */
    describe('пробы на отказ разбора записи', () => {
      /** Тот же путь, которым идёт обход: аргумент вызова → его тело → `writeFindings`. */
      const payload = (args: string, op: string) => writeFindings(firstObjectOf(args) ?? '', op);

      it('плоский `data` с полем — находка', () => {
        expect(
          payload(`{ data: { bookVersionId, categoryId, isPrimary: true } }`, 'create'),
        ).toEqual(['create: data.isPrimary']);
      });

      /** 🔴 Форма, которую прежний разбор пропускал: вложенный объект до поля. */
      it('вложенный объект перед полем разбор не обрывает', () => {
        expect(
          payload(
            `{ data: { bookVersion: { connect: { id } }, categoryId, isPrimary: true } }`,
            'create',
          ),
        ).toEqual(['create: data.isPrimary']);
      });

      /** 🔴 И вторая форма: поле во втором элементе массива у `createMany`. */
      it('второй элемент массива у `createMany` виден', () => {
        expect(
          payload(
            `{ data: [{ bookVersionId, categoryId }, { bookVersionId, categoryId, isPrimary: true }] }`,
            'createMany',
          ),
        ).toEqual(['createMany: data.isPrimary']);
      });

      it('чистая запись находкой не считается', () => {
        expect(
          payload(`{ data: { bookVersionId, categoryId }, select: { id: true } }`, 'create'),
        ).toEqual([]);
      });

      it('`select` с тем же полем за запись не принимается', () => {
        expect(payload(`{ where: { id }, select: { isPrimary: true } }`, 'findFirst')).toEqual([]);
      });

      /**
       * 🔴 Нагрузка не литералом — находка, а не тишина: иначе сторож утверждает, что поля
       * в записи нет, не увидев записи. Обе формы живые: `create({ data })` встречается
       * в репозитории у других моделей.
       */
      it('сокращённая запись `{ data }` — находка «не литерал»', () => {
        expect(payload(`{ data }`, 'create')).toEqual(['create: data — нагрузка не литерал']);
      });

      it('нагрузка переменной — находка «не литерал»', () => {
        expect(payload(`{ data: rows }`, 'createMany')).toEqual([
          'createMany: data — нагрузка не литерал',
        ]);
      });

      /** 🔴 И при этом скобка соседнего ключа за нагрузку не принимается. */
      it('`select` соседнего ключа записью не считается', () => {
        expect(payload(`{ data: rows, select: { isPrimary: true } }`, 'create')).toEqual([
          'create: data — нагрузка не литерал',
        ]);
      });

      it('запись через связь видна у любого делегата', () => {
        expect(
          relationWriteFindings(
            `prisma.bookVersion.update({ data: { categories: { create: { categoryId, isPrimary: true } } } })`,
          ),
        ).toEqual(['categories.create: запись isPrimary через связь']);
      });

      /** 🔴 Вложенный `createMany` — такая же запись, и прежний разбор её не видел. */
      it('вложенный `createMany` через связь виден', () => {
        expect(
          relationWriteFindings(
            `prisma.bookVersion.update({ data: { categories: { createMany: { data: [{ categoryId, isPrimary: true }] } } } })`,
          ),
        ).toEqual(['categories.createMany: запись isPrimary через связь']);
      });

      it('чтение связи за запись не принимается', () => {
        expect(
          relationWriteFindings(`select: { categories: { select: { isPrimary: true } } }`),
        ).toEqual([]);
      });

      /** 🔴 Фильтр по полю — не запись: иначе сторож краснеет на том, что не сломано (`L-008`). */
      it('фильтр `where` с тем же полем записью не считается', () => {
        expect(
          relationWriteFindings(
            `data: { categories: { where: { isPrimary: true }, update: { sortOrder: 1 } } }`,
          ),
        ).toEqual([]);
      });
    });
  });
});
