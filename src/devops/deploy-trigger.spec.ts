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
const CI_YML = stripComments(readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf8'));
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

/** Помощники бросают, а не зовут `expect`: падение на сборе набора скрыло бы имя кейса. */
const orFail = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message);
  return value;
};

/** Тело блока верхнего уровня (`on:`, `jobs:`) — до следующей строки нулевого отступа. */
const topLevelBlock = (key: string): string[] => {
  const start = LINES.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start === -1) throw new Error(`в deploy.yml нет блока верхнего уровня \`${key}:\``);
  const rest = LINES.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => !isComment(line));
};

/** Тело job'а первого уровня вложенности, без комментариев. */
const jobBody = (job: string): string[] => {
  const jobs = LINES.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobs === -1) throw new Error('в deploy.yml нет блока `jobs:`');
  const start = LINES.findIndex(
    (line, i) => i > jobs && new RegExp(`^ {2}${job}:\\s*$`).test(line),
  );
  if (start === -1) throw new Error(`в deploy.yml нет job'а \`${job}\``);
  const rest = LINES.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line) && !isComment(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => !isComment(line));
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
  // сборка образа жила только в `deploy.yml`. Без встречного шага в `scripts/ci.sh`
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
 * `.github/workflows/**`, был бы неверен: у `ci.yml` значение `cancel-in-progress`
 * противоположное по `LEGACY-240`.
 */
describe('LEGACY-245: выкат встаёт в очередь, а не идёт вторым прогоном рядом', () => {
  it('у deploy.yml есть блок верхнего уровня concurrency', () => {
    expect(topLevelBlock('concurrency').some((line) => /^ {2}group:\s*\S/.test(line))).toBe(true);
  });

  // 🔴 Отменённый посреди `prisma migrate deploy` выкат оставляет частично применённую
  // пачку миграций (`LEGACY-242`) — это хуже очереди. Значение сверяется точным
  // равенством: `cancel-in-progress: ${{ ... }}` тоже прошёл бы проверку на наличие.
  it('cancel-in-progress равен ровно false', () => {
    const line = orFail(
      topLevelBlock('concurrency').find((l) => /^ {2}cancel-in-progress:/.test(l)),
      'в блоке `concurrency:` нет ключа `cancel-in-progress`',
    );
    expect(line.replace(/^ {2}cancel-in-progress:\s*/, '').trim()).toBe('false');
  });

  // 🔴 Привычное `${{ github.workflow }}-${{ github.ref }}` здесь само является дефектом:
  // у двух разных тегов `github.ref` разный, прогоны попадают в разные группы и идут
  // параллельно — ровно то, от чего защищаемся. Группа обязана быть одна на все прогоны.
  it('группа не разъезжается по прогонам', () => {
    const line = orFail(
      topLevelBlock('concurrency').find((l) => /^ {2}group:/.test(l)),
      'в блоке `concurrency:` нет ключа `group`',
    );
    const group = line.replace(/^ {2}group:\s*/, '').trim();
    expect(group).not.toBe('');
    for (const varying of ['github.ref', 'github.sha', 'github.run_id', 'github.event.inputs']) {
      expect([varying, group.includes(varying)]).toEqual([varying, false]);
    }
  });
});

/**
 * Сторож heredoc'а выката (`LEGACY-246`).
 *
 * `ssh ... << EOF` **без кавычек** вокруг `EOF` разворачивает подстановки на раннере,
 * до отправки на сервер. Раннер выполняет `run:` через `bash -e` без `-u`, поэтому
 * неизвестная ему переменная подставляется пустой строкой молча: галка
 * `skip_backup_emergency` ставилась, а `--no-backup` до `deploy_production.sh` не
 * доезжал вовсе. Всё, что должно вычисляться на сервере, обязано быть экранировано.
 */
describe('LEGACY-246: переменные heredoc считаются на сервере, а не на раннере', () => {
  /** Единственная переменная, объявленная на раннере выше по шагу, — она и раскрывается там. */
  const RUNNER_VARS = ['REPO_LOWER'];

  /** Тело heredoc'а шага `🚀 Deploy to Server` — от `<< EOF` и до конца шага. */
  const heredoc = (): string => {
    const body = runBody(step('deploy', '🚀 Deploy to Server'));
    const at = body.indexOf('<< EOF');
    if (at === -1) throw new Error('в шаге `🚀 Deploy to Server` нет heredoc `<< EOF`');
    return body.slice(at);
  };

  it('неэкранированных серверных подстановок в heredoc нет', () => {
    // Подстановки `${{ ... }}` раннерные по определению — их снимаем до разбора,
    // иначе `${{ github.sha }}` попал бы в находки как `${ github` .
    const shell = heredoc().replace(/\$\{\{[\s\S]*?\}\}/g, '');
    const offenders = [...shell.matchAll(/(\\?)\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)|(\()|(`))/g)]
      .filter((m) => m[1] !== '\\')
      .filter((m) => !RUNNER_VARS.includes(m[2] ?? m[3] ?? ''))
      .map((m) => m[0]);
    expect(offenders).toEqual([]);
  });

  it('обратных апострофов в heredoc нет — они тоже считались бы на раннере', () => {
    expect(heredoc().replace(/\$\{\{[\s\S]*?\}\}/g, '')).not.toContain('`');
  });

  // Экранирование без самого флага бессмысленно: удалённая ветка присваивания оставила бы
  // проверку выше зелёной, а галку — по-прежнему неработающей.
  it('флаг пропуска бэкапа собирается и доезжает до скрипта', () => {
    const body = heredoc();
    expect(body).toContain('BACKUP_FLAG="--no-backup"');
    expect(body).toMatch(/\\\$BACKUP_FLAG/);
  });
});
