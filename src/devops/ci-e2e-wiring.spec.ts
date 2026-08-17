import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Сторож LEGACY-149: e2e на pull request.
 *
 * До 17.08.2026 `.github/workflows/ci.yml` — единственный конвейер, привязанный к
 * pull request, — выполнял одну команду `yarn ci` с `CI_E2E: '0'`. Ветка e2e
 * внутри `scripts/ci.sh` закрыта условием `CI_E2E=1` плюс наличие `DATABASE_URL`,
 * поэтому из 72 наборов `test/*.e2e-spec.ts` на слиянии не выполнялся ни один.
 * Настоящий прогон жил в `deploy.yml`, а тот срабатывал на push в `main` и на
 * теге `v*`, то есть уже после слияния. С 17.08.2026 push оттуда снят (`LEGACY-241`),
 * и `deploy.yml` идёт только по тегу и ручному запуску — тем важнее, что прогон
 * на слиянии больше не зависит от него вовсе.
 *
 * Дефект этого класса не ловит ничто из обычных проверок: пропущенный набор не
 * даёт ни ошибки компиляции, ни красного теста — он просто не запускается, а job
 * остаётся зелёным и по названию выглядит полноценной проверкой. `.github/workflows/**`
 * не разбирают ни `tsc`, ни `eslint`, ни один шаг конвейера, кроме этих спек.
 *
 * 🔴 Закрепляется не «строчка про e2e есть», а «прогон может покраснеть»: команда
 * без смягчений, база и Redis подняты, число баз совпадает с числом воркеров.
 * Отдельно закрыт обратный ход — `CI_E2E: '1'` без `DATABASE_URL`: `scripts/ci.sh`
 * в этом случае печатает «skipping e2e» и идёт дальше зелёным, то есть конвейер
 * выглядит включённым, а e2e по-прежнему не выполняются.
 *
 * YAML разбирается вручную по той же причине, что и в `monitoring-wiring.spec.ts`
 * и `deploy-smoke.spec.ts`: ни `yaml`, ни `js-yaml` не объявлены в `package.json`,
 * а транзитивная зависимость исчезнет на первом обновлении соседнего пакета.
 */

const ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
const CI_LINES = readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf8').split(/\r?\n/);

const isBlank = (line: string): boolean => line.trim() === '';
const isComment = (line: string): boolean => /^\s*#/.test(line);
const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

/**
 * Тело блока, открытого строкой `start`: всё, что вложено глубже неё. Пустые
 * строки и комментарии отбрасываются — в этих файлах комментарий на каждой
 * второй строке, и с ними ни одно утверждение о содержимом не читалось бы.
 */
const blockAt = (lines: string[], start: number): string[] => {
  const base = indentOf(lines[start]);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    if (indentOf(line) <= base) break;
    body.push(line);
  }
  return body;
};

/** Job'ы первого уровня вложенности вместе с их телом. */
const jobs = (): Map<string, string[]> => {
  const start = CI_LINES.findIndex((l) => /^jobs:\s*$/.test(l));
  expect(start).toBeGreaterThan(-1);
  const found = new Map<string, string[]>();
  for (let i = start + 1; i < CI_LINES.length; i += 1) {
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(CI_LINES[i]);
    if (name) found.set(name[1], blockAt(CI_LINES, i));
  }
  return found;
};

/** Шаги job'а, каждый — от своего `- ` до следующего того же уровня. */
const stepsOf = (jobBody: string[]): string[][] => {
  const start = jobBody.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (start === -1) return [];
  const steps: string[][] = [];
  for (const line of blockAt(jobBody, start)) {
    if (/^ {6}-\s/.test(line)) steps.push([line]);
    else if (steps.length > 0) steps[steps.length - 1].push(line);
  }
  return steps;
};

