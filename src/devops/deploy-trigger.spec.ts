import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Сторож окна выката (`LEGACY-241`).
 *
 * Выкат — это `prisma migrate deploy` плюс пересоздание контейнера
 * (`scripts/deploy_production.sh`), то есть минуты, в которые админка и API не
 * отвечают. До 17.08.2026 `deploy.yml` срабатывал ещё и на `push: branches: [main]`,
 * поэтому окно открывалось на каждое слияние, в произвольный момент и молча —
 * в том числе посреди публикации контента. Решением владельца триггер оставлен
 * только на тег `v*` и ручной запуск, а границы окна объявляются в Telegram.
 *
 * Спека нужна потому, что `.github/workflows/**` и `scripts/*.sh` не разбирает ни
 * `tsc`, ни `eslint`, ни `jest`: возврат `branches: [main]`, пропавший шаг объявления
 * или закомментированный вызов отправителя не покраснеют нигде и обнаружатся тем, что
 * человек за админкой опять увидел отказ без предупреждения.
 *
 * 🔴 Закрепляется не «шаг с таким именем есть», а «шаг делает то, что обещает». Первая
 * версия этой спеки проверяла имена, порядок, `if:` и `env:` — и мутация, заменившая
 * тело шага на `echo`, проходила зелёной: окно переставало объявляться при девяти
 * зелёных тестах и шапке `deploy.yml`, объявляющей спеку сторожем. Поэтому ниже
 * проверяется тело `run:`, а тексты скриптов читаются **без комментариев**: литерал
 * `parse_mode=HTML` есть в шапке `notify_telegram.sh`, и сверка по сырому тексту
 * пропускала его пропажу из кода.
 *
 * YAML и shell разбираются вручную по той же причине, что и в `deploy-smoke.spec.ts`:
 * ни `yaml`, ни `js-yaml` не объявлены в `package.json`.
 */

const ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
const DEPLOY = readFileSync(join(WORKFLOWS_DIR, 'deploy.yml'), 'utf8');
const LINES = DEPLOY.split(/\r?\n/);

const NOTIFIER_PATH = 'scripts/notify_telegram.sh';
const NOTIFIER_RAW = readFileSync(join(ROOT, 'scripts', 'notify_telegram.sh'), 'utf8');
const CI_SH_RAW = readFileSync(join(ROOT, 'scripts', 'ci.sh'), 'utf8');

const isComment = (line: string): boolean => /^\s*#/.test(line);

/**
 * Текст без строк-комментариев. Применяется и к YAML, и к shell: в обоих
 * комментарий начинается с `#`, и в обоих он повторяет проверяемые литералы.
 */
const stripComments = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !isComment(line))
    .join('\n');

const NOTIFIER = stripComments(NOTIFIER_RAW);
const CI_SH = stripComments(CI_SH_RAW);
/**
 * `deploy.yml` без комментариев. Нужен там, где проверка идёт по вхождению подстроки:
 * шапка файла упоминает и `docker/build-push-action`, и `branches: [main]`, и сверка
 * по сырому тексту проходила бы на одном комментарии (найдено ревью 17.08.2026).
 */
const DEPLOY_CODE = stripComments(DEPLOY);
const CI_YML_RAW = readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf8');
const CI_YML = stripComments(CI_YML_RAW);
const CI_LINES = CI_YML_RAW.split(/\r?\n/);
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

/** Помощники бросают, а не зовут `expect`: падение на сборе набора скрыло бы имя кейса. */
const orFail = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message);
  return value;
};

/**
 * Тело блока верхнего уровня (`on:`, `jobs:`, `concurrency:`) — до следующей строки
 * нулевого отступа. Файл передаётся строками: те же блоки разбираются и в `ci.yml`
 * (`LEGACY-240`, `LEGACY-248`), а второй копии разбора здесь быть не должно.
 */
const topLevelBlockOf = (lines: string[], file: string, key: string): string[] => {
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start === -1) throw new Error(`в ${file} нет блока верхнего уровня \`${key}:\``);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => !isComment(line));
};

const topLevelBlock = (key: string): string[] => topLevelBlockOf(LINES, 'deploy.yml', key);

/** Тело job'а первого уровня вложенности, без комментариев. */
const jobBodyOf = (lines: string[], file: string, job: string): string[] => {
  const jobs = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobs === -1) throw new Error(`в ${file} нет блока \`jobs:\``);
  const start = lines.findIndex(
    (line, i) => i > jobs && new RegExp(`^ {2}${job}:\\s*$`).test(line),
  );
  if (start === -1) throw new Error(`в ${file} нет job'а \`${job}\``);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line) && !isComment(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => !isComment(line));
};

const jobBody = (job: string): string[] => jobBodyOf(LINES, 'deploy.yml', job);

/**
 * Значение ключа блока `concurrency:` как записано, без окружающих кавычек YAML.
 *
 * 🔴 Ровно одно вхождение, а не первое совпадение: две строки `cancel-in-progress:`
 * подряд — `false`, затем `true` — прошли бы `find` зелёными, а какая из них доедет до
 * боевого прогона, зависит от снисходительности парсера GitHub.
 *
 * Помощник общий на оба файла: требования к `deploy.yml` (`LEGACY-245`) и к `ci.yml`
 * (`LEGACY-240`) противоположны по смыслу, но разбираются одинаково, и второй копии
 * разбора здесь быть не должно — правка формата иначе нужна в двух местах.
 */
const concurrencyValue = (lines: string[], file: string, key: string): string => {
  const found = topLevelBlockOf(lines, file, 'concurrency').filter((line) =>
    new RegExp(`^ {2}${key}:`).test(line),
  );
  expect([file, key, found.length]).toEqual([file, key, 1]);
  return found[0]
    .replace(new RegExp(`^ {2}${key}:\\s*`), '')
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .trim();
};

interface Step {
  name: string;
  lines: string[];
}

