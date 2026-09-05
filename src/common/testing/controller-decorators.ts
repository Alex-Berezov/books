import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { stripComments } from './module-registration';

/**
 * Разбор декораторов контроллеров по тексту файла. Вынесен из
 * `roles-guard-wiring.spec.ts` (`LEGACY-110`), когда тем же разбором
 * понадобилось собрать список закрытых маршрутов (`LEGACY-234`).
 *
 * Почему по тексту, а не по метаданным поднятого приложения: сторожу нужно
 * видеть **все** контроллеры репозитория, включая те, что не попали ни в один
 * модуль. Поднятый `AppModule` показывает только подключённое.
 *
 * ⚠️ `stripComments` здесь не переписывается, а берётся из
 * `module-registration.ts`: копия того же разбора уже лежала бы в четырёх
 * местах, и правка краевого случая (`//` внутри `'https://...'`) уехала бы
 * в одну из них. Оставшиеся копии — `LEGACY-290`.
 */

export { stripComments };

export const SRC_ROOT = resolve(__dirname, '../..');

/**
 * Все файлы под `dir`, которые проходят `keep`. Обход один на всех сторожей:
 * восьмая рукописная копия `readdirSync(dir, { withFileTypes: true })` — это
 * восемь мест, где каталог исключают по одному, а расходятся они молча
 * (`LEGACY-290`).
 */
export const listFiles = (dir: string, keep: (posixPath: string) => boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, keep);
    return entry.isFile() && keep(full.replace(/\\/g, '/')) ? [full] : [];
  });

export const listControllerFiles = (dir: string = SRC_ROOT): string[] =>
  listFiles(dir, (path) => path.endsWith('.controller.ts'));

/** Файлы DTO по всему `src`, а не только под `src/modules` (`LEGACY-133`). */
export const listDtoFiles = (dir: string = SRC_ROOT): string[] =>
  listFiles(dir, (path) => path.includes('/dto/') && path.endsWith('.dto.ts'));

export const readController = (file: string): string => readFileSync(file, 'utf8');

export const relativeToSrc = (file: string): string => relative(SRC_ROOT, file).replace(/\\/g, '/');

/**
 * Строка без содержимого литералов и построчных комментариев. Скобки внутри
 * `@ApiOperation({ summary: 'Rate this :(' })` иначе перекашивают баланс, и
 * остаток файла склеивается в один блок — а склеенный блок выглядит закрытым,
 * потому что где-то ниже по файлу `RolesGuard` есть.
 *
 * Не экспортируется намеренно: снаружи она годится только вместе с
 * `stripComments`, а порознь даёт склеенный блок на файле с блочным
 * комментарием внутри списка декораторов.
 */
const stripLiterals = (line: string): string =>
  line
    .replace(/\\./g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\/.*$/, '');

const balance = (line: string): number => {
  const clean = stripLiterals(line);
  return (clean.match(/\(/g) ?? []).length - (clean.match(/\)/g) ?? []).length;
};

export type DecoratorBlock = { text: string; ownerLine: string };

/**
 * Режет файл на блоки декораторов: подряд идущие декораторы одного члена
 * класса плюс строка, к которой они относятся (сигнатура метода или
 * `export class`). Многострочный декоратор собирается по балансу скобок.
 */
export const decoratorBlocks = (content: string): DecoratorBlock[] => {
  const lines = content.split(/\r?\n/);
  const blocks: DecoratorBlock[] = [];
  let current: string[] = [];
  let i = 0;

  const flush = (ownerLine: string): void => {
    if (current.length === 0) return;
    blocks.push({ text: current.join('\n'), ownerLine });
    current = [];
  };

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('@')) {
      let depth = 0;
      do {
        depth += balance(lines[i]);
        current.push(lines[i]);
        i += 1;
      } while (i < lines.length && depth > 0);
      continue;
    }

    // Пустые строки и любые комментарии блок декораторов не разрывают.
    const isComment = /^(\/\/|\/\*|\*)/.test(trimmed);
    if (trimmed !== '' && !isComment) flush(trimmed);
    i += 1;
  }

  flush('');
  return blocks;
};

/**
 * Содержимое ближайшего `@UseGuards(...)` блока, разобранное по балансу
 * скобок. Регулярка `\([^)]*RolesGuard` здесь не годится: она обрывается на
 * первой `)`, то есть `@UseGuards(AuthGuard('jwt'), RolesGuard)` объявила бы
 * закрытый маршрут открытым.
 */
