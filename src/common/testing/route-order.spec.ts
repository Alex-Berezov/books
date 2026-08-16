import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { earlier, Rank, registrationOf, stripComments } from './module-registration';

/**
 * Сторож порядка литеральных и динамических маршрутов (`LEGACY-120`, `LEGACY-091`,
 * `LEGACY-201`).
 *
 * В Nest маршрут выбирается по порядку объявления, поэтому литеральный путь
 * обязан стоять выше динамического с тем же числом сегментов: иначе
 * `@Get(':id')` съедает `@Get('check-slug')`, объявленный ниже. Нарушение
 * невидимо для всех остальных проверок — приложение стартует, Swagger показывает
 * оба маршрута, `tsc` и линт молчат, — маршрут просто никогда не вызывается.
 * Обнаружить можно только запросом.
 *
 * До этой спеки порядок удерживался тремя комментариями-предупреждениями
 * (`book.controller.ts`, `public.controller.ts`, `category.controller.ts`).
 * Комментарии оставлены на месте: при чтении файла они дешевле спеки.
 *
 * 🔴 **Между файлами порядок объявления не решает ничего** — решает порядок
 * регистрации модулей. Первая редакция спеки сравнивала маршруты только внутри
 * файла и рапортовала чистый репозиторий, пока `GET /admin/authors` отвечал 404
 * на проде. Вторая замораживала межфайловые пары поимённо: пара считалась
 * дефектом независимо от исхода, потому что исход спеке был не виден.
 *
 * Здесь он виден: очередь регистрации восстанавливается обходом графа модулей
 * (`module-registration.ts`), и краснеет только та пара, где перехваченный путь
 * **действительно проигрывает**. Поэтому замороженного списка больше нет —
 * сегодня таких пар ноль.
 *
 * ⚠️ Перехватом считается не только параметр над литералом, но и параметр над
 * параметром: `:lang/authors` и `:slug/authors` совпадают на любом запросе, и
 * тот из них, кто зарегистрирован позже, не вызывается никогда. Направленная
 * проверка обязана видеть этот случай: пока `PublicModule` регистрировался
 * первым, он выигрывал такие гонки молча, а теперь он последний и проигрывает
 * их так же молча.
 */

const SRC_ROOT = resolve(__dirname, '../..');

/** Ниже этих чисел обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_CONTROLLERS = 40;
const MIN_ROUTES = 250;

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'] as const;

const listControllers = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listControllers(full);
    return entry.isFile() && entry.name.endsWith('.controller.ts') ? [full] : [];
  });

const segments = (path: string): string[] => path.split('/').filter((s) => s !== '');

type Route = {
  file: string;
  method: string;
  /** Полный путь без ведущего слэша: база контроллера плюс путь обработчика. */
  path: string;
  segments: string[];
  /** Порядок объявления внутри файла. */
  index: number;
  /** Место в очереди регистрации; `undefined` — контроллер не найден в модулях. */
  rank?: Rank;
};

const routesOf = (file: string, content: string, rank?: Rank): Route[] => {
  const clean = stripComments(content);
  const base = clean.match(/@Controller\(\s*'([^']*)'\s*\)/)?.[1] ?? '';
  const decorator = new RegExp(`@(${HTTP_METHODS.join('|')})\\(\\s*(?:'([^']*)')?\\s*\\)`, 'g');

  const out: Route[] = [];
  let match: RegExpExecArray | null;
  while ((match = decorator.exec(clean)) !== null) {
    const path = [...segments(base), ...segments(match[2] ?? '')].join('/');
    out.push({
      file,
      method: match[1],
      path,
      segments: segments(path),
      index: out.length,
      rank,
    });
  }
  return out;
};

/** `@All` перехватывает любой метод, остальные — только свой. */
const sameMethod = (a: Route, b: Route): boolean =>
  a.method === b.method || a.method === 'All' || b.method === 'All';

/**
 * Маршрут `covering` перехватывает `covered`: столько же сегментов, и каждый
 * сегмент либо совпадает буквально, либо на его месте у `covering` стоит
 * параметр. Литерал параметр не перехватывает — обратное направление ложно.
 * Одинаковые пути — другой дефект, он ловится отдельно.
 */
const swallows = (covering: Route, covered: Route): boolean => {
  if (!sameMethod(covering, covered)) return false;
  if (covering.segments.length !== covered.segments.length) return false;
  if (covering.path === covered.path) return false;

  for (let i = 0; i < covering.segments.length; i += 1) {
    const a = covering.segments[i];
    const b = covered.segments[i];
    if (a === b) continue;
    if (a.startsWith(':')) continue;
    return false;
  }
  return true;
};

