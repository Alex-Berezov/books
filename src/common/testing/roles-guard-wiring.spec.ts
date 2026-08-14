import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

/**
 * Сторож связки «`@Roles(...)` — `RolesGuard`» (`LEGACY-110`).
 *
 * Глобального `RolesGuard` в приложении нет: в `APP_GUARD` лежат только
 * `GlobalRateLimitGuard` и `LanguageResolverGuard`. Значит `@Roles(...)` без
 * `RolesGuard` в том же `@UseGuards(...)` не проверяет ничего — метаданные
 * `ROLES_KEY` некому прочитать, и маршрут открыт любому аутентифицированному.
 * Ни типы, ни линт, ни Swagger такой маршрут от закрытого не отличают:
 * декоратор корректен сам по себе, а замок в документации рисует
 * `@ApiBearerAuth()`.
 *
 * ⚠️ Проверка идёт **по обработчикам, а не по файлам**: `RolesGuard`,
 * упомянутый где-то в файле, ничего не говорит о соседнем методе, у которого
 * свой `@UseGuards(...)`. Файловой проверки хватило бы ровно до первого
 * контроллера, где гвард стоит на одном маршруте из трёх.
 *
 * ⚠️ Порог обхода задан не «на глазок», а сверкой с сырым числом вхождений
 * `@Roles(` в тех же файлах. Разбор декораторов может сломаться так, что часть
 * обработчиков просто перестанет считаться, — и мягкая нижняя граница этого
 * не заметит.
 */

const SRC_ROOT = resolve(__dirname, '../..');

/** Ниже этого числа обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_CONTROLLERS = 40;
const MIN_ROLES_HANDLERS = 150;

const listControllers = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listControllers(full);
    return entry.isFile() && entry.name.endsWith('.controller.ts') ? [full] : [];
  });

/**
 * Строка без содержимого литералов и построчных комментариев. Скобки внутри
 * `@ApiOperation({ summary: 'Rate this :(' })` иначе перекашивают баланс, и
 * остаток файла склеивается в один блок — а склеенный блок выглядит закрытым,
 * потому что где-то ниже по файлу `RolesGuard` есть.
 */
const stripLiterals = (line: string): string =>
  line
    .replace(/\\./g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\/.*$/, '');

/**
 * Файл без комментариев. Нужен для сырого счёта `@Roles(`: упоминание
 * декоратора в пояснении — не обработчик, и разбор декораторов его законно
 * не видит.
 */
const stripComments = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const balance = (line: string): number => {
  const clean = stripLiterals(line);
  return (clean.match(/\(/g) ?? []).length - (clean.match(/\)/g) ?? []).length;
};

type DecoratorBlock = { text: string; ownerLine: string };

/**
 * Режет файл на блоки декораторов: подряд идущие декораторы одного члена
 * класса плюс строка, к которой они относятся (сигнатура метода или
 * `export class`). Многострочный декоратор собирается по балансу скобок.
 */
const decoratorBlocks = (content: string): DecoratorBlock[] => {
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
const useGuardsArgs = (text: string): string => {
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

const hasRolesGuard = (text: string): boolean => useGuardsArgs(text).includes('RolesGuard');

describe('@Roles is always backed by RolesGuard', () => {
  const controllers = listControllers(SRC_ROOT);

  const unguarded: string[] = [];
  let handlersWithRoles = 0;
  let rawRolesOccurrences = 0;

  for (const file of controllers) {
    const content = readFileSync(file, 'utf8');
    rawRolesOccurrences += (stripComments(content).match(/@Roles\s*\(/g) ?? []).length;

    const blocks = decoratorBlocks(content);
    const classGuarded = blocks.some(
      (block) => block.ownerLine.includes('class ') && hasRolesGuard(block.text),
    );

    for (const block of blocks) {
      if (!/@Roles\s*\(/.test(block.text)) continue;
      handlersWithRoles += 1;
      if (classGuarded || hasRolesGuard(block.text)) continue;
      unguarded.push(`${relative(SRC_ROOT, file).replace(/\\/g, '/')} → ${block.ownerLine}`);
    }
  }

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it(`находит не меньше ${MIN_ROLES_HANDLERS} обработчиков с @Roles`, () => {
    expect(handlersWithRoles).toBeGreaterThanOrEqual(MIN_ROLES_HANDLERS);
  });

  it('видит все @Roles до единого — разбор декораторов ничего не потерял', () => {
    expect(handlersWithRoles).toBe(rawRolesOccurrences);
  });

  it('не оставляет ни одного @Roles без RolesGuard', () => {
    expect(unguarded).toEqual([]);
  });
});
