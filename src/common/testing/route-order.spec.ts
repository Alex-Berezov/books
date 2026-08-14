import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

/**
 * Сторож порядка литеральных и динамических маршрутов (`LEGACY-120`, `LEGACY-091`).
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
 * 🔴 **Внутри файлов нарушений нет, между файлами — есть, и они живые.**
 * Первая редакция этой спеки сравнивала маршруты только внутри одного файла и
 * рапортовала чистый репозиторий; ревью показало, что `GET /admin/authors`
 * в это время отвечал 404 на проде. Межфайловые пары заморожены ниже поимённо,
 * с причиной у каждой, и разбираются записью `LEGACY-201`.
 *
 * ⚠️ Межфайловая проверка **не смотрит на порядок**: он задаётся порядком
 * импортов в `app.module.ts`, которого в файле маршрута не видно вовсе. Пара,
 * где один путь перехватывает другой, — уже дефект, кто бы из них ни выиграл
 * сегодня: победитель меняется от перестановки импорта.
 */

const SRC_ROOT = resolve(__dirname, '../..');

/** Ниже этих чисел обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_CONTROLLERS = 40;
const MIN_ROUTES = 250;

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'] as const;

/**
 * Известные межфайловые перехваты, каждый — с причиной и следствием. Список
 * заморожен: новая пара красит спеку, а снятие записи отсюда означает, что
 * дефект действительно устранён.
 */
const KNOWN_CROSS_FILE = [
  // LEGACY-201: живой отказ, проверен на проде 14.08.2026 — `/api/admin/authors`
  // отвечает 404, тогда как соседний закрытый маршрут `/api/admin/pages/check-slug`
  // отвечает 401. `PublicModule` регистрируется выше `AuthorModule`, и
  // `LangParamPipe` получает `lang = 'admin'`.
  "Get modules/author/author.controller.ts:'admin/authors' ↔ modules/public/public.controller.ts:':lang/authors'",
  "Get modules/author/author.controller.ts:'admin/authors/check-slug' ↔ modules/public/public.controller.ts:':lang/authors/:slug'",
  // LEGACY-201, вторая часть: сегодня выигрывает админский маршрут только потому,
  // что `PagesModule` стоит в `app.module.ts` выше `PublicModule`. Перестановка
  // импортов — и `admin/pages/check-slug` умрёт так же, как `admin/authors`.
  "Get modules/pages/pages.controller.ts:'admin/pages/check-slug' ↔ modules/public/public.controller.ts:':lang/pages/:slug'",
];

const listControllers = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listControllers(full);
    return entry.isFile() && entry.name.endsWith('.controller.ts') ? [full] : [];
  });

const stripComments = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const segments = (path: string): string[] => path.split('/').filter((s) => s !== '');

type Route = {
  file: string;
  method: string;
  /** Полный путь без ведущего слэша: база контроллера плюс путь обработчика. */
  path: string;
  segments: string[];
  /** Порядок объявления внутри файла. */
  index: number;
};

const routesOf = (file: string, content: string): Route[] => {
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
    });
  }
  return out;
};

/** `@All` перехватывает любой метод, остальные — только свой. */
const sameMethod = (a: Route, b: Route): boolean =>
  a.method === b.method || a.method === 'All' || b.method === 'All';

/**
 * Динамический маршрут `covering` перехватывает литеральный `covered`: столько
 * же сегментов, и каждый сегмент либо совпадает буквально, либо на его месте
 * стоит параметр. Одинаковые пути — другой дефект, он ловится отдельно.
 */
const swallows = (covering: Route, covered: Route): boolean => {
  if (!sameMethod(covering, covered)) return false;
  if (covering.segments.length !== covered.segments.length) return false;
  if (covering.path === covered.path) return false;

  let sawParamOverLiteral = false;
  for (let i = 0; i < covering.segments.length; i += 1) {
    const a = covering.segments[i];
    const b = covered.segments[i];
    if (a === b) continue;
    if (a.startsWith(':') && !b.startsWith(':')) {
      sawParamOverLiteral = true;
      continue;
    }
    return false;
  }
  return sawParamOverLiteral;
};

describe('порядок маршрутов: литеральный выше динамического', () => {
  const controllers = listControllers(SRC_ROOT);

  const byFile = new Map<string, Route[]>();
  let rawDecoratorOccurrences = 0;
  const brokenAssumptions: string[] = [];

  for (const file of controllers) {
    const content = readFileSync(file, 'utf8');
    const short = relative(SRC_ROOT, file).replace(/\\/g, '/');
    const clean = stripComments(content);

    // Разбор держится на двух предпосылках, и обе проверяются здесь же, а не
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
    rawDecoratorOccurrences += (
      clean.match(new RegExp(`@(${HTTP_METHODS.join('|')})\\s*\\(`, 'g')) ?? []
    ).length;
    byFile.set(short, routesOf(short, content));
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

  // Между файлами исход решает порядок регистрации модулей, а он в файле
  // маршрута не виден. Поэтому пара считается дефектом независимо от того,
  // кто из двоих сегодня выигрывает: LEGACY-091 закрывали ровно по этой причине.
  const crossFile = new Set<string>();
  for (const a of allRoutes) {
    for (const b of allRoutes) {
      if (a.file === b.file) continue;
      if (!swallows(a, b)) continue;
      crossFile.add(`${b.method} ${b.file}:'${b.path}' ↔ ${a.file}:'${a.path}'`);
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

  it('предпосылки разбора в силе: один @Controller на файл, база — строкой', () => {
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

  it('не заводит новых межфайловых перехватов сверх замороженных', () => {
    expect([...crossFile].sort()).toEqual([...KNOWN_CROSS_FILE].sort());
  });

  it('не объявляет один и тот же путь дважды', () => {
    expect(duplicated).toEqual([]);
  });
});