/** Шаги job'а по порядку. Имя берётся точным, а не по вхождению подстроки. */
const steps = (body: string[]): Step[] => {
  const out: Step[] = [];
  let current: Step | null = null;
  for (const line of body) {
    const named = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (named) {
      current = { name: named[1], lines: [line] };
      out.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return out;
};

const step = (job: string, name: string): Step =>
  orFail(
    steps(jobBody(job)).find((s) => s.name === name),
    `в job \`${job}\` нет шага \`${name}\``,
  );

const indexOfStep = (job: string, name: string): number => {
  const at = steps(jobBody(job)).findIndex((s) => s.name === name);
  if (at === -1) throw new Error(`в job \`${job}\` нет шага \`${name}\``);
  return at;
};

/**
 * Тело `run:` шага, уже без shell-комментариев (их снял `jobBody`). Именно поэтому
 * закомментированный вызов отправителя проверку не проходит.
 */
const runBody = (s: Step): string => {
  const at = s.lines.findIndex((line) => /^ {8}run:\s*\|?\s*$/.test(line));
  if (at === -1) return '';
  return s.lines.slice(at + 1).join('\n');
};

/** Условие `if:` шага, как записано; пустая строка, если условия нет. */
const stepCondition = (s: Step): string => {
  const line = s.lines.find((l) => /^ {8}if:/.test(l));
  return line === undefined ? '' : line.replace(/^\s*if:\s*/, '');
};

const OPENED = '📢 Deploy Window Opened';
const CLOSED = '📢 Deploy Window Closed';
const FAILED = '🚨 Notify Failure';
const CANCELLED = '🚨 Notify Cancelled';

/** Все шаги, которые обязаны говорить в канал, и job, где каждый живёт. */
const TELEGRAM_STEPS: Array<[string, string]> = [
  ['deploy', OPENED],
  ['deploy', CLOSED],
  ['notify', FAILED],
  ['notify', CANCELLED],
];

describe('LEGACY-241: окно выката объявляется, закрывается и не открывается само', () => {
  describe('триггер', () => {
    // Равенством по ключам, а не `toContain`: `branches-ignore` или `branches: ['**']`
    // вернули бы автоматический выкат, оставив слово `tags` на месте.
    it('выкат идёт только по тегу v* — push в main прод не катит', () => {
      const on = topLevelBlock('on');
      const start = on.findIndex((line) => /^ {2}push:\s*$/.test(line));
      expect(start).toBeGreaterThan(-1);
      // Граница блока — следующий ключ того же уровня (`workflow_dispatch:`),
      // иначе в выборку попадают его `inputs:`, и проверка проходит впустую.
      const rest = on.slice(start + 1);
      const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
      const push = end === -1 ? rest : rest.slice(0, end);

      const keys = push.filter((line) => /^ {4}[A-Za-z-]+:/.test(line)).map((line) => line.trim());
      expect(keys).toEqual(['tags:']);
      expect(push.some((line) => /^ {6}- 'v\*'/.test(line))).toBe(true);
    });

    // Ручной запуск остаётся — это и есть аварийный путь взамен снятого push.
    it('ручной запуск сохранён', () => {
      expect(topLevelBlock('on').some((line) => /^ {2}workflow_dispatch:/.test(line))).toBe(true);
    });
  });

  // 🔴 Со снятием триггера с пути слияния ушла не только выкатка, но и job `build`:
  // сборка образа жила только в `deploy.yml`. Без встречного job'а `image` в `ci.yml`
  // поломка `Dockerfile` впервые краснела бы на теге — в момент релиза.
  describe('сборка образа осталась на пути слияния', () => {
    // Сборка живёт в `ci.yml` отдельным job'ом, а не шагом `scripts/ci.sh`: скрипт зовут
    // ещё и локально перед сдачей, а холодный `docker build` тянет полный `yarn install`
    // из сети. В job'е доступен кэш слоёв `type=gha`, которого у голого `docker build` нет.
    it('ci.yml собирает образ на пути слияния', () => {
      expect(CI_YML).toContain('docker/build-push-action');
      expect(CI_YML).toMatch(/^\s*target:\s*runner\s*$/m);
      expect(CI_YML).toMatch(/^\s*push:\s*false\s*$/m);
    });

    // 🔴 Публикация из обычного прогона CI запрещена в любой форме: `--push`,
    // `docker push`, `--output type=registry`. Сверка по одной подстроке
    // `docker build --push` держалась на соседстве слов и обходилась перестановкой.
    it('путь слияния ничего не публикует в реестр', () => {
      for (const [name, text] of [
        ['scripts/ci.sh', CI_SH],
        ['ci.yml', CI_YML],
      ] as Array<[string, string]>) {
        expect([name, /--push\b/.test(text)]).toEqual([name, false]);
        expect([name, /\bdocker push\b/.test(text)]).toEqual([name, false]);
        expect([name, /type=registry/.test(text)]).toEqual([name, false]);
      }
      expect(CI_YML).not.toMatch(/^\s*push:\s*true\s*$/m);
    });

    it('deploy.yml по-прежнему собирает и публикует образ сам', () => {
      expect(DEPLOY_CODE).toContain('docker/build-push-action');
    });

    // `--target runner` в `ci.sh` и `build-push-action` без `target:` собирают одно и то
    // же ровно до тех пор, пока `runner` — конечная стадия. Новая стадия в конце
    // `Dockerfile` развела бы два пути молча: на слиянии проверялась бы промежуточная.
    it('runner — конечная стадия Dockerfile', () => {
      const stages = [...DOCKERFILE.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]);
      expect(stages.length).toBeGreaterThan(0);
      expect(stages[stages.length - 1]).toBe('runner');
    });
  });

  describe('границы окна обслуживания', () => {
    it('скрипт оповещения попадает в разреженный чекаут обоих job’ов', () => {
      // Без этой строки шаги ниже молча ничего не объявляют (в `deploy`) либо
      // роняют job (в `notify`), а канал остаётся пустым.
      for (const job of ['deploy', 'notify']) {
        expect([job, jobBody(job).some((line) => line.trim() === NOTIFIER_PATH)]).toEqual([
          job,
          true,
        ]);
      }
    });

    // Порядком, а не только наличием: объявление после `ssh` бесполезно — окно
    // к тому моменту уже открыто.
    it('начало объявляется до захода на сервер', () => {
      const announce = indexOfStep('deploy', OPENED);
      expect(indexOfStep('deploy', '📍 Mark server stage reached')).toBeGreaterThan(announce);
      expect(indexOfStep('deploy', '🚀 Deploy to Server')).toBeGreaterThan(announce);
    });

    it('окончание объявляется после дыма', () => {
      expect(indexOfStep('deploy', CLOSED)).toBeGreaterThan(
        indexOfStep('deploy', '📊 Verify Deployment'),
      );
    });

    // ⚠️ `success()` — условие шага по умолчанию, и само по себе оно ничего не меняет.
    // Закрепляется здесь не оно, а то, что условие **не** стало `always()`,
    // `!cancelled()` или `failure()`: «выкат завершён» после отказа — худший вид
    // молчания, чем отсутствие сообщения.
    it('окончание не объявляется на отказе', () => {
      expect(stepCondition(step('deploy', CLOSED))).toBe('${{ success() }}');
    });

    // Шаг, дописанный после объявления о завершении, снова растянул бы окно за
    // границу сообщения: «доступны» ушло бы в канал раньше, чем job закончил работу.
    it('окончание — последний шаг job’а deploy', () => {
      const all = steps(jobBody('deploy'));
      expect(all[all.length - 1].name).toBe(CLOSED);
    });

    // 🔴 Отмена прогона — третий исход, и без неё окно открывается и не закрывается
    // никогда: `CLOSED` отсеян `success()`, `FAILED` — своим `!cancelled()`.
    it('отмена прогона закрывает окно', () => {
      expect(stepCondition(step('notify', CANCELLED))).toBe('${{ cancelled() }}');
      expect(stepCondition(step('notify', FAILED))).toContain('!cancelled()');
    });

    // 🔴 Условие шага по умолчанию — `success()`, а он ложен и на отмене тоже. Чекаут без
    // `always()` пропускался бы ровно в том прогоне, где нужен `🚨 Notify Cancelled`, и
    // окно оставалось бы открытым навсегда при зелёном job'е.
    it('чекаут отправителя переживает отмену прогона', () => {
      expect(stepCondition(step('notify', '📥 Checkout Notifier'))).toBe('${{ always() }}');
    });

    // Скрипт — утилита, а не часть релиза: пришпиленный к выкатываемому тегу, он пропал бы
    // при повторном запуске прогона по старому тегу, и отказ выката не сообщился бы никуда.
    it('чекаут отправителя берёт ветку по умолчанию, а не выкатываемый ref', () => {
      expect(step('notify', '📥 Checkout Notifier').lines.join('\n')).toContain(
        'ref: ${{ github.event.repository.default_branch }}',
      );
    });

    // 🔴 Пропавший отправитель обязан краснеть, а не выходить нулём. Проверка `-f` с
    // `exit 0` в любом из четырёх шагов означает, что оповещение отключается правкой
    // одной строки `sparse-checkout`, а прогон остаётся зелёным.
    it.each(TELEGRAM_STEPS)('%s → %s не глушит пропажу отправителя', (job, name) => {
      expect(runBody(step(job, name))).not.toMatch(/!\s*-f\s+scripts\/notify_telegram\.sh/);
    });
  });

  // 🔴 Главная проверка файла: шаг обязан **звать** отправителя, а не просто
  // называться. Тело `run:` читается без комментариев, поэтому закомментированный
  // вызов равнозначен удалённому.
  describe('шаги действительно говорят в канал', () => {
    it.each(TELEGRAM_STEPS)('%s → %s зовёт notify_telegram.sh', (job, name) => {
      expect(runBody(step(job, name))).toContain(`bash ${NOTIFIER_PATH}`);
    });

    // Единственный отправитель — скрипт. Прямой `curl` в воркфлоу означает вторую
    // копию хардненинга, которая разъедется с первой незаметно.
    it('прямых обращений к Telegram в .github/workflows/** нет', () => {
      const offenders: string[] = [];
      for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
        readFileSync(join(WORKFLOWS_DIR, file), 'utf8')
          .split(/\r?\n/)
          .forEach((line, index) => {
            if (!isComment(line) && line.includes('api.telegram.org')) {
              offenders.push(`${file}:${index + 1}`);
            }
          });
      }
      expect(offenders).toEqual([]);
      expect(NOTIFIER).toContain('api.telegram.org');
    });
  });

  describe('хардненинг отправителя', () => {
    // Telegram отвечает на отозванный токен 401, на выкинутого бота 403, на битый
    // chat_id 400 — и всё это с кодом возврата curl 0. Без разбора кода ответа шаг
    // зелёный, в логе пусто, до человека не дошло ничего (LEGACY-221).
    it('код ответа разбирается', () => {
      expect(NOTIFIER).toContain("-w '%{http_code}'");
      expect(NOTIFIER).toMatch(/!=\s*"200"/);
    });

    // Версия приходит из входа `workflow_dispatch` и может содержать `&`, `<`, `>`
    // (ветка `feature/a<b>`). При `parse_mode=HTML` Telegram на таком отвечает 400 —
    // сообщение не доходит именно тогда, когда оно нужно.
    it('текст экранируется и режим разбора передаётся', () => {
      expect(NOTIFIER).toContain('s/&/\\&amp;/g');
      expect(NOTIFIER).toContain('parse_mode=HTML');
    });

    // Отказ доставки не должен красить выкат: прод от молчания канала не сломан.
    it('скрипт не валит вызвавший его шаг', () => {
      expect(NOTIFIER).toMatch(/exit 0/);
      expect(NOTIFIER).toContain('set +e');
    });
  });

  describe('секреты не утекают в лог', () => {
    // 🔴 GitHub маскирует в логах только точные совпадения со значением секрета.
    // `set -x` печатает всю командную строку curl вместе с токеном в URL, `echo` —
    // напрямую. Проверяются оба места сразу: и скрипт, и тела шагов.
    const sources = (): Array<[string, string]> => [
      [NOTIFIER_PATH, NOTIFIER],
      ...TELEGRAM_STEPS.map(
        ([job, name]) => [`${job} → ${name}`, runBody(step(job, name))] as [string, string],
      ),
    ];

    it('ни set -x, ни печати токена', () => {
      for (const [name, text] of sources()) {
        expect([name, /^\s*set -x\b/m.test(text)]).toEqual([name, false]);
        expect([name, /echo[^\n]*TG_TOKEN/.test(text)]).toEqual([name, false]);
      }
    });

    it('секреты приходят через env шага', () => {
      for (const [job, name] of TELEGRAM_STEPS) {
        const text = step(job, name).lines.join('\n');
        const label = `${job} → ${name}`;
        expect([label, text.includes('TG_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}')]).toEqual([
          label,
          true,
        ]);
        expect([label, text.includes('TG_CHAT: ${{ secrets.TELEGRAM_CHAT_ID }}')]).toEqual([
          label,
          true,
        ]);
      }
    });

    // 🔴 Подстановка `${{ }}` происходит до shell. Версия — это либо имя тега, либо
    // свободный ввод `workflow_dispatch`: значение вида `x" "$(...)` исполнилось бы
    // прямо в шаге, где в окружении лежит токен бота. Значения приходят через `env`.
    it('в тело run: этих шагов не подставляются выражения', () => {
      for (const [job, name] of TELEGRAM_STEPS) {
        const label = `${job} → ${name}`;
        expect([label, runBody(step(job, name)).includes('${{')]).toEqual([label, false]);
      }
    });
  });

  // 🔴 Выкат по тегу и `git reset --hard origin/main` на сервере несовместимы: образ
  // собирается из `github.sha`, а рабочее дерево уезжало бы на вершину `main`.
  describe('сервер переводится на выкаченную ревизию', () => {
    it('чекаут по github.sha, а не по origin/main', () => {
      const body = runBody(step('deploy', '🚀 Deploy to Server'));
      expect(body).toContain('git checkout --detach --force ${{ github.sha }}');
      expect(body).not.toContain('reset --hard origin/main');
    });

    // Промах ревизии обязан краснеть до `prisma migrate deploy`, а не проявляться
    // контейнером, который не поднялся.
    it('совпадение HEAD с github.sha сверяется явно', () => {
      const body = runBody(step('deploy', '🚀 Deploy to Server'));
      expect(body).toContain('git rev-parse HEAD');
      expect(body).toMatch(/!=\s*"\$\{\{ github\.sha \}\}"/);
    });

    // 🔴 Вся привязка лежит внутри `if [[ -d ".git" ]]`. Без ветки `else` отсутствие
    // рабочего дерева (пересозданный сервер, ручное вмешательство) отменяло бы гарантию
    // беззвучно: образ поехал бы поверх `docker-compose.prod.yml` и `configs/**`, которые
    // лежат на диске с прошлого раза, и `📊 Verify Deployment` этого не увидит — он
    // сверяет версию API, а не compose.
    it('отсутствие рабочего дерева на сервере краснеет, а не пропускается', () => {
      const body = runBody(step('deploy', '🚀 Deploy to Server'));
      const guard = body.indexOf('if [[ -d ".git" ]]');
      expect(guard).toBeGreaterThan(-1);
      const tail = body.slice(guard);
      const elseAt = tail.indexOf('else');
      expect(elseAt).toBeGreaterThan(-1);
      // `exit 1` обязан стоять до закрытия того же `if`, а не где-то дальше по телу.
      const branch = tail.slice(elseAt, tail.indexOf('fi', elseAt));
      expect(branch).toContain('exit 1');
    });
  });

  // `scripts/*.sh` не читает ни eslint, ни tsc, ни jest. Проверка заведена на обоих
  // путях: `ci.yml` не запускается по тегу, `deploy.yml` — на pull request.
  describe('синтаксис shell-скриптов проверяется на обоих путях', () => {
    // 🔴 Регулярка привязана к началу строки, а не `toContain('bash -n')`: у шага есть
    // подпись `step "Shell script syntax (bash -n)"`, и сверка по вхождению подстроки
    // проходила бы на одной подписи — снятие самой команды уходило зелёным (проверено
    // мутацией 17.08.2026).
    const CALLS_BASH_N = /^\s*bash -n\s/m;

    it('scripts/ci.sh зовёт bash -n', () => {
      expect(CALLS_BASH_N.test(CI_SH)).toBe(true);
    });

    it('job test в deploy.yml зовёт bash -n', () => {
      expect(CALLS_BASH_N.test(runBody(step('test', '🐚 Shell Script Syntax')))).toBe(true);
    });
  });
});
/**
 * Сторож очереди выката (`LEGACY-245`).
 *
 * После `LEGACY-241` тег `v*` — единственный автоматический путь на прод, а теги
 * ставят пачками, когда чинят неудачный релиз. Без `concurrency` два тега подряд
 * дают два одновременных прогона: два `prisma migrate deploy` против одной базы
 * и два пересоздания контейнера на одном сервере.
 *
 * Проверяется только `deploy.yml`. Кейс, написанный по всем файлам
 * `.github/workflows/**`, был бы неверен: `concurrency` для `ci.yml` — это
 * `LEGACY-240`, отдельная запись, и требования там **противоположны** —
 * группа обязана содержать `github.ref` и суффикс, уникальный на прогон для всего,
 * кроме `pull_request`, а отмена включена именно для него.
 */
