import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from '../common/testing/module-registration';

/**
 * Сторож дымовой проверки маршрутов на выкате (`LEGACY-232`).
 *
 * Шаг `📊 Verify Deployment` в `.github/workflows/deploy.yml` до 17.08.2026 звал
 * один `/api/health/readiness`. Он зелен и тогда, когда таблица маршрутов съедена:
 * `@Controller(':lang')` перехватывает литеральные админские пути той же длины,
 * зарегистрированные позже, и ручка отдаёт **404 вместо 401** при полностью
 * исправном приложении, базе и Redis. Именно так `GET /admin/authors` и
 * `/admin/authors/check-slug` были мертвы неделями (`LEGACY-201`), а выкат всё это
 * время рапортовал «All verifications passed».
 *
 * Статические сторожа этого класса уже стоят —
 * `src/common/testing/module-order.spec.ts` (виновник перестановки) и
 * `route-order.spec.ts` (какие пары маршрутов от неё проигрывают). Они читают
 * исходники. Дым на выкате проверяет то, чего им не видно вовсе: что на живом
 * домене за реверс-прокси путь доезжает до гварда именно в том образе, который
 * только что выкатили. Эта спека держит сам дым — список путей, способ сравнения
 * кода и то, чем несовпадение кончается, — потому что `.github/workflows/**`
 * не разбирает ни `tsc`, ни `eslint`, ни один другой шаг конвейера.
 *
 * 🔴 Закрепляется не «проверка есть», а «проверка может покраснеть»: цена ошибки
 * здесь двойная. Проглоченное несовпадение возвращает исходный `LEGACY-201` с
 * галкой смоука, а ложное несовпадение по `LEGACY-227` тянет за собой job
 * `rollback`, то есть откат исправного образа.
 *
 * YAML разбирается вручную по той же причине, что и в `monitoring-wiring.spec.ts`:
 * ни `yaml`, ни `js-yaml` не объявлены в `package.json`.
 */

const ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(__dirname, '..');
const DEPLOY = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const LINES = DEPLOY.split(/\r?\n/);

/** Шаг, чей дым стережётся. Анкор нужен, чтобы второй `endpoints=(` в файле не подменил список. */
const STEP = '📊 Verify Deployment';

/**
 * Маршруты, чья пропажа из дыма уже стоила недель мёртвой админки, и ожидаемый
 * код **без токена**. 401 здесь — успех: он доказывает, что запрос дошёл до
 * гварда, то есть контроллер зарегистрирован и не перекрыт `:lang`.
 *
 * `/api/books` в списке не для порядка: это единственный односегментный
 * админский `@Get()` — если BookModule не зарегистрируется, весь публичный сайт
 * останется рабочим, а админка потеряет список книг молча.
 */
const REQUIRED: Record<string, string> = {
  '/api/health/readiness': '200',
  '/api/admin/rights/intakes': '401',
  '/api/admin/authors': '401',
  '/api/admin/authors/check-slug': '401',
  '/api/books': '401',
};

/** Границы шага `📊 Verify Deployment`: от его `- name:` до следующего шага того же уровня. */
const stepRange = (): { start: number; end: number } => {
  const start = LINES.findIndex((line) => line.includes(STEP));
  if (start === -1) return { start: -1, end: -1 };
  const next = LINES.findIndex((line, i) => i > start && /^\s{6}- name:/.test(line));
  return { start, end: next === -1 ? LINES.length : next };
};

/** Строка массива `endpoints=(` — только внутри нужного шага. */
const arrayStart = (): number => {
  const { start, end } = stepRange();
  if (start === -1) return -1;
  return LINES.findIndex((line, i) => i > start && i < end && /^\s*endpoints=\(\s*$/.test(line));
};

/**
 * Все непустые строки массива `endpoints=( ... )`, как они написаны, без отбора
 * по форме. Отбирать здесь нельзя: строка без кавычек разъедется в bash на два
 * элемента массива (`expected` станет равен пути, и совпадения не будет никогда),
 * а молчаливый пропуск такой строки означал бы зелёную спеку при красном выкате.
 * Форму проверяет отдельный кейс.
 */
const endpointEntries = (): string[] => {
  const start = arrayStart();
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < LINES.length; i += 1) {
    const line = LINES[i].trim();
    if (line === ')') return out;
    if (line !== '') out.push(line);
  }
  return out;
};