describe('порядок маршрутов: литеральный выше динамического', () => {
  const controllers = listControllers(SRC_ROOT);
  const { ranks, problems } = registrationOf(SRC_ROOT);
  const brokenAssumptions = [...problems];

  const byFile = new Map<string, Route[]>();
  let rawDecoratorOccurrences = 0;

  for (const file of controllers) {
    const content = readFileSync(file, 'utf8');
    const short = relative(SRC_ROOT, file).replace(/\\/g, '/');
    const clean = stripComments(content);

    // Разбор держится на трёх предпосылках, и все три проверяются здесь же, а не
    // подразумеваются: база берётся из **первого** `@Controller` файла и только
    // в строковой форме. Второй контроллер в файле склеил бы два независимых
    // порядка объявления в одну нумерацию, а форма `@Controller({ path: ... })`
    // молча дала бы базу `''` — и межфайловая проверка начала бы сравнивать
    // обрезанные пути.
    const declarations = clean.match(/@Controller\(/g) ?? [];
    if (declarations.length !== 1) {
      brokenAssumptions.push(
        `${short}: @Controller встречается ${declarations.length} раз, ожидался один`,
      );
    }
    if (!/@Controller\(\s*(?:'[^']*')?\s*\)/.test(clean)) {
      brokenAssumptions.push(
        `${short}: @Controller объявлен не строкой — разбор базы пути не применим`,
      );
    }
    // Третья: контроллер обязан быть найден в `controllers` какого-то модуля,
    // иначе его место в очереди регистрации неизвестно и межфайловая проверка
    // молча пропустит весь файл.
    if (!ranks.has(file)) {
      brokenAssumptions.push(
        `${short}: контроллер не найден ни в одном модуле — очередь регистрации неизвестна`,
      );
    }
    rawDecoratorOccurrences += (
      clean.match(new RegExp(`@(${HTTP_METHODS.join('|')})\\s*\\(`, 'g')) ?? []
    ).length;
    byFile.set(short, routesOf(short, content, ranks.get(file)));
  }

  const allRoutes = [...byFile.values()].flat();

  // Внутри файла порядок объявления и решает исход — сравнение направленное.
  const shadowed: string[] = [];
  for (const routes of byFile.values()) {
    for (const covered of routes) {
      for (const covering of routes) {
        if (covering.index >= covered.index) continue;
        if (swallows(covering, covered)) {
          shadowed.push(
            `${covered.file}: @${covered.method}('${covered.path}') объявлен ниже ` +
              `@${covering.method}('${covering.path}')`,
          );
        }
      }
    }
  }

  // Между файлами исход решает очередь регистрации модулей. Красным считается
  // только проигрыш: пара, где перехваченный маршрут зарегистрирован раньше
  // перехватчика, работает и дефектом не является.
  const lost = new Set<string>();
  for (const covering of allRoutes) {
    for (const covered of allRoutes) {
      if (covering.file === covered.file) continue;
      if (covering.rank === undefined || covered.rank === undefined) continue;
      if (!swallows(covering, covered)) continue;
      if (!earlier(covering.rank, covered.rank)) continue;
      lost.add(
        `${covered.method} ${covered.file}:'${covered.path}' мёртв — его перехватывает ` +
          `${covering.file}:'${covering.path}', зарегистрированный раньше`,
      );
    }
  }

  // Один и тот же путь, объявленный дважды: второй обработчик мёртв с рождения.
  // Считается и внутри файла, и между файлами — исход одинаково невидим.
  const seen = new Map<string, string>();
  const duplicated: string[] = [];
  for (const route of allRoutes) {
    const key = `${route.method} /${route.path}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, route.file);
      continue;
    }
    duplicated.push(`${key}: ${first} и ${route.file}`);
  }

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it('предпосылки разбора в силе: один @Controller на файл, база — строкой, модуль найден', () => {
    expect(brokenAssumptions).toEqual([]);
  });

  it(`находит не меньше ${MIN_ROUTES} маршрутов`, () => {
    expect(allRoutes.length).toBeGreaterThanOrEqual(MIN_ROUTES);
  });

  it('видит все обработчики до единого — разбор декораторов ничего не потерял', () => {
    expect(allRoutes.length).toBe(rawDecoratorOccurrences);
  });

  it('не оставляет ни одного литерального маршрута под динамическим в своём файле', () => {
    expect(shadowed).toEqual([]);
  });

  it('не оставляет ни одного маршрута, перехваченного параметром из чужого файла', () => {
    expect([...lost].sort()).toEqual([]);
  });

  it('не объявляет один и тот же путь дважды', () => {
    expect(duplicated).toEqual([]);
  });
});