describe('LEGACY-245: выкат встаёт в очередь, а не идёт вторым прогоном рядом', () => {
  // 🔴 Чёрного списка контекстов здесь быть не может: `github.run_number`,
  // `github.run_attempt`, `github.workflow_sha`, `inputs.*` и любой следующий пройдут
  // мимо любого перечисления, а каждый из них уникален на прогон — то есть `concurrency`
  // выключается целиком при зелёной спеке. Поэтому запрещены **все** подстановки, кроме
  // постоянных на все прогоны воркфлоу.
  const CONSTANT_CONTEXTS = ['github.workflow', 'github.repository'];

  const value = (key: string): string => concurrencyValue(LINES, 'deploy.yml', key);

  // 🔴 Отменённый посреди `prisma migrate deploy` выкат оставляет частично применённую
  // пачку миграций (`LEGACY-242`) — это хуже очереди. Значение сверяется точным
  // равенством: `cancel-in-progress: ${{ ... }}` тоже прошёл бы проверку на наличие.
  it('cancel-in-progress равен ровно false', () => {
    expect(value('cancel-in-progress')).toBe('false');
  });

  it('группа не разъезжается по прогонам', () => {
    const group = value('group');
    expect(group).not.toBe('');
    const rest = CONSTANT_CONTEXTS.reduce(
      (acc, ctx) =>
        acc.replace(new RegExp(`\\$\\{\\{\\s*${ctx.replace(/\./g, '\\.')}\\s*\\}\\}`, 'g'), ''),
      group,
    );
    // Сообщение печатает саму группу: иначе по `false !== true` не понять, что не так.
    expect([group, rest.includes('${{')]).toEqual([group, false]);
  });
});

/**
 * Сторож heredoc'ов выката (`LEGACY-246`).
 *
 * `ssh ... << EOF` **без кавычек** вокруг делимитера разворачивает тело shell'ом
 * раннера ещё до отправки: сервером считается только то, что вручную экранировано
 * через `\$`. На этом и потерялся `--no-backup` — переменная задавалась внутри
 * heredoc, то есть на сервере, а раскрывалась на раннере, где её нет.
 *
 * 🔴 Закрепляется не «экранирование расставлено правильно», а **закавыченный
 * делимитер**: это не одна из двух равноправных форм, а единственная, при которой
 * правило не надо помнить для каждого нового `$`. Заодно закрытым оказывается
 * `${{ secrets.ENV_PROD }}`: до кавычек **значение секрета** проходило через shell
 * раннера, и секрет вида `JWT_SECRET=a$bc` уезжал на прод обрезанным до `a`.
 *
 * Проверяются все heredoc'ы `ssh` в файле, а не только шаг выката: у job'а `rollback`
 * heredoc того же класса, и терять кавычки ему нельзя ровно так же.
 */
