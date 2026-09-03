import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Сторож LEGACY-222 и LEGACY-224. Механизм обоих дефектов разобран в шапке
 * `docker-compose.monitoring.yml`; здесь важно только то, что ни `tsc`, ни
 * `eslint`, ни `promtool` их не ловят: promtool разбирает содержимое конфигов
 * и ничего не знает про то, куда эти файлы смонтированы, а `.github/workflows/**`
 * не читает вообще никто. Спека идёт в `yarn test`, то есть на обоих путях
 * выката (`scripts/ci.sh` и `deploy.yml`).
 *
 * YAML разбирается вручную: ни `yaml`, ни `js-yaml` не объявлены в
 * `package.json`, а транзитивная зависимость исчезнет на первом обновлении
 * соседнего пакета.
 */
describe('DevOps: monitoring config wiring', () => {
  const root = join(__dirname, '..', '..');
  const composePath = join(root, 'docker-compose.monitoring.yml');
  const compose = readFileSync(composePath, 'utf8');

  /**
   * Секреты монтируются по сервису из каталога **вне репозитория** (`LEGACY-226`):
   * каждый контейнер видит только свой. Пока они лежали в `configs/`, каталожный
   * монтаж отдавал Prometheus токен бота, а Alertmanager — bearer ко всем метрикам.
   */
  const SERVICE_SECRETS: Record<string, string> = {
    prometheus: 'metrics_token',
    alertmanager: 'telegram_token',
  };

  /**
   * Секреты вне `configs/`, которые обязаны быть закрыты `.gitignore` по той же
   * причине (`LEGACY-223`): `git stash --include-untracked` на выкате уносит
   * неотслеживаемое и не игнорируемое, а отказ выглядит как падение приложения.
   */
  const HOST_SECRET_FILES = ['.env.monitoring-secrets'];

  /**
   * Закрыт ли путь `.gitignore`. Из синтаксиса git нужны только `*` и `!`:
   * побеждает **последняя** совпавшая строка, иначе `!configs/x` ниже маски
   * читался бы как «всё равно закрыт», и проверка врала бы в самую опасную сторону.
   */
  const isGitIgnored = (relPath: string): boolean => {
    let ignored = false;
    for (const raw of readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;
      const re = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
      );
      if (re.test(relPath)) ignored = !negated;
    }
    return ignored;
  };

  /** Строки одного сервиса из `services:` — без разбора вложенности. */
  const serviceLines = (name: string): string[] => {
    const lines = compose.split(/\r?\n/);
    const start = lines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l));
    expect(start).toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^ {0,2}\S/.test(l) && !/^\s*#/.test(l));
    return end === -1 ? rest : rest.slice(0, end);
  };

  /** Элементы списка под ключом `key` внутри блока сервиса. */
  const listUnder = (blockLines: string[], key: string): string[] => {
    const items: string[] = [];
    let depth: number | null = null;
    for (const line of blockLines) {
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      // Поточная запись (`volumes: ['./configs:/cfg:ro']`) — валидный YAML, и без
      // этой ветки список вышел бы пустым, то есть проверка молча проверяла бы ничто.
      const flow = new RegExp(`^\\s+${key}:\\s*\\[(.*)\\]\\s*$`).exec(line);
      if (flow) {
        items.push(
          ...flow[1]
            .split(',')
            .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
            .filter((v) => v !== ''),
        );
        depth = null;
        continue;
      }
      // Хвостовой комментарий у ключа допускается: без этого `volumes: # LEGACY-224`
      // давал бы пустой список, то есть зелёный тест на любом содержимом.
      const keyMatch = new RegExp(`^(\\s+)${key}:\\s*(?:#.*)?$`).exec(line);
      if (keyMatch) {
        depth = keyMatch[1].length;
        continue;
      }
      if (depth === null) continue;
      const indent = /^\s*/.exec(line)![0].length;
      // Хвостовой комментарий отбрасывается и у элемента списка: в этих файлах
      // комментарий на каждой второй строке, и `- ./configs:/cfg:ro  # каталогом`
      // иначе не прошёл бы ни одну проверку значения при верном compose.
      const item = /^\s*-\s+(.*?)\s*(?:#.*)?$/.exec(line);
      if (item && indent > depth) {
        items.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      if (indent <= depth) depth = null;
    }
    return items;
  };

  /** Куда сервис монтирует каталог `./configs` целиком. */
  const configsMountTarget = (service: string): string => {
    const volumes = listUnder(serviceLines(service), 'volumes');
    const dirMounts = volumes.filter((v) => /^\.\/configs:/.test(v));
    // Ровно одно монтирование каталога: два дали бы два разных префикса пути,
    // и утверждения ниже перестали бы отвечать на вопрос однозначно.
    expect(dirMounts).toHaveLength(1);
    const [, target] = dirMounts[0].split(':');
    expect(target).toMatch(/^\/\S+$/);
    return target;
  };

  /**
   * Разбор элемента `volumes` на источник, цель и режим. По последним двум
   * двоеточиям, а не по первому: источник сам содержит `:` внутри
   * `${VAR:-default}`, и наивный `split(':')` вернул бы `${VAR`.
   */
  const parseMount = (item: string): { source: string; target: string; mode: string } => {
    const m = /^(.+):(\/[^:]+):(ro|rw)$/.exec(item);
    expect({ item, parsed: m !== null }).toEqual({ item, parsed: true });
    return { source: m![1], target: m![2], mode: m![3] };
  };

  /** Куда сервис монтирует свой каталог секретов и что монтирует. */
  const secretsMount = (service: string): { source: string; target: string; mode: string } => {
    const mounts = listUnder(serviceLines(service), 'volumes')
      .filter((v) => /:\/secrets:/.test(v))
      .map(parseMount);
    // Ровно одно: второе монтирование секретов означало бы, что сервис видит
    // и чужой токен — тот самый дефект, из-за которого их разносили.
    expect(mounts).toHaveLength(1);
    return mounts[0];
  };

  /**
   * Ссылки вида `<что-то>_file: <путь>` из конфига. Кавычки и хвостовой
   * комментарий отбрасываются: без этого валидная запись `bot_token_file:
   * '/cfg/telegram_token'` выпала бы из выборки, и проверка стала бы пустой.
   */
  const configReferences = (file: string): { key: string; path: string }[] => {
    const text = readFileSync(join(root, 'configs', file), 'utf8');
    return text
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .map((l) => /^\s*(\w+_file):\s*(.+?)\s*(?:#.*)?$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ key: m[1], path: m[2].trim().replace(/^['"]|['"]$/g, '') }));
  };

  describe('LEGACY-224: каталог целиком, а не файлами по отдельности', () => {
    // Пофайловый bind-mount привязан к inode, поэтому новая версия файла на
    // хосте до контейнера не доезжает вовсе, а `reload` перечитывает прежнюю
    // копию и отвечает `200`. Возврат этой строки — возврат дефекта.
    it.each(['prometheus', 'alertmanager'])(
      '%s не монтирует отдельные файлы из configs/',
      (service) => {
        const block = serviceLines(service);
        const volumes = listUnder(block, 'volumes');
        // Сначала — что список вообще разобран: пустой дал бы `[] === []`
        // и зелёный тест при сломанном разборе YAML.
        expect(volumes.length).toBeGreaterThan(0);
        // Любая форма источника, а не только `./configs/...`: абсолютный путь
        // и `${PWD}/configs/...` дают ту же привязку к inode.
        expect(volumes.filter((v) => /(^|\/|\})configs\/[^:]+:/.test(v))).toEqual([]);
        // Длинный синтаксис (`- type: bind` / `source: ./configs/x.yml`) — тот же
        // пофайловый монтаж другими словами: `listUnder` вернул бы `type: bind`,
        // и короткая проверка выше его не увидела бы вовсе.
        expect(block.filter((l) => /^\s*source:\s*['"]?\S*configs\/[^'"\s]+/.test(l))).toEqual([]);
      },
    );

    it.each(['prometheus', 'alertmanager'])('%s монтирует configs/ только на чтение', (service) => {
      const [mount] = listUnder(serviceLines(service), 'volumes').filter((v) =>
        /^\.\/configs:/.test(v),
      );
      expect(mount).toMatch(/:ro$/);
    });
  });

  describe('пути внутри контейнера ведут в смонтированный каталог', () => {
    it.each([
      ['prometheus', 'prometheus.yml'],
      ['alertmanager', 'alertmanager.yml'],
    ])('--config.file сервиса %s указывает на %s внутри монтирования', (service, fileName) => {
      const target = configsMountTarget(service);
      const [configFlag] = listUnder(serviceLines(service), 'command').filter((c) =>
        c.startsWith('--config.file='),
      );
      expect(configFlag).toBe(`--config.file=${target}/${fileName}`);
      expect(existsSync(join(root, 'configs', fileName))).toBe(true);
    });

    /**
     * Ожидаемая связка «ключ → файл», а не только «путь внутри монтирования».
     * Одного префикса мало: `bot_token_file: /cfg/metrics_token` прошёл бы все
     * остальные проверки, `amtool check-config` и `promtool check config` — тоже,
     * а на проде Alertmanager ходил бы в Telegram с bearer'ом метрик (канал
     * молчит), Prometheus получал бы 401 и зажигал ложный `BooksAppDown`.
     */
    const EXPECTED_REFS: Record<string, Record<string, string>> = {
      'prometheus.yml': { credentials_file: 'metrics_token' },
      'alertmanager.yml': { bot_token_file: 'telegram_token' },
    };

    it.each([
      ['prometheus.yml', 'prometheus'],
      ['alertmanager.yml', 'alertmanager'],
    ])(
      'ссылки на файлы в %s ведут ровно к своим файлам внутри монтирования',
      (configFile, service) => {
        const refs = configReferences(configFile);
        const expected = EXPECTED_REFS[configFile];
        const secrets = secretsMount(service);
        // Сверяются обе стороны: каждая найденная ссылка ожидаема, и каждая
        // ожидаемая найдена. Список, а не объект: одноимённые ключи схлопнулись бы
        // в последний, и второй `bot_token_file` со старым путём (например
        // в отдельной ветке для critical) прошёл бы незамеченным.
        expect(refs.map(({ key, path }) => `${key}=${path}`).sort()).toEqual(
          Object.entries(expected)
            .map(([key, base]) => `${key}=${secrets.target}/${base}`)
            .sort(),
        );
      },
    );

    // Каждый сервис монтирует свой каталог секретов, и только свой: имя каталога
    // на хосте совпадает с именем сервиса, а внутри лежит именно его токен.
    it.each(Object.keys(SERVICE_SECRETS))('%s монтирует только свой секрет', (service) => {
      const { source, target, mode } = secretsMount(service);
      expect(source.endsWith(`/${service}`)).toBe(true);
      // Вне репозитория: относительный путь вернул бы секреты под `git stash
      // --include-untracked` и `git reset --hard` на выкате (LEGACY-223).
      expect(source.startsWith('./')).toBe(false);
      expect(target).toBe('/secrets');
      // Внутрь рабочего дерева — тоже нет: там секреты попадают под
      // `git stash --include-untracked` и `git reset --hard` на выкате.
      // Слово `configs` не должно встречаться нигде в источнике, включая значение
      // по умолчанию внутри `${VAR:-…}`: `.../configs}` тоже ведёт в репозиторий.
      expect(source).not.toContain('configs');
      expect(mode).toBe('ro');
    });

    it('rule_files заданы относительными путями и все файлы существуют', () => {
      const text = readFileSync(join(root, 'configs', 'prometheus.yml'), 'utf8');
      const block = /^rule_files:\s*$([\s\S]*?)^\S/m.exec(text + '\nEOF');
      expect(block).not.toBeNull();
      const files = block![1]
        .split(/\r?\n/)
        .map((l) => /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1]);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        // Относительный путь резолвится от каталога конфига, то есть от точки
        // монтирования. Абсолютный пришлось бы править при каждом её изменении.
        expect(file.startsWith('/')).toBe(false);
        expect({ file, exists: existsSync(join(root, 'configs', file)) }).toEqual({
          file,
          exists: true,
        });
      }

      // И обратная сторона: каждый набор правил из `configs/` обязан быть
      // перечислен. `promtool` про пропущенный файл молчит — он проверяет то,
      // что ему дали. Убранный `recording_rules.yml` оставил бы четыре правила
      // поверх `books_app:*` без входных рядов: выражение пусто, алерт молчит
      // навсегда, конвейер зелёный.
      const onDisk = readdirSync(join(root, 'configs'))
        .filter((f) => /_rules\.yml$/.test(f) && !/\.test\.yml$/.test(f))
        // Игнорируемое git не считается: `scripts/setup_monitoring.sh` кладёт рядом
        // копию `prometheus_alert_rules.yml`, которую Prometheus не читает. Без этого
        // фильтра спека краснела бы на исправном конфиге у всех, кто разворачивал
        // мониторинг локально, — и приучала бы считать сторожа шумным.
        .filter((f) => !isGitIgnored(`configs/${f}`))
        .sort();
      expect(files.slice().sort()).toEqual(onDisk);
    });

    // Вся описанная в `backend/guides/monitoring.md` процедура применения правок
    // держится на этом флаге: без него `POST /-/reload` отвечает
    // `Lifecycle API is not enabled`, и правки правил снова требуют пересоздания
    // контейнера — симптом LEGACY-224 другим механизмом.
    it('у Prometheus включён lifecycle API', () => {
      expect(listUnder(serviceLines('prometheus'), 'command')).toContain('--web.enable-lifecycle');
    });

    // LEGACY-223: неотслеживаемый и не игнорируемый файл уносит
    // `git stash --include-untracked` на первом же выкате, и отказ выглядит как
    // падение приложения. Поэтому каждый секрет из `HOST_SECRETS` обязан быть
    // закрыт `.gitignore` — иначе объявить его здесь мало.
    // Секреты мониторинга живут вне репозитория (LEGACY-226), но маски в
    // `.gitignore` остаются страховкой от возврата файлов внутрь `configs/`:
    // ротация, записанная по привычке в старое место, иначе уедет в коммит.
    it.each([...Object.values(SERVICE_SECRETS).map((s) => `configs/${s}`), ...HOST_SECRET_FILES])(
      'секрет %s закрыт .gitignore',
      (path) => {
        expect({ path, ignored: isGitIgnored(path) }).toEqual({ path, ignored: true });
      },
    );

    it('--web.console.* не перекрыты монтированием configs/', () => {
      const target = configsMountTarget('prometheus');
      const consoleFlags = listUnder(serviceLines('prometheus'), 'command').filter((c) =>
        c.startsWith('--web.console.'),
      );
      expect(consoleFlags).toHaveLength(2);
      for (const flag of consoleFlags) {
        // Каталоги приходят из образа. Смонтировать configs/ поверх них —
        // значит скрыть их: интерфейс консолей отвечал бы 404 при живом сервисе.
        expect(flag.split('=')[1].startsWith(`${target}/`)).toBe(false);
      }
    });
  });

  describe('LEGACY-222: булев вход workflow_dispatch — строка', () => {
    const workflowsDir = join(root, '.github', 'workflows');

    /** Условие `if:` у job первого уровня вложенности в `deploy.yml`. */
    const jobCondition = (job: string): string => {
      const lines = readFileSync(join(workflowsDir, 'deploy.yml'), 'utf8').split(/\r?\n/);
      const start = lines.findIndex((l) => new RegExp(`^  ${job}:\\s*$`).test(l));
      expect(start).toBeGreaterThan(-1);
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => /^ {0,2}\S/.test(l) && !/^\s*#/.test(l));
      const body = (end === -1 ? rest : rest.slice(0, end)).filter((l) => !/^\s*#/.test(l));
      const cond = body.find((l) => /^\s{4}if:/.test(l));
      expect(cond).toBeDefined();
      return cond!.replace(/^\s*if:\s*/, '');
    };

    // Форма выражения — половина дела. Вторая половина — сам инвариант: выкат
    // требует пройденных тестов, а пропуск возможен только по осознанной галке.
    // Без этого гейт можно переписать на `skip_tests != 'false'` (на push вход
    // пуст, условие истинно) и выкатывать прод при красных тестах — формально
    // сравнение с литералом на месте.
    it('job test выполняется всюду, кроме осознанного skip_tests', () => {
      expect(jobCondition('test')).toBe("${{ github.event.inputs.skip_tests != 'true' }}");
    });

    // Равенством, а не набором `toContain`: дописанное `|| github.event_name ==
    // 'workflow_dispatch'` оставило бы все подстроки на месте, и ручной выкат снова
    // уходил бы на прод при красных тестах — последствие LEGACY-222 в полном объёме.
    //
    // 20.08.2026 к условию добавлен гейт `ci_gate` (зелёный `ci.yml` на коммите тега).
    // Строка переписана целиком, а не ослаблена до `toContain`: смысл проверки в том,
    // что условие выката читается человеком при каждой правке, и любое новое слагаемое
    // обязано пройти через этот тест.
    //
    // 🔴 03.09.2026, `LEGACY-364`. Добавлено слагаемое про `needs.e2e.result`, и это
    // не косметика: e2e переехали из job'а `test` отдельным job'ом `e2e`, а `!cancelled()`
    // в начале условия **снимает** неявный гейт «все зависимости зелены» — с ним job
    // запускается и при упавшей зависимости. То есть одного `needs: [..., e2e, ...]`
    // мало: без этой скобки красный набор перестал бы останавливать прод, а выглядело бы
    // это как исправная зависимость. Сравнение по-прежнему на равенство целиком.
    it('выкат требует пройденных тестов, пропуск — только по галке', () => {
      expect(jobCondition('deploy')).toBe(
        "${{ !cancelled() && needs.build.result == 'success' && (needs.test.result == 'success' || github.event.inputs.skip_tests == 'true') && (needs.e2e.result == 'success' || github.event.inputs.skip_tests == 'true') && (needs.ci_gate.result == 'success' || needs.ci_gate.result == 'skipped') }}",
      );
    });

    // Проверка разбирает однострочный `if:`. Свёрнутый (`if: >` / `if: |`)
    // прошёл бы мимо неё молча, поэтому такой формы в воркфлоу быть не должно:
    // либо она запрещена, либо проверку надо доучивать вместе с ней.
    // LEGACY-227. У job без `needs:` нет предков, и `failure()` в его условии
    // не значит «что-то упало раньше». Откат обязан зависеть от выката и
    // срабатывать только на его отказе, иначе упавший юнит-тест на ручном прогоне
    // переливает прод, которого не выкатывали.
    it('откат зависит от выката и срабатывает только на его отказе', () => {
      const lines = readFileSync(join(workflowsDir, 'deploy.yml'), 'utf8').split(/\r?\n/);
      const start = lines.findIndex((l) => /^ {2}rollback:\s*$/.test(l));
      expect(start).toBeGreaterThan(-1);
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => /^ {0,2}\S/.test(l) && !/^\s*#/.test(l));
      const body = (end === -1 ? rest : rest.slice(0, end)).filter((l) => !/^\s*#/.test(l));
      // Форма записи `needs` не важна — важно, что зависимость от `deploy` есть:
      // поточная (`[deploy]`), блочная (`- deploy`) и расширенная равно годятся.
      expect(
        body.some((l) => /^\s{4}needs:.*\bdeploy\b/.test(l) || /^\s{6}-\s*deploy\s*$/.test(l)),
      ).toBe(true);
      // 🔴 Равенством, а не набором `toContain`, — по той же причине, что у job `deploy`
      // десятью строками выше: дописанное `&& false` или `&& github.ref_type == 'branch'`
      // оставляет все подстроки на месте, и откат не срабатывает ни разу.
      //
      // Смысл частей. `needs.deploy.result == 'failure'` один слишком широк: он истинен и
      // при отказе checkout или настройки ssh, то есть до того, как выкат дошёл до сервера,
      // — поэтому рядом стоит отметка `server_stage_reached` (`LEGACY-227`). `!cancelled()`
      // отсеивает отменённые прогоны: отмена руками не повод переливать прод.
      //
      // 🔴 LEGACY-243. До 18.08.2026 в условии был ещё и
      // `github.event_name == 'workflow_dispatch'`. Оно писалось, когда основным путём был
      // push в `main`; после `LEGACY-241` автоматический путь остался один — тег `v*`, — и
      // откат ему не полагался вовсе. Снимать это было можно только вместе с ADR-018: откат
      // откатывает **образ**, а не схему, и полноценным становится лишь при обратно
      // совместимых миграциях; это держит сторож `check-migration-compat` в обоих путях.
      expect(jobCondition('rollback')).toBe(
        "${{ !cancelled() && needs.deploy.result == 'failure' && needs.deploy.outputs.server_stage_reached == 'true' }}",
      );
    });

    it('условия if: записаны одной строкой', () => {
      const folded: string[] = [];
      for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
        readFileSync(join(workflowsDir, file), 'utf8')
          .split(/\r?\n/)
          .forEach((line, index) => {
            if (/^\s*if:\s*[|>]/.test(line)) folded.push(`${file}:${index + 1}`);
          });
      }
      expect(folded).toEqual([]);
    });

    /**
     * Булевы входы `workflow_dispatch` — по объявлению в самом воркфлоу, а не по
     * списку в спеке: новый флаг попадает под правило сам.
     */
    const booleanInputs = (file: string): string[] => {
      const lines = readFileSync(join(workflowsDir, file), 'utf8').split(/\r?\n/);
      const names: string[] = [];
      let current: string | null = null;
      for (const line of lines) {
        const name = /^ {6}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (name) {
          current = name[1];
          continue;
        }
        if (current && /^\s*type:\s*boolean\s*$/.test(line)) names.push(current);
      }
      return names;
    };

    // В bash непустая строка `false` истинна ровно так же, как в выражениях GitHub,
    // поэтому правило шире, чем `if:`: `[[ -n "${{ ... }}" ]]` для булева входа —
    // тот же дефект. Так читается `skip_backup_emergency`, и без этой проверки
    // его форму не держит ничто.
    it('булевы входы workflow_dispatch читаются только через сравнение с true', () => {
      const offenders: string[] = [];
      for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
        const inputs = booleanInputs(file);
        if (inputs.length === 0) continue;
        readFileSync(join(workflowsDir, file), 'utf8')
          .split(/\r?\n/)
          .forEach((line, index) => {
            if (/^\s*#/.test(line)) return;
            for (const input of inputs) {
              const pattern = new RegExp(`github\\.event\\.inputs\\.${input}\\b`, 'g');
              let match: RegExpExecArray | null;
              while ((match = pattern.exec(line)) !== null) {
                // Объявление входа в блоке `inputs:` — не чтение.
                const tail = line.slice(match.index + match[0].length);
                if (!/^\s*\}*\s*"?\s*(==|!=)\s*['"]?true['"]?/.test(tail)) {
                  offenders.push(`${file}:${index + 1} ${input}`);
                }
              }
            }
          });
      }
      expect(offenders).toEqual([]);
    });

    it('каждое чтение github.event.inputs.* в if: сравнивается явно', () => {
      const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        const lines = readFileSync(join(workflowsDir, file), 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
          if (/^\s*#/.test(line)) return;
          if (!/(^|\s)if:/.test(line)) return;
          const pattern = /github\.event\.inputs\.[A-Za-z0-9_]+/g;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(line)) !== null) {
            const head = line.slice(0, match.index);
            const tail = line.slice(match.index + match[0].length);
            // Непустая строка `'false'` в выражениях GitHub истинна, поэтому
            // `!input` и `input` в `if:` истинны всегда, когда вход объявлен.
            // Годится любое явное сравнение (`== 'true'`, `== vars.X`) и передача
            // входа в функцию (`contains(inputs.version, 'x')`) — там строка
            // и разбирается как строка. Не годится голое использование как условия.
            const compared = /^\s*(==|!=)\s*\S/.test(tail);
            const argument =
              /\b(contains|startsWith|endsWith|format|join|fromJSON)\s*\([^)]*$/.test(head);
            if (!compared && !argument) {
              offenders.push(`${file}:${index + 1} ${match[0]}`);
            }
          }
        });
      }
      expect(offenders).toEqual([]);
    });
  });
});
