import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { allRoutes, listFiles, SRC_ROOT, type HttpVerb } from './controller-decorators';
import { callsOf, mismatchesOf, verifyPaths, type Route } from './e2e-route-paths';

/**
 * Сторож путей e2e-спек против объявленных маршрутов контроллеров
 * (`LEGACY-024`). Сам разбор — в `e2e-route-paths.ts`, здесь только сверка
 * и пробы на отказ.
 *
 * Запись заведена по прецеденту: спек фазы 18 упал на CI девятью тестами,
 * потому что был написан по маршрутам «из памяти» — материализация живёт на
 * `POST /admin/rights/review-imports/:importId/materialize`, а не вложена
 * в интейк. Код фазы был исправен, ошибка жила только в спеке, но увидеть её
 * можно было единственным способом — прогоном на поднятой базе. Здесь тот же
 * дефект краснеет за секунды и без базы.
 *
 * 🔴 Путь, который разбор не смог восстановить, — **отдельный исход, а не
 * пропуск** (`L-015`). Поэтому ниже стоят и порог на число **сверенных путей**
 * (а не найденных вызовов), и отдельный кейс на пустой список невосстановимых.
 *
 * Чего сторож **не** проверяет: тело ответа, права и порядок регистрации
 * (последнее — `route-order.spec.ts`). Совпадение пути с объявленным маршрутом
 * не означает, что запрос дойдёт: перехват динамическим маршрутом из чужого
 * файла ловит другой сторож.
 */

const TEST_ROOT = resolve(SRC_ROOT, '../test');

/** Ниже этих чисел сломан разбор, а не репозиторий поредел. */
const MIN_SPEC_FILES = 80;
const MIN_CHECKED_PATHS = 900;
const MIN_ROUTES = 250;

describe('пути e2e-спек существуют как маршруты контроллеров', () => {
  const { routes: declared, skipped } = allRoutes();
  const routes: Route[] = declared.map((route) => ({
    verb: route.verb,
    segments: route.path.split('/').filter((s) => s !== ''),
  }));

  const files = listFiles(TEST_ROOT, (path) => path.endsWith('.e2e-spec.ts'));
  const calls = files.flatMap((file) =>
    callsOf(readFileSync(file, 'utf8'), relative(TEST_ROOT, file).replace(/\\/g, '/')),
  );

  const unresolved = calls
    .filter((call) => call.unresolved !== undefined)
    .map(
      (call) => `${call.file}:${call.line}: ${call.verb.toUpperCase()} ${call.unresolved ?? ''}`,
    );

  it(`разбирает не меньше ${MIN_SPEC_FILES} файлов e2e`, () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_SPEC_FILES);
  });

  it(`сверяет не меньше ${MIN_CHECKED_PATHS} путей, а не просто находит вызовы`, () => {
    expect(verifyPaths(routes, calls).checked).toBeGreaterThanOrEqual(MIN_CHECKED_PATHS);
  });

  it(`снимает не меньше ${MIN_ROUTES} маршрутов и не пропускает контроллеров`, () => {
    expect(skipped).toEqual([]);
    expect(routes.length).toBeGreaterThanOrEqual(MIN_ROUTES);
  });

  it('не оставляет ни одного обращения с невосстановимым путём', () => {
    expect(unresolved).toEqual([]);
  });

  it('не ходит ни по одному пути, которого нет среди маршрутов', () => {
    expect(verifyPaths(routes, calls).mismatches).toEqual([]);
  });
});