describe('LEGACY-246: тело heredoc уезжает на сервер как есть', () => {
  /**
   * Переменные, которые на сервере задаёт не сам heredoc, а окружение сессии `ssh`.
   * Список короткий намеренно: новая строка сюда должна стоить отдельного решения.
   */
  const SERVER_ENV = ['HOME', 'PATH', 'USER', 'SHELL', 'PWD'];

  /** Job'ы, в шагах которых бывает `ssh` с heredoc. */
  const SSH_JOBS = ['deploy', 'rollback'];

  interface Heredoc {
    /** Шаг, в котором открыт heredoc, — им подписаны находки. */
    step: string;
    delimiter: string;
    quoted: boolean;
    /** Строки шага до открывающей строки — здесь живут переменные раннера. */
    before: string[];
    /** Тело heredoc, вместе с комментариями: раннер разворачивает и их тоже. */
    body: string[];
  }

  /**
   * Строки job'а **с комментариями**. `jobBody` их вырезает, и сторож поверх него был бы
   * слеп к `$(...)` и обратным апострофам внутри shell-комментария heredoc'а — а
   * незакавыченное тело раскрывает их наравне с кодом.
   */
  const rawJobBody = (job: string): string[] => {
    const jobs = LINES.findIndex((line) => /^jobs:\s*$/.test(line));
    if (jobs === -1) throw new Error('в deploy.yml нет блока `jobs:`');
    const start = LINES.findIndex(
      (line, i) => i > jobs && new RegExp(`^ {2}${job}:\\s*$`).test(line),
    );
    if (start === -1) throw new Error(`в deploy.yml нет job'а \`${job}\``);
    const rest = LINES.slice(start + 1);
    const end = rest.findIndex((line) => /^ {0,2}\S/.test(line) && !isComment(line));
    return end === -1 ? rest : rest.slice(0, end);
  };

  /** Все heredoc'ы, открытые вызовом `ssh`, по всем job'ам файла. */
  const sshHeredocs = (): Heredoc[] => {
    const out: Heredoc[] = [];
    for (const job of SSH_JOBS) {
      for (const s of steps(rawJobBody(job))) {
        const at = s.lines.findIndex((line) => !isComment(line) && /\bssh\b.*<<-?\s*\S/.test(line));
        if (at === -1) continue;
        const opener = orFail(
          /<<-?\s*(['"]?)([A-Za-z_]\w*)\1\s*$/.exec(s.lines[at]) ?? undefined,
          `в шаге \`${s.name}\` не разобрана открывающая строка heredoc: ${s.lines[at].trim()}`,
        );
        const delimiter = opener[2];
        const rest = s.lines.slice(at + 1);
        const close = rest.findIndex((line) => line.trim() === delimiter);
        if (close === -1)
          throw new Error(`в шаге \`${s.name}\` не закрыт heredoc \`${delimiter}\``);
        out.push({
          step: s.name,
          delimiter,
          quoted: opener[1] !== '',
          before: s.lines.slice(0, at),
          body: rest.slice(0, close),
        });
      }
    }
    if (out.length === 0) throw new Error('в deploy.yml не нашлось ни одного heredoc `ssh`');
    return out;
  };

  /** Тело без подстановок GitHub: их делает Actions над текстом, до всякого shell. */
  const withoutActions = (h: Heredoc): string =>
    h.body.join('\n').replace(/\$\{\{[\s\S]*?\}\}/g, '');

  /** Имена, присвоенные в тексте: `NAME=`, `export NAME=`. */
  const assignedIn = (text: string): Set<string> =>
    new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=/gm)].map((m) => m[1]));

  it('делимитер каждого heredoc ssh закавычен', () => {
    const unquoted = sshHeredocs()
      .filter((h) => !h.quoted)
      .map((h) => `${h.step}: << ${h.delimiter}`);
    expect(unquoted).toEqual([]);
  });

  // 🔴 Обратная сторона кавычек: переменную раннера внутрь такого heredoc уже не передать.
  // Ссылка на неё уедет на сервер как есть, а там её нет — под `set -u` это отказ, без
  // него пустая строка. Поэтому каждое имя, использованное в теле, обязано быть присвоено
  // **в этом же теле**.
  it('в закавыченном теле нет ссылок на переменные, заданные вне его', () => {
    const offenders: string[] = [];
    for (const h of sshHeredocs().filter((x) => x.quoted)) {
      const text = withoutActions(h);
      const assigned = assignedIn(text);
      // `${ИМЯ}`, `${ИМЯ:-…}`, `${#ИМЯ}` и голое `$ИМЯ` — имя берётся первым словом.
      for (const m of text.matchAll(/\$\{[#!]?([A-Za-z_]\w*)[^}]*\}|\$([A-Za-z_]\w*)/g)) {
        const name = m[1] ?? m[2];
        if (assigned.has(name) || SERVER_ENV.includes(name)) continue;
        offenders.push(`${h.step}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Экранирование `\$` в закавыченном heredoc не безобидно: на сервер приедет литерал
  // `\$ИМЯ`, а не значение. Это прямой след прошлой формы, и он обязан краснеть.
  it('в закавыченном теле нет экранирования \\$ — оно уехало бы на сервер литералом', () => {
    const offenders: string[] = [];
    for (const h of sshHeredocs().filter((x) => x.quoted)) {
      for (const m of withoutActions(h).matchAll(/\\+\$/g)) offenders.push(`${h.step}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  // 🔴 Вторая линия обороны на случай, если делимитер всё-таки потеряет кавычки: тогда
  // возвращается прежнее правило — всё серверное экранировано. Кейс выше краснеет первым,
  // этот не даёт незакавыченному heredoc'у уехать ещё и с потерянными подстановками.
  it('в незакавыченном теле всё серверное экранировано', () => {
    const offenders: string[] = [];
    for (const h of sshHeredocs().filter((x) => !x.quoted)) {
      const text = withoutActions(h);
      const runnerVars = assignedIn(h.before.join('\n'));
      // Экранирован тот `$`, перед которым нечётное число обратных слэшей: `\\$` — это
      // экранированный слэш плюс живая подстановка.
      for (const m of text.matchAll(/(\\*)([$`])/g)) {
        if (m[1].length % 2 === 1) continue;
        const tail = text.slice((m.index ?? 0) + m[0].length);
        const name = /^\{?([A-Za-z_]\w*)/.exec(tail)?.[1];
        if (m[2] === '$' && name !== undefined && runnerVars.has(name)) continue;
        offenders.push(`${h.step}: ${m[2]}${tail.slice(0, 12)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 🔴 Проверяются именно аргументы вызова, а не вхождение в тело: перенос `$BACKUP_FLAG`
  // в соседний `echo` с удалением из строки вызова оставил бы кейс, написанный по всему
  // heredoc, зелёным — а галка `skip_backup_emergency` снова не делала бы ничего. Это и
  // есть симптом `LEGACY-246`.
  it('флаг пропуска бэкапа собирается и стоит в аргументах deploy_production.sh', () => {
    const deploy = orFail(
      sshHeredocs().find((h) => h.step === '🚀 Deploy to Server'),
      'в job `deploy` нет шага `🚀 Deploy to Server` с heredoc `ssh`',
    );
    const body = deploy.body.join('\n');
    expect(body).toContain('BACKUP_FLAG="--no-backup"');

    // Вызов — открывающая строка плюс все продолжения через `\`.
    const at = deploy.body.findIndex((line) => /\.\/scripts\/deploy_production\.sh\b/.test(line));
    expect(at).toBeGreaterThan(-1);
    const args: string[] = [];
    for (let i = at; i < deploy.body.length; i += 1) {
      args.push(deploy.body[i]);
      if (!/\\\s*$/.test(deploy.body[i])) break;
    }
    expect(args.join('\n')).toMatch(/(^|\s)\$BACKUP_FLAG(\s|$)/m);
  });
});

/**
 * Сторож обратной совместимости миграций (`LEGACY-242`, ADR-018).
 *
 * Релиз несёт всё, что слито с прошлого тега (`LEGACY-241`), а `prisma migrate deploy`
 * применяет каталоги по одному и **не** оборачивает пачку в транзакцию. Отказ на пятой
 * миграции из семи оставляет четыре применёнными. Пережить это можно ровно пока предыдущий
 * образ работает на новой схеме — то есть пока в миграции нет разрушающей конструкции.
 * Откат здесь откатывает **образ**, а не схему, поэтому проверка и делает откат осмысленным.
 *
 * Проверка заводится в **оба** пути: `ci.yml` не запускается по тегу `v*`, `deploy.yml` —
 * на pull request. Шаг, заведённый только в одном, на втором отсутствует молча
 * (`LEGACY-207`, `LEGACY-209`).
 */
describe('LEGACY-242: разрушающая миграция краснеет на обоих путях', () => {
  const SELF_TEST = 'yarn check-migration-compat:self-test';
  const RUN = 'yarn check-migration-compat';

  // 🔴 Блок сверяется целиком и по отступу, а не вхождением подстроки. Мутации, которые
  // проходили при сверке по вхождению: `… .mjs --self-test` вторым вызовом (шаг зелёный
  // всегда), `… || true`, и обёртка блока в `if [[ … ]]; then … fi` — последняя не меняет
  // ни одной строки, только отступ, и сторож переставал вызываться вовсе.
  it('scripts/ci.sh зовёт сторож сразу после своей шапки, без обёрток', () => {
    const lines = CI_SH_RAW.split(/\r?\n/);
    const at = lines.findIndex((l) => l === 'step "Migration backwards-compatibility check"');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual([SELF_TEST, RUN]);

    // 🔴 И на верхнем уровне скрипта. Обёртка `if [[ "${RUN_COMPAT:-0}" == "1" ]]; then … fi`
    // не меняет ни одной строки блока — только его окружение, — и сторож переставал
    // вызываться вовсе при зелёной сверке содержимого.
    let depth = 0;
    for (const line of lines.slice(0, at)) {
      if (/^\s*(?:if|for|while|until|case)\b/.test(line) && !/^\s*#/.test(line)) depth += 1;
      if (/^\s*(?:fi|done|esac)\b/.test(line)) depth -= 1;
    }
    expect([`вложенность блока перед шагом`, depth]).toEqual([`вложенность блока перед шагом`, 0]);
  });

  // 🔴 Шаг сверяется равенством строк. Набор `toContain` пропускал и `if:` на шаге (булев
  // вход `workflow_dispatch` на теге ложен всегда — шаг молча пропускается на каждом
  // выкате, ровно `LEGACY-222`), и `continue-on-error: true`. Соседняя спека
  // `ci-e2e-wiring.spec.ts` закрепляет то же самое и тем же способом.
  it('job test в deploy.yml зовёт сторож без if: и continue-on-error', () => {
    const lines = step('test', '🧬 Migration Backwards-Compatibility Check')
      .lines.map((l) => l.trim())
      .filter(Boolean);
    expect(lines).toEqual([
      '- name: 🧬 Migration Backwards-Compatibility Check',
      'run: |',
      SELF_TEST,
      RUN,
    ]);
  });

  it('сторож и его самопроверка объявлены в package.json ровно так, как вызываются', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check-migration-compat']).toBe('node scripts/check-migration-compat.mjs');
    expect(pkg.scripts['check-migration-compat:self-test']).toBe(
      'node scripts/check-migration-compat.mjs --self-test',
    );
  });

  // Список исключений — не свалка. Форма записи закрепляется здесь, а содержательные
  // проверки (запись про несуществующую миграцию, про миграцию без разрушающих конструкций,
  // про конструкцию, которой в файле нет) живут в self-test самого сторожа.
  it('у каждого исключения есть причина и перечень конструкций', () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, 'scripts', 'migration-compat-allowlist.json'), 'utf8'),
    ) as { allowed: Record<string, { reason?: string; constructs?: string[] }> };
    const entries = Object.entries(raw.allowed);
    expect(entries.length).toBeGreaterThan(0);
    const broken = entries
      .filter(
        ([, e]) =>
          typeof e.reason !== 'string' ||
          e.reason.trim().length < 10 ||
          !Array.isArray(e.constructs) ||
          e.constructs.length === 0,
      )
      .map(([name]) => name);
    expect(broken).toEqual([]);
  });
});

/**
 * Сторож самого отката (`LEGACY-243`).
 *
 * Job `rollback` покрыл теговый выкат, и тело шага перестало быть безразличным: до
 * 18.08.2026 оно заходило в `/opt/books/app`, где скрипта нет, и печатало
 * «Rollback script not found!». Job срабатывает так редко, что мёртвую строку никто не
 * наблюдал месяцами — поэтому её и закрепляем.
 */
describe('LEGACY-243: откат заходит туда, где лежит скрипт, и зовёт его', () => {
  const rollbackStep = (): string => runBody(step('rollback', '⏪ Rollback Deployment'));

  it('откат работает в каталоге рабочего дерева', () => {
    const body = rollbackStep();
    expect(body).toMatch(/^\s*cd \/opt\/books\/app\/src\s*$/m);
    expect(body).not.toMatch(/^\s*cd \/opt\/books\/app\s*$/m);
  });

  it('откат зовёт deploy_production.sh, а не печатает сообщение', () => {
    expect(rollbackStep()).toMatch(/\.\/scripts\/deploy_production\.sh --rollback --force/);
  });

  // 🔴 `save_current_state` берёт ревизию из `DEPLOY_PREVIOUS_SHA`, и снять её обязан шаг
  // выката — до `git checkout --detach --force`. Иначе скрипт считает `git rev-parse HEAD`
  // уже после чекаута, пишет в `.rollback_info` выкатываемую ревизию, и откат откатывается
  // на неё же. Порядок проверяется по позициям в теле, а не наличием строк.
  it('предыдущая ревизия снимается до чекаута и уезжает в скрипт', () => {
    const body = runBody(step('deploy', '🚀 Deploy to Server'));
    const captured = body.indexOf('DEPLOY_PREVIOUS_SHA=$(git rev-parse HEAD');
    const exported = body.indexOf('export DEPLOY_PREVIOUS_SHA');
    const checkout = body.indexOf('git checkout --detach --force');
    expect(captured).toBeGreaterThan(-1);
    expect(exported).toBeGreaterThan(captured);
    expect(checkout).toBeGreaterThan(exported);
  });
});

/**
 * Сторож наблюдения за очередью выката (`LEGACY-249`).
 *
 * `concurrency` держит на группу один выполняющийся прогон и один ожидающий; третий,
 * встав в очередь, отменяет ожидавшего. Такой прогон не запускает ни одного job'а, поэтому
 * изнутри `deploy.yml` он не наблюдаем вовсе: `if: cancelled()` вычисляется только внутри
 * запущенного job'а. Смотреть на это может лишь отдельный воркфлоу на `workflow_run`.
 */
describe('LEGACY-249: снятый из очереди прогон не исчезает молча', () => {
  const WATCHDOG = 'deploy-queue-watchdog.yml';
  const RAW = readFileSync(join(WORKFLOWS_DIR, WATCHDOG), 'utf8');
  const CODE = stripComments(RAW);
  const line = (re: RegExp): string =>
    orFail(
      CODE.split(/\r?\n/).find((l) => re.test(l)),
      `в ${WATCHDOG} нет строки ${String(re)}`,
    ).trim();

  it('сторож смотрит на завершение выката снаружи', () => {
    expect(CODE).toMatch(/^on:\s*$/m);
    expect(CODE).toMatch(/^\s*workflow_run:\s*$/m);
    expect(line(/^\s*workflows:/)).toBe("workflows: ['📦 Production Deployment']");
    expect(line(/^\s*types:/)).toBe('types: [completed]');
    // Имя обязано совпадать с именем самого выката, иначе `workflow_run` не сработает
    // ни разу и сторож будет зелёным ровно потому, что мёртв.
    expect(LINES[0]).toBe('name: 📦 Production Deployment');
  });

  // Равенством, а не вхождением: `… == 'cancelled' || … == 'failure'` оставило бы подстроку
  // на месте и задублировало `🚨 Notify Failure` на каждом упавшем выкате.
  it('сторож реагирует ровно на отменённые прогоны', () => {
    expect(line(/^\s*if:.*conclusion/)).toBe(
      "if: ${{ github.event.workflow_run.conclusion == 'cancelled' }}",
    );
  });

  // 🔴 Запрашивать надо job'ы **наблюдаемого** прогона. `RUN_ID: ${{ github.run_id }}` —
  // свой собственный — оставляет и `/jobs`, и разбор ответа на месте, но условие отправки
  // не выполняется никогда: сторож зелёный ровно потому, что мёртв.
  it('сторож спрашивает про наблюдаемый прогон, а не про свой', () => {
    expect(line(/^\s*RUN_ID:/)).toBe('RUN_ID: ${{ github.event.workflow_run.id }}');
    expect(CODE).toContain('/jobs');
  });

  // 🔴 Признак — «отработал ли job `notify` наблюдаемого прогона», а не число job'ов:
  // считать стартовавшие значило бы угадывать, заводит ли GitHub записи job'ов для прогона,
  // который стоит в очереди. Имя сверяется с тем, что реально написано в `deploy.yml`.
  it('сообщение уходит только про прогон, о котором в канал ещё не сказали', () => {
    const notifyName = orFail(
      jobBody('notify')
        .find((l) => /^ {4}name:/.test(l))
        ?.replace(/^ {4}name:\s*/, '')
        .trim(),
      'у job `notify` в deploy.yml нет имени',
    );
    expect(CODE).toContain(`--arg name "${notifyName}"`);
    expect(line(/^\s*if:.*steps\.jobs/)).toBe("if: ${{ steps.jobs.outputs.reported == '0' }}");
    expect(CODE).toMatch(/reported=\$\{reported\}/);
  });

  it('сторож зовёт того же отправителя, а не свой curl', () => {
    expect(CODE).toContain(`bash ${NOTIFIER_PATH}`);
    expect(CODE).not.toContain('api.telegram.org');
    expect(CODE).toContain('TG_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}');
    expect(CODE).toContain('TG_CHAT: ${{ secrets.TELEGRAM_CHAT_ID }}');
  });

  // Строкой целиком, а не вхождением пути: `scripts/notify_telegram.sh` уже есть в теле
  // шага отправки, поэтому подмена выкачиваемого файла проверку по вхождению проходила.
  it('в разреженный чекаут попадает именно отправитель', () => {
    const at = CODE.split(/\r?\n/).findIndex((l) => /^\s*sparse-checkout:\s*\|\s*$/.test(l));
    expect(at).toBeGreaterThan(-1);
    expect(CODE.split(/\r?\n/)[at + 1].trim()).toBe(NOTIFIER_PATH);
    expect(line(/^\s*ref:/)).toBe('ref: ${{ github.event.repository.default_branch }}');
  });

  // Без `actions: read` вызов `gh api …/jobs` отдаёт 403, шаг падает, сообщения нет —
  // и увидеть это можно только на живом снятии прогона из очереди, то есть примерно никогда.
  it('у сторожа есть право читать список job’ов', () => {
    expect(CODE).toMatch(/^permissions:\s*$/m);
    expect(line(/^\s*actions:/)).toBe('actions: read');
  });

  // 🔴 Сторож обязан отработать, пока очередь занята. Попади он в группу `production-deploy`,
  // он сообщил бы о снятом прогоне после окончания выката — либо был бы снят из очереди
  // ровно тем же способом, о котором обязан рассказывать.
  it('сторож не встаёт в очередь выката', () => {
    expect(CODE).not.toContain('production-deploy');
  });
});

/**
 * Отмена устаревших прогонов на пути слияния (`LEGACY-240`).
 *
 * Три push подряд в ветку запроса на слияние давали три параллельных прогона `e2e`,
 * каждый со своими postgres и redis, и все занимали раннеры до конца.
 *
 * 🔴 Здесь ошибиться можно в обе стороны, и обе ошибки тихие.
 *
 * Первая — включить в группу push в `main`. Это **не** лечится `cancel-in-progress`:
 * очередь GitHub в группе глубиной один, и третий вставший в неё прогон отменяет
 * ожидавшего независимо от значения. Три слияния за 6–9 минут прогона `e2e` оставили бы
 * средний коммит `main` без единого job'а, и увидеть это можно только по пропавшему
 * прогону в истории. Поэтому суффикс группы для всего, кроме `pull_request`, —
 * `github.run_id`: он уникален на прогон.
 *
 * Вторая — сделать группу уникальной **всегда**: `concurrency` тогда выключен целиком,
 * `LEGACY-240` регрессирует, а проверка «в группе есть `github.ref`» этого не видит.
 * Ровно поэтому первая версия этой спеки, сверявшая группу через `toContain`, была
 * негодной: она пропускала собственную починку блокера. Группа сверяется **равенством**.
 */
describe('LEGACY-240: устаревший прогон на слиянии отменяется, прогон main не встаёт в очередь', () => {
  const value = (key: string): string => concurrencyValue(CI_LINES, 'ci.yml', key);

  const GROUP =
    "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'pull_request' && 'pr' || github.run_id }}";

  // Равенство, а не `toContain`: `${{ github.event_name == 'pull_request' || true }}`
  // и голое `true` содержат нужную подстроку и отменяют прогоны ветки по умолчанию.
  it('отмена включена ровно для запроса на слияние', () => {
    expect(value('cancel-in-progress')).toBe("${{ github.event_name == 'pull_request' }}");
  });

  // 🔴 Равенством целиком. Любая из трёх частей, снятая по отдельности, ломает свою
  // половину правила, и ни одна поломка не наблюдаема иначе как пропавшим прогоном.
  it('группа записана ровно так, как требуют обе половины правила', () => {
    expect(value('group')).toBe(GROUP);
  });

  // Те же два требования, но по отдельности и с внятным сообщением: кейс выше говорит
  // «строка не та», а эти два — какая именно половина правила нарушена.
  it('прогон push в main получает собственную группу', () => {
    expect(value('group')).toContain('github.run_id');
  });

  it('прогоны одной ветки запроса на слияние делят группу', () => {
    const group = value('group');
    expect(group).toContain('${{ github.ref }}');
    expect(group).toContain("github.event_name == 'pull_request'");
  });

  /**
   * 🔴 Оба значения выше опираются на событие `pull_request`. Убери его из триггеров —
   * и `cancel-in-progress` станет тождественно ложным, а суффикс группы — всегда
   * уникальным: `concurrency` выключен целиком при четырёх зелёных кейсах выше.
   * Заодно закреплено, что путь слияния вообще срабатывает на оба события.
   */
  it('оба события, на которых держатся значения выше, объявлены', () => {
    const on = topLevelBlockOf(CI_LINES, 'ci.yml', 'on');
    expect(on.some((line) => /^ {2}pull_request:/.test(line))).toBe(true);
    expect(on.some((line) => /^ {2}push:/.test(line))).toBe(true);
    const at = on.findIndex((line) => /^ {2}push:/.test(line));
    const rest = on.slice(at + 1);
    const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
    expect((end === -1 ? rest : rest.slice(0, end)).join('\n')).toContain('branches: [main]');
  });
});

/**
 * Плавающий тег образа (`LEGACY-244`).
 *
 * `latest` ставился по условию `is_default_branch`. После `LEGACY-241` воркфлоу на push
 * в `main` не ходит, а на push тега ветка по умолчанию ложна — значит на автоматическом
 * пути тег не двигался вовсе. Оставался один путь, где он двигался: ручной запуск с
 * `main`, то есть `latest` указывал на непомеченную ревизию ровно тогда, когда кто-то
 * катал ветку руками. Отказ тихий и вылезает вне конвейера: потянувший `:latest` для
 * отладки или восстановления получает не тот образ и не узнаёт об этом.
 *
 * 🔴 Условие сужено втрое, и каждая часть закрывает свой сценарий: событие — ручной
 * перекат старого тега ради отката (он бы переставил `latest` назад), тип ссылки —
 * собственно релизный путь, дефис в имени — пред-релизы (`v1.2.0-rc1` не должен
 * становиться `latest`). Сверяется строка целиком: снятая часть не наблюдаема ничем,
 * кроме реестра, а туда никто не смотрит до инцидента.
 */
describe('LEGACY-244: latest указывает на последний релиз', () => {
  const metaTags = (): string[] => {
    const lines = step('build', '🏷️ Extract Metadata').lines;
    const at = lines.findIndex((line) => /^\s*tags:\s*\|\s*$/.test(line));
    if (at === -1) throw new Error('в шаге `🏷️ Extract Metadata` нет блока `tags: |`');
    return lines.slice(at + 1).filter((line) => /^\s+type=/.test(line));
  };

  it('latest ставится только на push релизного тега', () => {
    // 🔴 Ровно одна строка, а не первое совпадение: `docker/metadata-action` применяет
    // **все** записи списка, поэтому вторая строка `type=raw,value=latest,enable=true`
    // под первой вернула бы тег на ручной перекат и на пред-релиз, а поиск первого
    // совпадения остался бы зелёным. Тот же урок, что в `concurrencyValue` и `key`.
    const latest = metaTags().filter((line) => line.includes('value=latest'));
    expect(latest.map((line) => line.trim())).toEqual([
      'type=raw,value=latest,' +
        "enable=${{ github.event_name == 'push' && github.ref_type == 'tag' " +
        "&& !contains(github.ref_name, '-') }}",
    ]);
  });

  // 🔴 Отдельным кейсом, потому что `is_default_branch` — это не «другое значение», а
  // ровно то условие, при котором тег перестал обновляться: воркфлоу на ветку не ходит.
  it('условие ветки по умолчанию не вернулось ни к одному тегу', () => {
    expect(metaTags().join('\n')).not.toContain('is_default_branch');
  });
});

/**
 * Вход `environment` (`LEGACY-247`).
 *
 * Вариант `staging` не переключал ничего: ssh шёл на `vars.PRODUCTION_SERVER`, дым — на
 * `vars.PRODUCTION_DOMAIN`, миграции применялись к боевой базе. Вход `workflow_dispatch`,
 * который не меняет поведения, опаснее отсутствующего: он читается как предохранитель.
 *
 * 🔴 Проверяется не отсутствие слова `staging`, а **обеспеченность каждого варианта**:
 * запрет на слово держался бы ровно до первого `preprod`, а правило здесь общее — вариант
 * существует тогда, когда у него есть свои адреса.
 */
describe('LEGACY-247: у каждого варианта окружения есть свои адреса', () => {
  /**
   * Варианты входа `environment`, и именно его: поиск первого блока `options:` внутри
   * `on:` начал бы проверять соседний `choice`-вход, заведённый выше, а `environment`
   * перестал бы проверяться вовсе.
   */
  const options = (): string[] => {
    const lines = topLevelBlock('on');
    const input = lines.findIndex((line) => /^\s{6}environment:\s*$/.test(line));
    if (input === -1) throw new Error('во входах `workflow_dispatch` нет `environment:`');
    const body = lines.slice(input + 1);
    const bodyEnd = body.findIndex((line) => /^\s{0,6}\S/.test(line));
    const own = bodyEnd === -1 ? body : body.slice(0, bodyEnd);
    const at = own.findIndex((line) => /^\s{8}options:\s*$/.test(line));
    if (at === -1) throw new Error('у входа `environment` нет блока `options:`');
    const rest = own.slice(at + 1);
    const end = rest.findIndex((line) => !/^\s{10}- /.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim().replace(/^- /, ''));
  };

  /** Строки, где берётся адрес сервера или домена из переменных репозитория. */
  const addressLines = (): string[] =>
    DEPLOY_CODE.split(/\r?\n/).filter((line) => /vars\.[A-Z0-9_]+_(SERVER|DOMAIN)/.test(line));

  it('варианты вообще перечислены', () => {
    expect(options().length).toBeGreaterThan(0);
  });

  it.each([['SERVER'], ['DOMAIN']])('каждый вариант обеспечен своей переменной %s', (suffix) => {
    for (const option of options()) {
      const variable = `vars.${option.toUpperCase()}_${suffix}`;
      // Сообщение печатает вариант: по `false !== true` не понять, какой из них голый.
      expect([option, DEPLOY_CODE.includes(variable)]).toEqual([option, true]);
    }
  });

  /**
   * 🔴 Кейс выше сам по себе негоден и оставлен только как источник внятного сообщения:
   * он ловит литерал `vars.STAGING_SERVER` где угодно в файле, а рядом, в шаге сводки,
   * уже стоит `echo "Server: ${{ vars.PRODUCTION_SERVER }}"` — то есть форма, которой
   * достаточно, чтобы вернуть `staging` в `options` при неизменном поведении: ssh, дым
   * и `environment.url` остались бы на `PRODUCTION_*`. Ровно этот дефект `LEGACY-247` и
   * закрывает, поэтому обеспеченность проверяется по **месту использования**: как только
   * вариантов больше одного, каждая строка, берущая адрес, обязана выбирать его по входу.
   */
  it('при нескольких вариантах адрес выбирается по входу, а не прибит к одному', () => {
    if (options().length < 2) return;
    for (const line of addressLines()) {
      expect([line.trim(), /inputs\.environment/.test(line)]).toEqual([line.trim(), true]);
    }
  });

  // Пока вариант один, действует обратное требование: адреса обязаны быть его, то есть
  // никаких других префиксов в файле быть не может. Иначе «единственный вариант» — слово.
  it('при единственном варианте все адреса принадлежат ему', () => {
    const only = options();
    if (only.length !== 1) return;
    const prefix = only[0].toUpperCase();
    for (const line of addressLines()) {
      const used = [...line.matchAll(/vars\.([A-Z0-9_]+)_(?:SERVER|DOMAIN)/g)].map((m) => m[1]);
      expect([line.trim(), used.every((name) => name === prefix)]).toEqual([line.trim(), true]);
    }
  });
});

/**
 * Состав образа и его уязвимости на пути слияния (`LEGACY-248`).
 *
 * Оба шага жили только в job `build` файла `deploy.yml`. До `LEGACY-241` она срабатывала
 * на каждый push в `main`; со снятием триггера отчёт стал появляться только на теге —
 * когда решение о релизе уже принято, а смотрят его на запросе на слияние.
 *
 * 🔴 Это наблюдение, а не гейт: у обоих шагов `continue-on-error: true`, у скана ещё и
 * `fail-build: false`. Покраснеть они не могут по построению, значит их пропажу не
 * заметит ни один прогон — держит её только эта спека (`LEGACY-207`, `LEGACY-209`).
 */
describe('LEGACY-248: состав образа описывается на обоих путях', () => {
  const ciStep = (job: string, name: string): Step =>
    orFail(
      steps(jobBodyOf(CI_LINES, 'ci.yml', job)).find((s) => s.name === name),
      `в job \`${job}\` файла ci.yml нет шага \`${name}\``,
    );

  /**
   * Значение ключа внутри шага (`uses:`, `image:`, `tags:`, `load:`).
   *
   * 🔴 Ровно одно вхождение, как и в `concurrencyValue`: вторая строка `push: true`,
   * дописанная под первой, вернула бы `false` поиском первого совпадения, а какая из
   * двух доедет до action — на усмотрение парсера.
   */
  const key = (s: Step, name: string): string => {
    const found = s.lines.filter((l) => new RegExp(`^\\s*${name}:\\s`).test(l));
    expect([s.name, name, found.length]).toEqual([s.name, name, 1]);
    const raw = found[0].replace(new RegExp(`^\\s*${name}:\\s*`), '').trim();
    // Концевой комментарий YAML частью значения не является: у половины этих ключей
    // рядом стоит пояснение (`continue-on-error: true # Don't block deployment…`),
    // и без среза сверка равенством ловила бы текст комментария. У значения в кавычках
    // `#` — обычный символ, поэтому там не режем.
    return /^['"]/.test(raw) ? raw : raw.replace(/\s+#.*$/, '').trim();
  };

  const SBOM = '📋 Generate SBOM';
  const SCAN = '🔍 Security Scan';
  const USES: Array<[string, string]> = [
    [SBOM, 'anchore/sbom-action@v0'],
    [SCAN, 'anchore/scan-action@v3'],
  ];

  // 🔴 Обе стороны сверяются **одной и той же** строкой с версией. Пока теговый путь
  // проверялся регуляркой `/^anchore\//`, апгрейд действия в одном файле проходил
  // зелёным: на слиянии смотрят отчёт одного сканера, релиз описывает другой, и
  // расхождение не читается никем — оба шага стоят с `continue-on-error`.
  it.each(USES)('шаг %s зовёт %s на обоих путях', (name, uses) => {
    expect(key(ciStep('image', name), 'uses')).toBe(uses);
    expect(key(step('build', name), 'uses')).toBe(uses);
  });

  // 🔴 Главное отличие от тегового пути: там образ уже в реестре, здесь его туда не
  // публикуют. Без `load: true` собранный образ существует только слоями в кэше buildx,
  // и оба шага молча описывали бы пустоту — `continue-on-error` это ещё и скроет.
  it('на пути слияния сканируется образ, собранный здесь же', () => {
    const built = ciStep('image', 'Build image (no push)');
    expect(key(built, 'load')).toBe('true');
    const tag = key(built, 'tags');
    expect(tag).not.toContain('ghcr.io');
    expect(key(ciStep('image', SBOM), 'image')).toBe(tag);
    expect(key(ciStep('image', SCAN), 'image')).toBe(tag);
  });

  // То же требование для тегового пути: там образ берётся из реестра, и сверять его надо
  // с тем, что действительно собрано и опубликовано, — иначе опечатка в теге даёт пустой
  // SBOM и пустой скан, а `continue-on-error` это скрывает.
  /**
   * 🔴 Ссылка выводится из блока `tags:` шага метаданных, а не записана литералом рядом.
   * Литерал сверял бы текст с текстом: убери из `tags:` строку `type=raw,value=<версия>`,
   * и оба шага начнут описывать тег, которого в реестре нет, — при `continue-on-error`
   * это пустой отчёт и зелёный прогон. Проверяется, что образ собран из образов реестра
   * и что его версия — та же, что публикуется.
   */
  it('на теговом пути сканируется опубликованная версия', () => {
    const meta = step('build', '🏷️ Extract Metadata');
    const at = meta.lines.findIndex((line) => /^\s*tags:\s*\|\s*$/.test(line));
    const tags = meta.lines.slice(at + 1).filter((line) => /^\s+type=/.test(line));
    const version = '${{ steps.version.outputs.version }}';
    expect(tags.some((line) => line.trim() === `type=raw,value=${version}`)).toBe(true);

    const images = key(meta, 'images');
    for (const name of [SBOM, SCAN]) {
      expect([name, key(step('build', name), 'image')]).toEqual([name, `${images}:${version}`]);
    }
  });

  // Путь слияния по-прежнему ничего не публикует: `load` — не `push`.
  it('загрузка образа в демон не превратилась в публикацию', () => {
    expect(key(ciStep('image', 'Build image (no push)'), 'push')).toBe('false');
  });

  /**
   * 🔴 Неблокирующий режим — решение, а не случайность, и закрепить его надо в обе
   * стороны. Снять `continue-on-error` со скана значит заблокировать все запросы на
   * слияние первым же CVE в базовом образе, который никто не выбирал и не может убрать
   * правкой кода; вернуть `fail-build: true` — то же самое другим способом. Ни то ни
   * другое не краснеет: шаг просто начинает валить чужие прогоны.
   */
  it.each([[SBOM], [SCAN]])('шаг %s остаётся наблюдением, а не гейтом, на обоих путях', (name) => {
    expect(key(ciStep('image', name), 'continue-on-error')).toBe('true');
    expect(key(step('build', name), 'continue-on-error')).toBe('true');
  });

  it('скан не валит сборку ни на одном пути', () => {
    expect(key(ciStep('image', SCAN), 'fail-build')).toBe('false');
    expect(key(step('build', SCAN), 'fail-build')).toBe('false');
  });

  /**
   * 🔴 Без выгруженного отчёта «наблюдение» остаётся словом: при отказе самого сканера
   * шаг зелёный и в логе нет ничего, что отличало бы это от чистого образа. SBOM
   * выкладывает себя сам (`artifact-name`), скану нужен отдельный шаг — и он обязан
   * выполняться при `always()`, иначе пропадёт ровно в том случае, ради которого заведён.
   */
  const UPLOAD = '📤 Upload Scan Report';

  it.each([
    ['ci.yml', () => ciStep('image', UPLOAD), () => ciStep('image', SCAN)],
    ['deploy.yml', () => step('build', UPLOAD), () => step('build', SCAN)],
  ] as Array<[string, () => Step, () => Step]>)(
    'отчёт скана выкладывается артефактом на пути %s',
    (_file, upload, scan) => {
      // Версия равенством, а не `/^actions\/upload-artifact@/`: ровно от такой формы
      // отказались для `anchore/*` — она пропускает апгрейд на одном из путей.
      expect(key(upload(), 'uses')).toBe('actions/upload-artifact@v4');
      expect(key(upload(), 'path')).toBe('${{ steps.scan.outputs.sarif }}');
      // Шаг ссылается на `steps.scan`, значит идентификатор обязан существовать.
      expect(key(scan(), 'id')).toBe('scan');
    },
  );

  /**
   * 🔴 Главный инвариант этого шага, и он не про наличие. `anchore/scan-action` выставляет
   * `sarif` только после успешной записи отчёта, а `path` у `actions/upload-artifact@v4`
   * читается как `required: true` и на пустой строке падает с `Input required and not
   * supplied`. Шаг с одним `if: always()` краснел бы **именно при отказе сканера** — то
   * есть ровно в том случае, ради наблюдаемости которого заведён, — и блокировал бы
   * слияние. Поэтому проверяется и непустой выход в условии, и `continue-on-error`.
   */
  it.each([
    ['ci.yml', () => ciStep('image', UPLOAD)],
    ['deploy.yml', () => step('build', UPLOAD)],
  ] as Array<[string, () => Step]>)(
    'выгрузка отчёта не краснеет от отказа сканера на пути %s',
    (_file, upload) => {
      expect(stepCondition(upload())).toBe("always() && steps.scan.outputs.sarif != ''");
      expect(key(upload(), 'continue-on-error')).toBe('true');
    },
  );
});

/**
 * Первый настоящий тег (`v1.0.0`, 20.08.2026) показал, что путь «выкат по тегу» не работал
 * вовсе: `type=sha,prefix={{branch}}-` на теге подставлял пустую ветку, и сборка падала на
 * `invalid tag "ghcr.io/…/books:-9b9b4bc"`. Триггер по ветке сняли 17.08.2026 (LEGACY-241),
 * и с этого момента у выката не осталось ни одного рабочего пути — заметить это было нечем.
 *
 * 🔴 Проверяется не «строка есть», а **обеспеченность каждой ветви ссылки**: тег с префиксом
 * ветки разрешён только там, где ветка существует, и на всё остальное заведён свой тег.
 * Запрет на подстроку `{{branch}}` держался бы ровно до следующего шаблона.
 */
describe('выкат по тегу собирает образ с годным именем', () => {
  const metaTagLines = (): string[] => {
    const lines = step('build', '🏷️ Extract Metadata').lines;
    const at = lines.findIndex((line) => /^\s*tags:\s*\|\s*$/.test(line));
    if (at === -1) throw new Error('в шаге `🏷️ Extract Metadata` нет блока `tags: |`');
    return lines
      .slice(at + 1)
      .filter((line) => /^\s+type=/.test(line))
      .map((line) => line.trim());
  };

  it('шаблон с веткой в префиксе ограничен ссылкой-веткой', () => {
    const withBranch = metaTagLines().filter((line) => line.includes('{{branch}}'));

    expect(withBranch).not.toHaveLength(0);
    for (const line of withBranch) {
      expect(line).toContain("enable=${{ github.ref_type == 'branch' }}");
    }
  });

  it('на теге у образа остаётся тег по sha', () => {
    expect(metaTagLines()).toContain("type=sha,enable=${{ github.ref_type != 'branch' }}");
  });
});

/**
 * Гейт зелёного `ci.yml` на коммите тега.
 *
 * `ci.yml` висит на push в `main` и на pull request, на тег он не срабатывает вовсе. Job
 * `test` внутри выката гоняет `yarn ci`, но это проверка кода в момент выката, а не факт,
 * что этот коммит проходил конвейер целиком — с e2e на postgres и redis и со сборкой образа.
 *
 * 🔴 Проверяется и наличие job'ы, и то, что выкат от неё зависит. Job, на которую никто не
 * ссылается в `needs`, выполняется параллельно и ничего не задерживает: её отказ был бы
 * виден в интерфейсе и не мешал бы выкату дойти до сервера.
 */
describe('тег без зелёного CI до сервера не доходит', () => {
  /** Значение верхнеуровневого ключа job'ы: строки job'ы идут с отступом в четыре пробела. */
  const jobKey = (job: string, name: string): string => {
    const line = jobBody(job).find((l) => new RegExp(`^ {4}${name}:`).test(l));
    return orFail(line, `в job '${job}' нет ключа '${name}'`).trim();
  };

  it('job гейта существует и работает только на пуше тега', () => {
    const gate = jobBody('ci_gate');

    expect(gate.length).toBeGreaterThan(0);
    expect(gate.join('\n')).toContain(
      "if: ${{ github.event_name == 'push' && github.ref_type == 'tag' }}",
    );
  });

  it('выкат ждёт гейт', () => {
    expect(jobKey('deploy', 'needs')).toContain('ci_gate');
  });

  /**
   * 🔴 Перечисление допустимых состояний, а не исключение недопустимых. `!= 'failure'`
   * пропустил бы `cancelled`, а любое новое состояние job'ы по умолчанию считалось бы
   * разрешением — ошибка в сторону выката.
   */
  it('условие выката перечисляет допустимые состояния гейта', () => {
    const condition = jobKey('deploy', 'if');

    expect(condition).toContain("needs.ci_gate.result == 'success'");
    expect(condition).toContain("needs.ci_gate.result == 'skipped'");
    expect(condition).not.toContain('needs.ci_gate.result != ');
  });
});