export const useGuardsArgs = (text: string): string => {
  const start = text.indexOf('@UseGuards(');
  if (start === -1) return '';
  let depth = 0;
  for (let i = start + '@UseGuards'.length; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
};

/**
 * Есть ли среди гвардов блока названный — по границам слова.
 *
 * ⚠️ Сравнивать подстрокой нельзя: `JwtAuthGuard` входит в
 * `OptionalJwtAuthGuard`, который анонима как раз пропускает, а `RolesGuard` —
 * в любой будущий `SoftRolesGuard`, который ролей не читает. Соседи такого
 * вида в проекте уже есть: `RateLimitGuard` ⊂ `AuthRateLimitGuard`.
 */
export const guardsInclude = (text: string, guard: string): boolean =>
  new RegExp(`\\b${guard}\\b`).test(useGuardsArgs(text));

/**
 * Восемь глаголов Nest, а не пять расхожих. Список совпадает с `HTTP_METHODS`
 * в `route-order.spec.ts` намеренно: обработчик, объявленный `@All(...)` или
 * `@Options(...)`, невидимый одному сторожу и видимый другому, — это два
 * зелёных сторожа с разными ответами на один и тот же вход.
 */
export const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;

export type HttpVerb = (typeof VERBS)[number];

export type ControllerRoute = {
  /** Путь файла относительно `src`. */
  file: string;
  verb: HttpVerb;
  /** Путь маршрута с ведущей косой; параметры оставлены как `:name`. */
  path: string;
  /** Строка, к которой относился блок декораторов, — для внятного отказа. */
  ownerLine: string;
  /**
   * Стоит ли на маршруте `@ApiBearerAuth()` — на самом методе или на его классе
   * (`LEGACY-132`). Складывается так же, как гварды: декоратор класса действует
   * на все его методы.
   */
  bearerAuth: boolean;
};

/**
 * Есть ли в блоке настоящий `@ApiBearerAuth(...)`.
 *
 * ⚠️ Со скобкой в шаблоне, а не подстрокой `@ApiBearerAuth`: строка импорта
 * `import { ApiBearerAuth } from '@nestjs/swagger'` в блок декораторов не
 * попадает, но упоминание в тексте — попадёт.
 *
 * 🔴 Поиск идёт по строке, из которой вырезаны литералы и комментарии, — теми
 * же `stripLiterals`, что считают баланс скобок. По сырому тексту сторож
 * обманывался дважды: `// @ApiBearerAuth()` в комментарии над методом и
 * буквальная подстрока внутри `@ApiOperation({ description: '...' })` того же
 * маршрута сходили за настоящий декоратор. Это тот же класс ошибки, из-за
 * которого текстовый сторож `LEGACY-190` был заменён разбором через компилятор
 * (`L-008`, правило «разбор кода регулярками»); здесь он закрыт вырезанием
 * литералов, потому что блок декораторов уже разобран по балансу скобок.
 */
const hasApiBearerAuth = (text: string): boolean =>
  stripComments(text)
    .split(/\r?\n/)
    .map(stripLiterals)
    .some((line) => /@ApiBearerAuth\s*\(/.test(line));

/** `Get` -> `/@Get\s*\(/`. Экранирование обычное, одним местом на оба вызова. */
const decoratorOpening = (decorator: string): RegExp => new RegExp(`@${decorator}\\s*\\(`);

const capitalize = (verb: string): string => verb[0].toUpperCase() + verb.slice(1);

/** Первый строковый аргумент декоратора: `@Get(':id')` -> `:id`, `@Get()` -> ''. */
const firstStringArg = (text: string, decorator: string): string => {
  const opening = decoratorOpening(decorator).exec(text);
  if (!opening) return '';
  const rest = text.slice(opening.index + opening[0].length);
  const quoted = /^\s*(['"`])([^'"`]*)/.exec(rest);
  return quoted ? quoted[2] : '';
};

const joinPath = (base: string, sub: string): string => {
  const parts = [base, sub].filter((part) => part !== '').join('/');
  return (
    '/' +
    parts
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '')
  );
};

/**
 * Все маршруты всех контроллеров репозитория, разложенные на закрытые
 * названным гвардом и открытые.
 *
 * ⚠️ Гварды в Nest **складываются**: гвард класса действует на метод, даже если
 * у метода есть свой `@UseGuards(...)`. Поэтому закрытым считается обработчик,
 * у которого гвард нашёлся хоть где-то из двух мест.
 *
 * ⚠️ Контроллер без блока декораторов у класса пропускается, и пропуск
 * считается: `skipped` возвращается наружу, чтобы сторож мог отличить
 * «таких нет» от «разбор сломался и молча ничего не нашёл».
 */
export const collectRoutes = (
  guard: string,
): { closed: ControllerRoute[]; open: ControllerRoute[]; skipped: string[] } => {
  const closed: ControllerRoute[] = [];
  const open: ControllerRoute[] = [];
  const skipped: string[] = [];

  for (const fileName of listControllerFiles()) {
    const content = readController(fileName);
    const blocks = decoratorBlocks(content);
    const classBlock = blocks.find((block) => block.ownerLine.includes('class '));
    if (!classBlock) {
      skipped.push(relativeToSrc(fileName));
      continue;
    }

    const base = firstStringArg(classBlock.text, 'Controller');
    const classGuarded = guardsInclude(classBlock.text, guard);
    const classBearerAuth = hasApiBearerAuth(classBlock.text);

    for (const block of blocks) {
      if (block === classBlock) continue;
      for (const verb of VERBS) {
        const decorator = capitalize(verb);
        if (!decoratorOpening(decorator).test(block.text)) continue;
        const route: ControllerRoute = {
          file: relativeToSrc(fileName),
          verb,
          path: joinPath(base, firstStringArg(block.text, decorator)),
          ownerLine: block.ownerLine,
          bearerAuth: classBearerAuth || hasApiBearerAuth(block.text),
        };
        if (classGuarded || guardsInclude(block.text, guard)) closed.push(route);
        else open.push(route);
      }
    }
  }

  return { closed, open, skipped };
};