describe('сторож путей e2e: проба на отказ', () => {
  const routes: Route[] = [
    { verb: 'get', segments: ['admin', 'authors'] },
    { verb: 'post', segments: ['admin', 'rights', 'review-imports', ':importId', 'materialize'] },
    { verb: 'get', segments: ['books', ':id'] },
    { verb: 'get', segments: ['admin', 'rights', 'claims', ':id'] },
  ];

  const clean = `
    const PATH = '/admin/authors';
    const post = (p: string, body: object) => request(http()).post(p).send(body);
    it('works', async () => {
      await request(http()).get(PATH);
      await request(http()).get(\`/books/\${bookId}\`);
      await post(\`/admin/rights/review-imports/\${importId}/materialize\`, {});
    });
    it.each([['a', '/admin/authors'], ['b', '/books/42']])('%s', async (_n, path) => {
      await request(http()).get(path);
    });
  `;

  it('на исправном входе молчит — и видит все пять путей, включая обёртку и таблицу', () => {
    const calls = callsOf(clean, 'clean.e2e-spec.ts');
    expect(calls.filter((c) => c.unresolved !== undefined)).toEqual([]);
    expect(calls.flatMap((c) => c.paths)).toHaveLength(5);
    expect(verifyPaths(routes, calls)).toEqual({
      mismatches: [],
      checked: 5,
      declaredAbsent: [],
    });
  });

  it('краснеет на пути, которого нет: маршрут вложен в интейк, как в прецеденте записи', () => {
    const broken = clean.replace(
      '/admin/rights/review-imports/${importId}/materialize',
      '/admin/rights/intakes/${intakeId}/materialize',
    );
    expect(mismatchesOf(routes, callsOf(broken, 'broken.e2e-spec.ts'))).toEqual([
      expect.stringContaining('POST'),
    ]);
  });

  it('краснеет на верном пути с чужим глаголом', () => {
    const wrongVerb = clean.replace('request(http()).get(PATH)', 'request(http()).put(PATH)');
    expect(mismatchesOf(routes, callsOf(wrongVerb, 'verb.e2e-spec.ts'))).toEqual([
      expect.stringContaining('PUT'),
    ]);
  });

  it('краснеет на строке из таблицы it.each, а не только на литерале у вызова', () => {
    const brokenTable = clean.replace("'/books/42'", "'/books/42/chapters'");
    expect(mismatchesOf(routes, callsOf(brokenTable, 'table.e2e-spec.ts'))).toEqual([
      expect.stringContaining('/books/42/chapters'),
    ]);
  });

  it('называет путь невосстановимым, а не пропускает его молча', () => {
    const opaque = "it('x', async () => { await request(http()).get(urls[i]); });";
    const calls = callsOf(opaque, 'opaque.e2e-spec.ts');
    expect(calls).toHaveLength(1);
    expect(calls[0].unresolved).toBe('urls[i]');
    expect(calls[0].paths).toEqual([]);
  });

  it('не принимает за константу `let`, которому путь присвоят позже', () => {
    const later =
      "let url = ''; beforeAll(() => { url = '/admin/authors'; });" +
      "it('x', async () => { await request(http()).get(url); });";
    const calls = callsOf(later, 'later.e2e-spec.ts');
    expect(calls[0].paths).toEqual([]);
    expect(calls[0].unresolved).toBe('url');
  });

  it('не считает обращением к приложению вызов чужого объекта', () => {
    const noise = "it('x', () => { cache.get('/books/1'); map.post('/nope'); });";
    expect(callsOf(noise, 'noise.e2e-spec.ts')).toEqual([]);
  });

  it('молчит на существующем пути, у которого спека требует отказа по методу', () => {
    const absent =
      "it('x', async () => { await request(http()).delete(`/admin/rights/claims/${id}`)" +
      ".set('Authorization', t).expect(404); });";
    const calls = callsOf(absent, 'absent.e2e-spec.ts');
    const result = verifyPaths(routes, calls);

    expect(calls[0].expectsAbsence).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.declaredAbsent).toEqual([expect.stringContaining('метод не поддержан')]);
  });

  it('краснеет на том же пути, если кода 404 в цепочке нет', () => {
    const same =
      "it('x', async () => { await request(http()).delete(`/admin/rights/claims/${id}`)" +
      ".set('Authorization', t).expect(200); });";
    expect(mismatchesOf(routes, callsOf(same, 'same.e2e-spec.ts'))).toEqual([
      expect.stringContaining('/admin/rights/claims'),
    ]);
  });

  it('краснеет на опечатке в пути даже с `.expect(404)` — такого адреса нет ни под каким глаголом', () => {
    const typo =
      "it('x', async () => { await request(http()).get('/admin/author').expect(404); });";
    expect(mismatchesOf(routes, callsOf(typo, 'typo.e2e-spec.ts'))).toEqual([
      expect.stringContaining('/admin/author'),
    ]);
  });

  it('находит маршрут с параметром внутри сегмента', () => {
    const sitemap: Route[] = [{ verb: 'get' as HttpVerb, segments: ['sitemap-:lang.xml'] }];
    const spec = "it('x', async () => { await request(http()).get('/sitemap-en.xml'); });";
    expect(mismatchesOf(sitemap, callsOf(spec, 'sitemap.e2e-spec.ts'))).toEqual([]);

    const wrong = "it('x', async () => { await request(http()).get('/sitemap-en.json'); });";
    expect(mismatchesOf(sitemap, callsOf(wrong, 'sitemap.e2e-spec.ts'))).toHaveLength(1);
  });

  it('пропускает строку запроса, собранную подстановкой', () => {
    const query = "it('x', async () => { await request(http()).get(`/admin/authors${q}`); });";
    expect(mismatchesOf(routes, callsOf(query, 'query.e2e-spec.ts'))).toEqual([]);
  });

  it('видит обёртку, которая подставляет свой параметр в шаблон', () => {
    const wrapper =
      'const get = (query: string) => request(http()).get(`/books/${bookId}${query}`);' +
      "it('x', async () => { await get('?page=1'); await get(''); });";
    const calls = callsOf(wrapper, 'wrapper.e2e-spec.ts');

    expect(calls).toHaveLength(2);
    expect(verifyPaths(routes, calls).checked).toBe(2);
  });

  it('краснеет на такой обёртке, если её шаблон разошёлся с маршрутом', () => {
    const wrapper =
      'const get = (query: string) => request(http()).get(`/book/${bookId}${query}`);' +
      "it('x', async () => { await get('?page=1'); });";
    expect(mismatchesOf(routes, callsOf(wrapper, 'wrapper.e2e-spec.ts'))).toEqual([
      expect.stringContaining('/book/'),
    ]);
  });

  it('сегмент с известным началом не совпадает с чужим литералом', () => {
    const other: Route[] = [
      { verb: 'get', segments: [':lang', 'tags'] },
      { verb: 'get', segments: ['health'] },
    ];
    const spec =
      "it('x', async () => { await request(http()).get(`/en/books${query}`);" +
      ' await request(http()).get(`/categories${query}`); });';

    expect(mismatchesOf(other, callsOf(spec, 'prefix.e2e-spec.ts'))).toEqual([
      expect.stringContaining('/en/books'),
      expect.stringContaining('/categories'),
    ]);
  });

  it('тот же сегмент совпадает со своим маршрутом', () => {
    const own: Route[] = [{ verb: 'get', segments: [':lang', 'books'] }];
    const spec = "it('x', async () => { await request(http()).get(`/en/books${query}`); });";

    expect(mismatchesOf(own, callsOf(spec, 'prefix.e2e-spec.ts'))).toEqual([]);
  });

  it('обёртка не глотает соседние обращения из своего тела', () => {
    const wrapper =
      'const get = async (p: string) => {' +
      " await request(http()).post('/auth/loign').send(body);" +
      ' return request(http()).get(p); };' +
      "it('x', async () => { await get('/admin/authors'); });";

    expect(mismatchesOf(routes, callsOf(wrapper, 'nested.e2e-spec.ts'))).toEqual([
      expect.stringContaining('/auth/loign'),
    ]);
  });

  it('видит `HttpStatus.NOT_FOUND` наравне с числом 404', () => {
    const named =
      "it('x', async () => { await request(http()).delete(`/admin/rights/claims/${id}`)" +
      '.expect(HttpStatus.NOT_FOUND); });';
    const calls = callsOf(named, 'named.e2e-spec.ts');

    expect(calls[0].expectsAbsence).toBe(true);
    expect(mismatchesOf(routes, calls)).toEqual([]);
  });

  it('видит код отказа и в цепочке через обёртку', () => {
    const wrapper =
      'const del = (p: string) => request(http()).delete(p);' +
      "it('x', async () => { await del(`/admin/rights/claims/${id}`).expect(404); });";
    const calls = callsOf(wrapper, 'wrapper.e2e-spec.ts');

    expect(calls[0].expectsAbsence).toBe(true);
    expect(mismatchesOf(routes, calls)).toEqual([]);
  });
});