/** Карта `КЛЮЧ: значение` под ключом `key` внутри блока. */
const mapUnder = (block: string[], key: string): Record<string, string> => {
  const start = block.findIndex((l) => new RegExp(`^\\s+${key}:\\s*$`).test(l));
  if (start === -1) return {};
  const values: Record<string, string> = {};
  for (const line of blockAt(block, start)) {
    const pair = /^\s*([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line);
    if (pair) values[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
};

/**
 * Команда шага. Поточная запись (`run: yarn ...`) и блочная (`run: |`) равно
 * годятся: без второй ветки шаг с многострочной командой выглядел бы пустым,
 * то есть проверка молча проверяла бы ничто.
 */
const runOf = (step: string[]): string => {
  const index = step.findIndex((l) => /^\s+run:/.test(l));
  if (index === -1) return '';
  const inline = /^\s+run:\s*(.+?)\s*$/.exec(step[index]);
  if (inline && !/^[|>]/.test(inline[1])) return inline[1];
  return blockAt(step, index)
    .map((l) => l.trim())
    .join('\n');
};

/**
 * Всё, что видно строке `index` по окружению: тело её job'а плюс `env:` уровня
 * воркфлоу. Область не сужается до соседей по отображению — GitHub наследует
 * `env:` с обоих уровней, поэтому `DATABASE_URL` рядом с `CI_E2E` лежать не
 * обязан, и проверка «ключи того же блока» краснела бы на верной раскладке.
 *
 * ⚠️ Подъём ограничен снизу строкой `jobs:`: ключи блока `on:` (`push:`,
 * `pull_request:`) написаны с тем же отступом, что и имена job'ов, и без этой
 * границы за job приняли бы триггер.
 */
const enclosingScope = (lines: string[], index: number): string[] => {
  const scope: string[] = [];
  const workflowEnv = lines.findIndex((l) => /^env:\s*$/.test(l));
  if (workflowEnv !== -1) scope.push(...blockAt(lines, workflowEnv));
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  for (let i = index; i > jobsAt; i -= 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      scope.push(...blockAt(lines, i));
      break;
    }
  }
  return scope;
};

/** Образы сервисов job'а `test` в `deploy.yml` — эталон для `ci.yml`. */
const deployServiceImages = (): Record<string, string> => {
  const lines = readFileSync(join(WORKFLOWS_DIR, 'deploy.yml'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {4}services:\s*$/.test(l));
  expect(start).toBeGreaterThan(-1);
  const images: Record<string, string> = {};
  let current: string | null = null;
  for (const line of blockAt(lines, start)) {
    const service = /^ {6}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (service) {
      current = service[1];
      continue;
    }
    const image = /^\s*image:\s*(\S+)\s*$/.exec(line);
    if (current && image) images[current] = image[1];
  }
  return images;
};

const JOBS = jobs();
/** Job, который действительно зовёт e2e. Он же — предмет всей спеки. */
const e2eJobs = [...JOBS.entries()].filter(([, body]) =>
  stepsOf(body).some((step) => /\byarn\s+test:e2e/.test(runOf(step))),
);

describe('DevOps: e2e на pull request (LEGACY-149)', () => {
  it('ci.yml читает pull request — иначе стеречь нечего', () => {
    const on = CI_LINES.findIndex((l) => /^on:\s*$/.test(l));
    expect(on).toBeGreaterThan(-1);
    const triggers = blockAt(CI_LINES, on)
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.trim().replace(/:.*$/, ''));
    expect(triggers).toContain('pull_request');
    expect(triggers).toContain('push');

    // 🔴 Имя триггера ничего не гарантирует: `paths: ['src/**']` под
    // `pull_request` оставляет его на месте, а запрос, меняющий только
    // `test/**`, `prisma/**` или сам `ci.yml`, снова уходит в слияние без
    // единого e2e. `types:` сужает так же — например до одного `labeled`.
    const pullRequest = CI_LINES.findIndex((l) => /^ {2}pull_request:\s*$/.test(l));
    expect(pullRequest).toBeGreaterThan(-1);
    const filters = blockAt(CI_LINES, pullRequest).filter((l) =>
      /^\s*(paths|paths-ignore|branches-ignore|types):/.test(l),
    );
    expect(filters).toEqual([]);
  });

  // Имя yarn-скрипта не говорит о том, что он делает: подмена живёт в
  // `package.json` и `test/jest-e2e.json`, и `ci.yml` при ней не меняется ни
  // строкой. Тот же класс, из-за которого рядом с `test:cov` в `scripts/ci.sh`
  // и `deploy.yml` стоят предупреждения не заменять его на `test` (LEGACY-016).
  it('сам скрипт e2e не сужен и не смягчён', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts['test:e2e:parallel'];
    expect(script).toContain('--config ./test/jest-e2e.json');
    // `--runInBand` здесь означал бы отмену параллельности при живой строке
    // `--maxWorkers=2` в конвейере: флаг команды перебивает конфиг.
    expect(script).not.toMatch(
      /--passWithNoTests|--onlyChanged|--runInBand|--testPathPattern|--findRelatedTests|\s-t\s/,
    );

    const config = JSON.parse(readFileSync(join(ROOT, 'test', 'jest-e2e.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.testRegex).toBe('.e2e-spec.ts$');
    // Набор, выключенный через конфиг, не даёт ни красного теста, ни ошибки —
    // он просто не запускается, ровно как весь прогон до этой правки.
    expect(config.testPathIgnorePatterns).toBeUndefined();
  });

  // 🔴 Зеркало того же дефекта: `ci.yml` не запускается по тегу `v*`, поэтому
  // прогон на выкате обязан остаться. Без этого кейса удаление шага
  // `🧪 E2E Tests` из `deploy.yml` не красит ничего — сервисы там остаются, и
  // сверка образов выше их по-прежнему находит (LEGACY-207, LEGACY-209).
  it('deploy.yml по-прежнему гоняет e2e сам', () => {
    const deploy = readFileSync(join(WORKFLOWS_DIR, 'deploy.yml'), 'utf8').split(/\r?\n/);
    const runs = deploy.filter((l) => !isComment(l) && /^\s+run:\s*yarn\s+test:e2e/.test(l));
    expect(runs).toHaveLength(1);
  });

  it('ровно один job гоняет e2e', () => {
    expect(e2eJobs.map(([name]) => name)).toHaveLength(1);
  });

  // Прогон именно `test:e2e:parallel`, а не `:serial`: `--runInBand` в последнем
  // **переопределяет** `maxWorkers` из `test/jest-e2e.json`, и параллельность не
  // включилась бы вовсе — 72 набора по ~7 с на старте `AppModule` каждый.
  it('прогон идёт параллельным набором и не смягчён ничем', () => {
    const [[, body]] = e2eJobs;
    const step = stepsOf(body).find((s) => /\byarn\s+test:e2e/.test(runOf(s)))!;
    const run = runOf(step);

    // 🔴 Команда сверяется целиком, а не «начинается с»: чёрный список подстрок
    // здесь не годится в обе стороны. `; exit 0` и `|| true` глотают код
    // возврата, а `--testPathPattern=health`, `-t 'smoke'` и `--onlyChanged`
    // оставляют начало строки на месте и сводят прогон к одному набору из 72 —
    // job зелёный, e2e «идут», регрессия проходит.
    expect(run).toMatch(/^yarn test:e2e:parallel --maxWorkers=\d+$/);
    expect(body.some((l) => /^\s*continue-on-error:\s*true/.test(l))).toBe(false);
    // 🔴 `if:` ищется на **любом** уровне job'а, а не только у него самого:
    // условие у шага возвращает исходный дефект ровно так же, как у job'а
    // (`if: github.event_name == 'push'` на шаге — зелёный пустой job на каждом
    // pull request), а проверка «нет `if:` у job'а» этого не видит вовсе.
    // Условие здесь допустимо только вместе с правкой этой спеки.
    expect(body.filter((l) => /^\s+if:/.test(l))).toEqual([]);
  });

  // Без баз шаг красен всегда, и «починка» сведётся к его удалению. Health-check
  // обязателен: без него шаги стартуют раньше, чем postgres принимает
  // подключения, и отказ выглядит случайным — такой прогон отключают, а не чинят.
  it('job поднимает postgres и redis с health-check', () => {
    const [[, body]] = e2eJobs;
    const start = body.findIndex((l) => /^ {4}services:\s*$/.test(l));
    expect(start).toBeGreaterThan(-1);
    const services = blockAt(body, start);

    const imageOf = (service: string): string => {
      const at = services.findIndex((l) => new RegExp(`^ {6}${service}:\\s*$`).test(l));
      expect(at).toBeGreaterThan(-1);
      const block = blockAt(services, at);
      const image = block.find((l) => /^\s*image:/.test(l));
      expect(image).toBeDefined();
      expect(block.join('\n')).toContain('--health-cmd');
      return image!.replace(/^\s*image:\s*/, '').trim();
    };

    // 🔴 Версии сверяются с `deploy.yml`, а не с литералами: литерал держит
    // `ci.yml` на `postgres:14` и остаётся зелёным, когда выкат уехал на 16, —
    // ровно то расхождение конвейеров, ради которого этот job и заведён
    // (LEGACY-207, LEGACY-209). Одновременный подъём обеих сторон допустим.
    const reference = deployServiceImages();
    expect(reference.postgres).toBeDefined();
    expect(reference.redis).toBeDefined();
    expect(imageOf('postgres')).toBe(reference.postgres);
    expect(imageOf('redis')).toBe(reference.redis);
  });

  it('DATABASE_URL шага ведёт в поднятый сервис, а не мимо него', () => {
    const [[, body]] = e2eJobs;
    const services = blockAt(
      body,
      body.findIndex((l) => /^ {4}services:\s*$/.test(l)),
    );
    // Блок именно `postgres`, а не первый попавшийся `env:` в `services`:
    // с перестановкой сервисов местами проверка сверяла бы адрес базы с
    // окружением Redis и молча проходила бы на чём угодно.
    const postgresAt = services.findIndex((l) => /^ {6}postgres:\s*$/.test(l));
    expect(postgresAt).toBeGreaterThan(-1);
    const postgres = mapUnder(blockAt(services, postgresAt), 'env');

    const step = stepsOf(body).find((s) => /\byarn\s+test:e2e/.test(runOf(s)))!;
    const env = mapUnder(step, 'env');
    expect(env.DATABASE_URL).toBeDefined();

    // Учётные данные сверяются с сервисом, а не с литералом в спеке: смена пароля
    // в одном месте из двух даёт шестиминутный красный прогон вместо мгновенного.
    const url = new URL(env.DATABASE_URL);
    expect(url.username).toBe(postgres.POSTGRES_USER);
    expect(url.password).toBe(postgres.POSTGRES_PASSWORD);
    expect(url.pathname).toBe(`/${postgres.POSTGRES_DB}`);
    expect(url.port).toBe('5432');
    expect(env.NODE_ENV).toBe('test');
    expect(env.REDIS_HOST).toBe('localhost');
    expect(env.REDIS_PORT).toBe('6379');
  });

  // 🔴 `globalSetup` создаёт ровно `E2E_WORKERS` баз, а `setup-after-env-e2e.ts`
  // раскладывает воркеров по ним **по кругу**. Воркеров больше баз — два набора
  // пишут в одну базу и портят данные друг другу, причём прогон при этом чаще
  // зелёный, чем красный: данные в тестах уникальны по времени, и совпадают
  // только места с общей сущностью (10.08.2026 их было три из тогдашних 68 наборов).
  it('баз создаётся столько же, сколько воркеров', () => {
    const [[, body]] = e2eJobs;
    const step = stepsOf(body).find((s) => /\byarn\s+test:e2e/.test(runOf(s)))!;
    const maxWorkers = /--maxWorkers=(\d+)/.exec(runOf(step));
    expect(maxWorkers).not.toBeNull();
    expect(mapUnder(step, 'env').E2E_WORKERS).toBe(maxWorkers![1]);
  });

  // Обратный ход того же дефекта, и он опаснее исходного: конвейер выглядит
  // включённым. `scripts/ci.sh` при `CI_E2E=1` без `DATABASE_URL` печатает
  // «skipping e2e» и продолжает прогон зелёным.
  it('CI_E2E=1 нигде не стоит без непустого DATABASE_URL в том же job', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const lines = readFileSync(join(WORKFLOWS_DIR, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        if (!/^\s*CI_E2E:\s*['"]?1['"]?\s*$/.test(line)) return;
        const defined = enclosingScope(lines, index).some((l) => {
          const value = /^\s*DATABASE_URL:\s*(.*?)\s*$/.exec(l);
          // 🔴 Проверяется значение, а не наличие ключа: `scripts/ci.sh` смотрит
          // `-z "${DATABASE_URL:-}"`, поэтому пустая строка (или подстановка
          // незаданного секрета, дающая её же) читается как «базы нет» —
          // «skipping e2e» и зелёный прогон при объявленной переменной.
          return value !== null && value[1] !== '' && !/^(''|"")$/.test(value[1]);
        });
        if (!defined) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