/** Путь и ожидаемый код из строки массива; для строки не той формы — как есть. */
const parseEntry = (entry: string): { path: string; code: string } => {
  const quoted = entry.match(/^"([^"]+)"$/)?.[1] ?? entry;
  return { path: quoted.replace(/ .*$/, ''), code: quoted.replace(/^.* /, '') };
};

/**
 * Тело цикла проверки: от массива до итогового echo шага, **без комментариев**.
 * Комментарии выброшены не для красоты: они объясняют, почему `curl -f` здесь
 * запрещён, и сами упоминают `curl -sf` — проверка на его отсутствие ловила бы
 * собственную шапку и краснела всегда.
 */
const verifyLoopLines = (): string[] => {
  const start = arrayStart();
  const { end: stepEnd } = stepRange();
  const end = LINES.findIndex(
    (line, i) => i > start && i < stepEnd && line.includes('All verifications passed'),
  );
  if (start === -1 || end === -1) return [];
  return LINES.slice(start, end).filter((line) => !/^\s*#/.test(line));
};

const verifyLoopBody = (): string => verifyLoopLines().join('\n');

/** Баланс скобок строки без содержимого литералов — приём из `roles-guard-wiring.spec.ts`. */
const balance = (line: string): number => {
  const clean = line
    .replace(/\\./g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\/.*$/, '');
  return (clean.match(/\(/g) ?? []).length - (clean.match(/\)/g) ?? []).length;
};

/**
 * Подряд идущие декораторы одного члена класса. `@Get(...)` и относящийся к нему
 * `@UseGuards(...)` всегда лежат в одном таком блоке, а гвард соседнего метода —
 * в другом. Многострочный декоратор собирается по балансу скобок: `@ApiOperation({
 * summary: '...' })` иначе разорвал бы блок посередине.
 */
const decoratorBlocks = (content: string): string[] => {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let i = 0;

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
    if (trimmed !== '') {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [];
    }
    i += 1;
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
};

/**
 * Строгий `JwtAuthGuard`, а не подстрока: `OptionalJwtAuthGuard` содержит это имя
 * целиком и пропускает анонима, отдавая 200 вместо 401. Границы слова его
 * отсекают — между `Optional` и `Jwt` границы нет.
 */
const hasStrictJwtGuard = (text: string): boolean => /\bJwtAuthGuard\b/.test(text);

type DeclaredRoute = {
  file: string;
  /** Закрыт ли **этот обработчик**: строгий `JwtAuthGuard` в своём блоке либо на классе. */
  guarded: boolean;
};

/**
 * Полные пути всех объявленных GET-маршрутов: база контроллера плюс путь метода.
 *
 * ⚠️ Гвард считается **по обработчику, а не по файлу**: у `BookController`
 * класс-левел `@UseGuards` нет вовсе, гвард стоит поштучно на методах, и
 * `JwtAuthGuard` встречается в файле десять раз. Файловой проверки хватило бы
 * ровно до первого снятого гварда — тот же довод записан в шапке
 * `roles-guard-wiring.spec.ts`.
 *
 * ⚠️ Комментарии срезаются `stripComments` до разбора: закомментированный
 * `// @Get('admin/authors')` иначе считался бы живым маршрутом, и спека молчала
 * бы ровно в том случае, ради которого написана — маршрут удалён, дым остался.
 */
const declaredGetRoutes = (): Map<string, DeclaredRoute> => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.controller.ts')) files.push(full);
    }
  };
  walk(SRC_ROOT);

  const out = new Map<string, DeclaredRoute>();
  for (const file of files) {
    const content = stripComments(readFileSync(file, 'utf8'));
    const base = content.match(/@Controller\(\s*'([^']*)'\s*\)/)?.[1] ?? '';
    const blocks = decoratorBlocks(content);
    const classBlock = blocks.find((block) => block.includes('@Controller(')) ?? '';

    for (const block of blocks) {
      for (const match of block.matchAll(/@Get\(\s*(?:'([^']*)')?\s*\)/g)) {
        const path = [...base.split('/'), ...(match[1] ?? '').split('/')]
          .filter((segment) => segment !== '')
          .join('/');
        if (out.has(path)) continue;
        out.set(path, {
          file,
          guarded: hasStrictJwtGuard(block) || hasStrictJwtGuard(classBlock),
        });
      }
    }
  }
  return out;
};

