import { existsSync, readFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';

/**
 * Очередь регистрации модулей и контроллеров, восстановленная по тексту
 * `app.module.ts` и файлов модулей (`LEGACY-201`).
 *
 * Зачем она нужна. В Nest обработчик выбирается по порядку регистрации.
 * Внутри файла порядок виден глазами, между файлами — нет: его задаёт граф
 * модулей, и в файле маршрута от него нет ни следа. Пока `PublicModule`
 * (единственный `@Controller(':lang')` в репозитории) стоял выше `AuthorModule`,
 * `GET /admin/authors` уезжал в `:lang/authors` и отвечал 404 — при исправном
 * с виду контроллере.
 *
 * Как считается. Обход в глубину от `AppModule` по массивам `imports`,
 * пре-ордером и по первому появлению — так же, как строит контейнер
 * `DependenciesScanner`: модуль, встреченный раньше, повторно не регистрируется.
 * Поэтому модуль с контроллерами, импортированный и из `AppModule`, и из соседа,
 * встаёт туда, где его увидели **первым**; `GeoBlockModule` и
 * `RightsIntakeModule` в этом репозитории именно такие, и плоская нумерация
 * по `app.module.ts` соврала бы про них.
 *
 * ⚠️ Разбор текстовый, и его предпосылки не подразумеваются, а возвращаются
 * в `problems`: каждый контроллер из `controllers: [...]` обязан находиться по
 * относительному импорту того же файла. Пустой `problems` — условие, которое
 * спеки проверяют наравне с самим порядком: иначе сломанный разбор выглядит как
 * чистый репозиторий.
 *
 * 🔴 За пределами разбора остаются записи `imports`, которые не являются голым
 * идентификатором: `ConfigModule.forRoot(...)`, `forwardRef(() => X)`. Своих
 * контроллеров такие записи в этом репозитории не приносят, но и обход за них
 * не идёт. Появится динамический модуль с контроллером — его место в очереди
 * будет не видно, поэтому такой случай надо будет учить разворачивать здесь.
 */

/** Место в очереди: позиция модуля в обходе, при равенстве — место в `controllers`. */
export type Rank = { module: number; slot: number };

/** `a` регистрируется раньше `b`, то есть при совпадении путей выигрывает `a`. */
export const earlier = (a: Rank, b: Rank): boolean =>
  a.module !== b.module ? a.module < b.module : a.slot < b.slot;

export type RegisteredModule = {
  /** Имя класса модуля, как оно записано в `imports`. */
  name: string;
  /** Абсолютный путь файла модуля. */
  file: string;
  /** Имена классов контроллеров этого модуля, в порядке объявления. */
  controllers: string[];
};

export type ModuleRegistration = {
  /** Модули в порядке регистрации, начиная с `AppModule`. */
  order: RegisteredModule[];
  /** Абсолютный путь файла контроллера → его место в очереди. */
  ranks: Map<string, Rank>;
  /** Сломанные предпосылки разбора; пусто — разбор в силе. */
  problems: string[];
};

export const stripComments = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Содержимое массива метаданных `@Module` по имени, разбитое по запятым. Скобки
 * считаются, а не ищется первая закрывающая: внутри `imports` лежат вызовы вида
 * `ConfigModule.forRoot({ ... })` со своими скобками.
 */
const metadataArray = (source: string, key: string): string[] => {
  const opening = `${key}: [`;
  const start = source.indexOf(opening);
  if (start === -1) return [];

  let depth = 0;
  for (let i = start + key.length + 2; i < source.length; i += 1) {
    const char = source[i];
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return source
          .slice(start + opening.length, i)
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '');
      }
    }
  }
  return [];
};

/** `import { X } from './y'` → `X` → абсолютный путь `./y.ts`. Внешние пакеты сюда не попадают. */
const localImports = (file: string, source: string): Map<string, string> => {
  const out = new Map<string, string>();
  const statement = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'(\.[^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = statement.exec(source)) !== null) {
    const target = resolve(dirname(file), `${match[2]}.ts`);
    for (const entry of match[1].split(',')) {
      // Локальное имя — то, под которым модуль стоит в `imports`, то есть часть
      // после `as`, если алиас есть.
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name !== undefined && name !== '') out.set(name, target);
    }
  }
  return out;
};

export const registrationOf = (srcRoot: string): ModuleRegistration => {
  const order: RegisteredModule[] = [];
  const ranks = new Map<string, Rank>();
  const problems: string[] = [];
  const visited = new Set<string>();

  const visit = (moduleFile: string, name: string): void => {
    if (visited.has(moduleFile)) return;
    visited.add(moduleFile);

    const position = order.length;
    const short = relative(srcRoot, moduleFile).replace(/\\/g, '/');
    const source = stripComments(readFileSync(moduleFile, 'utf8'));
    const local = localImports(moduleFile, source);
    const controllers = metadataArray(source, 'controllers');

    order.push({ name, file: moduleFile, controllers });

    controllers.forEach((controller, slot) => {
      const file = local.get(controller);
      if (file === undefined) {
        problems.push(`${short}: контроллер ${controller} не разобран — импорт не найден`);
        return;
      }
      if (!ranks.has(file)) ranks.set(file, { module: position, slot });
    });

    for (const imported of metadataArray(source, 'imports')) {
      // Голый идентификатор — модуль этого репозитория либо внешнего пакета;
      // всё остальное (`ConfigModule.forRoot(...)`) сюда не попадает.
      if (!/^[A-Z][A-Za-z0-9]*Module$/.test(imported)) continue;
      const file = local.get(imported);
      // Не разрешается относительным импортом — модуль внешний
      // (`PassportModule`, `TerminusModule`): своих контроллеров у него нет,
      // и на очередь он не влияет.
      if (file === undefined) continue;
      if (!existsSync(file)) {
        problems.push(`${short}: импорт ${imported} указывает на несуществующий ${file}`);
        continue;
      }
      visit(file, imported);
    }
  };

  visit(resolve(srcRoot, 'app.module.ts'), 'AppModule');
  return { order, ranks, problems };
};