/** Путь смоука → маршрут в контроллерах, без префикса `/api` и без query. */
const routeOf = (declared: Map<string, DeclaredRoute>, path: string): DeclaredRoute | undefined =>
  declared.get(path.replace(/^\/api\//, '').replace(/\?.*$/, ''));

describe('DevOps: дым по маршрутам на выкате', () => {
  const entries = endpointEntries();
  const smoke = new Map<string, string>(
    entries.map((entry) => {
      const { path, code } = parseEntry(entry);
      return [path, code];
    }),
  );

  it(`массив endpoints найден внутри шага «${STEP}» и разобран`, () => {
    expect(arrayStart()).toBeGreaterThan(-1);
    expect(entries.length).toBeGreaterThanOrEqual(Object.keys(REQUIRED).length);
    expect(verifyLoopLines().length).toBeGreaterThan(0);
  });

  // Формат «"путь ожидаемый_код"» в кавычках и с ровно одним пробелом. Без этого
  // кейса строка без кавычек разъехалась бы в bash на два элемента массива, а
  // строка без кода уехала бы в `expected` целиком: сравнение не совпало бы
  // никогда, и выкат краснел бы на исправном приложении.
  it('каждая строка массива — путь и ожидаемый код в кавычках', () => {
    for (const entry of entries) {
      expect(entry).toMatch(/^"\/api\/\S* [1-5][0-9][0-9]"$/);
    }
  });

  it.each(Object.entries(REQUIRED))('%s проверяется и ожидает HTTP %s', (path, code) => {
    const found = [...smoke.entries()].find(([smoked]) => smoked.replace(/\?.*$/, '') === path);
    expect(found).toBeDefined();
    expect(found?.[1]).toEqual(code);
  });

  // 🔴 `curl -f` возвращает ненулевой код на 401, поэтому правильный ответ
  // закрытой ручки выглядел бы как отказ выката. Сравнение обязано быть явным.
  it('код ответа берётся из %{http_code} и сравнивается явно', () => {
    const body = verifyLoopBody();
    expect(body).toContain("-w '%{http_code}'");
    expect(body).toContain('"$code" == "$expected"');
  });

  // Разбор строки закреплён посимвольно, потому что перепутанные `%%` и `##`
  // молчат во всех остальных кейсах: `endpoint` станет кодом, запрос уйдёт на
  // `https://домен401`, curl вернёт `000`, и шаг упадёт после пяти попыток на
  // полностью исправном проде — с откатом по `LEGACY-227` на ручном запуске.
  it('путь и код берутся из строки в правильном порядке', () => {
    const body = verifyLoopBody();
    expect(body).toContain('endpoint="${entry%% *}"');
    expect(body).toContain('expected="${entry##* }"');
  });

  // 🔴 Единственная строка, из-за которой несовпадение вообще краснеет. Без этого
  // кейса замена `exit 1` на `echo`/`continue` оставляет спеку зелёной, шаг
  // печатает ❌ и следом «All verifications passed» — возвращается исходный
  // `LEGACY-201`, только теперь с галкой смоука.
  it('несовпадение кода валит шаг, а не печатается в лог', () => {
    expect(verifyLoopBody()).toContain('exit 1');
  });

  // 🔴 `set +e` стал несущей строкой при переходе с `if curl …; then` на
  // присваивание `code=$(curl …)`: шаг идёт через `bash -e`, и внутри `if` отказ
  // подавлялся, а в присваивании нет. Без `set +e` первый же таймаут, сбой DNS
  // или 429 обрывает шаг до печати кода и до ретраев.
  it('вызов curl обёрнут set +e / set -e', () => {
    const lines = verifyLoopLines();
    const curlAt = lines.findIndex((line) => /\bcurl\b/.test(line));
    expect(curlAt).toBeGreaterThan(-1);

    const offBefore = lines.slice(0, curlAt).filter((line) => line.trim() === 'set +e').length;
    const onAfter = lines.slice(curlAt).findIndex((line) => line.trim() === 'set -e');
    expect(offBefore).toBeGreaterThanOrEqual(1);
    expect(onAfter).toBeGreaterThan(-1);
  });

  // Проверяется всё тело цикла, а не только строки со словом `curl`: вызов
  // разбит продолжением `\`, URL живёт на строке без `curl`, а флаги curl
  // принимает и после URL — `"https://…$endpoint" -f` был бы валидным вызовом
  // и прошёл бы построчную проверку насквозь.
  //
  // Хвост флага ограничен `(?![\w=-])`, а не пробелом: вызов завёрнут в `$( … )`,
  // и флаг перед закрывающей скобкой (`… "$endpoint" -f)`) при проверке на пробел
  // проходил насквозь — эта мутация первую редакцию кейса и пробила.
  it('в цикле проверки нет curl -f: на 401 он выходит с ошибкой', () => {
    const body = verifyLoopBody();
    expect(body).toMatch(/\bcurl\b/);

    const failFlags = body.match(/(?:^|\s)(?:-[a-zA-Z]*f[a-zA-Z]*|--fail\S*)(?![\w=-])/g) ?? [];
    expect(failFlags).toEqual([]);
  });

  // Список путей не должен разъезжаться с кодом: переименованный маршрут даёт
  // 404, то есть выкат краснеет на исправном приложении, и разбираться в этом
  // человек будет в момент релиза. Дешевле поймать здесь.
  it('каждый смоук-путь объявлен GET-маршрутом в контроллерах', () => {
    const declared = declaredGetRoutes();
    // Ниже этого числа сломан разбор, а не репозиторий поредел (приём из
    // `route-order.spec.ts`). Измерено 147 GET-путей на 17.08.2026; порог взят
    // с запасом, чтобы обычная чистка ручек не краснела «сломанным разбором».
    expect(declared.size).toBeGreaterThanOrEqual(120);

    for (const path of smoke.keys()) {
      expect(routeOf(declared, path)).toBeDefined();
    }
  });

  // Ожидание 401 имеет смысл только у закрытого обработчика: у открытого дым
  // краснел бы всегда, а у того, с которого однажды снимут гвард, — молча
  // перестал бы что-либо доказывать. Снятие гварда обязано краснеть здесь,
  // а не на выкате: по `LEGACY-227` красный шаг выката тянет за собой откат,
  // и симптом выглядел бы как «откат здорового образа».
  it('каждый путь с ожиданием 401 закрыт JwtAuthGuard на самом обработчике', () => {
    const declared = declaredGetRoutes();

    for (const [path, code] of smoke) {
      if (code !== '401') continue;
      const route = routeOf(declared, path);
      expect(route).toBeDefined();
      expect(route?.guarded).toBe(true);
    }
  });

  // Обратная сторона того же инварианта: гвард, повешенный на путь с ожиданием
  // 200, покрасит выкат — ответ станет 401, а ожидание останется прежним.
  it('каждый путь с ожиданием 200 остаётся открытым', () => {
    const declared = declaredGetRoutes();

    for (const [path, code] of smoke) {
      if (code !== '200') continue;
      const route = routeOf(declared, path);
      expect(route).toBeDefined();
      expect(route?.guarded).toBe(false);
    }
  });
  /**
   * 🔴 Проверка версии обязана уметь отличить «не смог спросить» от «выкатилось
   * не то». 30.08.2026 она этого не умела: `curl -sf` отвалился по таймауту,
   * `jq` на пустом вводе не вывел ничего, `api_version` стал пустой строкой —
   * и она ушла в ветку «старый контейнер всё ещё отвечает». Выкат `v1.0.15`
   * покраснел на исправном проде, который в тот момент уже отдавал `v1.0.15`,
   * а следом по `LEGACY-227` дёрнулся job отката (спасло только то, что он
   * тоже упал — на боевой машине нет `image_id` для отката).
   *
   * ⚠️ Набор стережёт именно ретраи и отдельную ветку пустого ответа. Снять их
   * «за ненадобностью» дешевле всего ровно после удачного выката, когда
   * симптома не видно, — поэтому проверка живёт здесь, а не в памяти.
   */
  describe('шаг Verify Deployment: проверка версии (30.08.2026)', () => {
    // Границы шага ищет уже существующий `stepRange()` — второй такой поиск
    // разошёлся бы с первым при первой же правке разбора YAML.
    //
    // ⚠️ Комментарии выброшены по той же причине, что и в `verifyLoopLines()`:
    // добавленная шапка шага сама пять раз упоминает `liveness`, и якорь на URL
    // ловил бы её, оставаясь зелёным при подмене адреса на `readiness` — а у того
    // поля `version` нет вовсе, и шаг навсегда ушёл бы в ветку «skipping».
    const stepText = (): string => {
      const { start, end } = stepRange();
      expect(start).toBeGreaterThanOrEqual(0);
      return LINES.slice(start, end)
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
    };

    it('версия запрашивается с ретраями, а не одной попыткой', () => {
      const text = stepText();
      // Цикл ретраев вокруг запроса версии: одна попытка проверяет тайминг
      // подмены контейнера, а не то, какой образ отвечает.
      // ⚠️ Искать просто `for attempt in` нельзя: в этом же шаге ниже стоит
      // второй такой цикл — по списку админских маршрутов. Проверка ловила бы
      // его и зеленела бы на снятых ретраях запроса версии (`L-016`). Якорь —
      // выход из цикла по непустому `api_version`: эта строка есть только там.
      const loop = text.indexOf('for attempt in');
      const probe = text.indexOf('api_version=$(curl');
      const brk = text.indexOf('-n "$api_version" ]] && break');
      expect(loop).toBeGreaterThanOrEqual(0);
      expect(probe).toBeGreaterThan(loop);
      expect(brk).toBeGreaterThan(probe);
      // ⚠️ Проверяется строка самого запроса, а не любое упоминание `liveness`
      // в шаге: его же печатают два `echo` с диагностикой, и подмена адреса
      // на `readiness` осталась бы незамеченной. А у readiness поля `version`
      // нет вовсе — шаг навсегда ушёл бы в ветку «skipping».
      const probeLine = text.slice(probe, text.indexOf('\n', probe));
      expect(probeLine).toContain('/api/health/liveness');

      // ⚠️ Одной структуры цикла мало: `for attempt in 1; do ... done` оставил бы
      // и цикл, и `break`, и все якоря выше на месте, а ретраев бы не было.
      // Поэтому проверяется само число попыток.
      const header = text.slice(loop, text.indexOf('; do', loop));
      const attempts = header.replace('for attempt in', '').trim().split(/\s+/);
      expect(attempts.length).toBeGreaterThanOrEqual(3);
    });

    it('пустой ответ — отдельная красная ветка, а не «версия не совпала» и не «пропускаем»', () => {
      const text = stepText();
      // Пустая строка обязана иметь свою проверку ДО сравнения с ожидаемой версией.
      const emptyCheck = text.indexOf('-z "$api_version"');
      const mismatch = text.indexOf('!= "${{ needs.build.outputs.version }}"');
      expect(emptyCheck).toBeGreaterThanOrEqual(0);
      expect(mismatch).toBeGreaterThanOrEqual(0);
      expect(emptyCheck).toBeLessThan(mismatch);
      // И она обязана краснеть, а не уходить в «skipping». Сравнивается только
      // тело этой ветки — до `elif` про `unknown`, где «skipping» законен:
      // контейнер, не умеющий сообщать версию, выкат валить не должен.
      const unknownBranch = text.indexOf('== "unknown"');
      expect(unknownBranch).toBeGreaterThan(emptyCheck);
      const branch = text.slice(emptyCheck, unknownBranch);
      expect(branch).toContain('exit 1');
      expect(branch).not.toContain('skipping');
    });

    it('расхождение версий по-прежнему краснеет', () => {
      const text = stepText();
      const mismatch = text.indexOf('!= "${{ needs.build.outputs.version }}"');
      expect(mismatch).toBeGreaterThanOrEqual(0);
      // ⚠️ Срез обрывается на итоговом echo шага, а не тянется до конца: ниже
      // лежит цикл по админским маршрутам со своим `exit 1`, и проверка до конца
      // шага зеленела бы на снятом `exit 1` этой ветки (`L-008`). Граница — начало
      // списка `endpoints=(`, то есть первая строка, которая этой ветке уже не своя.
      const endpointsList = text.indexOf('endpoints=(');
      expect(endpointsList).toBeGreaterThan(mismatch);
      expect(text.slice(mismatch, endpointsList)).toContain('exit 1');
    });

    it('шаг не ослаблен continue-on-error и не глушит свой код возврата', () => {
      const text = stepText();
      expect(text).not.toContain('continue-on-error');
      // ⚠️ Хвост, отбрасывающий код возврата, в шаге отсутствует вовсе: запрос
      // версии сидит в условии `if !`, поэтому `set -e` его не убивает, а неудача
      // честно превращается в пустую строку с отдельной красной веткой.
      //
      // И отдельно о причине, которая напрашивается и неверна: `shell:` у шага нет,
      // значит `pipefail` не включён, и упавший по таймауту `curl` шаг не убивает —
      // статусом пайпа становится статус `jq`, а он на пустом вводе выходит нулём.
      // Инцидент 30.08.2026 это и показал: шаг не умер, а дошёл до сравнения
      // с пустой строкой. Опасен другой случай — оборванный посреди JSON ответ.
      expect(text).not.toMatch(/exit 1[^\n]*\|\| true/);
    });
  });
});
