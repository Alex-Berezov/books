import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Сторож LEGACY-045: `delegate-check` и его вызов из обоих путей конвейера.
 *
 * Приведение клиента (`as unknown as SomeDelegate`, `prisma['model']`) выключает проверку типов,
 * и опечатка в имени модели доживает до прода — тот самый класс отказа, который положил фазу 14
 * (ADR-011). С 05.09.2026 имена моделей сверяет со `schema.prisma` `scripts/delegate-check.mjs`.
 *
 * Почему сторожа два. Правильность самой проверки закрывает `--self-test`: подложенный дефект
 * обязан краснеть, чистая фикстура — нет. Но self-test живёт внутри той же команды, которую
 * конвейер может перестать звать, и тогда он зелен ровно потому, что не выполняется. Эта спека
 * стережёт другое: что команда вызывается, что она вызывается **в обоих** путях — `scripts/ci.sh`
 * (его зовёт `ci.yml` через `yarn ci`) и `.github/workflows/deploy.yml` (тег `v*`, где `ci.yml`
 * не запускается вовсе, — так уже уезжали релизы мимо проверки, `LEGACY-207`, `LEGACY-209`),
 * что вызов не смягчён и не убран под условие, и что за именем скрипта в `package.json` стоит
 * настоящий файл.
 *
 * Ни `scripts/**`, ни `.github/workflows/**`, ни `package.json` не читают ни `tsc`, ни `eslint`
 * (тот ходит по `{src,apps,libs,test}/**\/*.ts`), ни один шаг конвейера, кроме спек этого каталога.
 * Форма повторяет соседний `drift-check-wiring.spec.ts` намеренно: у двух проверок одного уклада
 * должен быть один и тот же сторож, иначе разойдутся не только они, но и представление о том,
 * что здесь считается подключённой проверкой.
 */

const ROOT = resolve(__dirname, '..', '..');
const CI_SH = readFileSync(join(ROOT, 'scripts', 'ci.sh'), 'utf8');
const DEPLOY_YML = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const DELEGATE_CHECK = readFileSync(join(ROOT, 'scripts', 'delegate-check.mjs'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const isBlank = (line: string): boolean => line.trim() === '';
const isComment = (line: string): boolean => /^\s*#/.test(line);

const lines = (text: string): string[] => text.split(/\r?\n/);

/** Строки файла без комментариев и пустых: в этих файлах комментарий на каждой второй строке. */
const commands = (text: string): string[] =>
  lines(text)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/**
 * Шаг `deploy.yml` вместе с телом: от строки `- name:` до следующей строки того же отступа.
 * Разбор ручной по той же причине, что и в соседних спеках каталога: ни `yaml`, ни `js-yaml`
 * не объявлены в `package.json`.
 */
const stepWith = (yml: string, needle: string): string[] => {
  const all = lines(yml);
  const heads = all
    .map((line, i) => ({ i, head: /^ {6}- name:/.test(line) }))
    .filter((x) => x.head);
  for (let k = 0; k < heads.length; k += 1) {
    const from = heads[k].i;
    let to = k + 1 < heads.length ? heads[k + 1].i : all.length;
    // Комментарий перед следующим шагом принадлежит ему, а не этому.
    while (to - 1 > from && (isBlank(all[to - 1]) || isComment(all[to - 1]))) to -= 1;
    const body = all.slice(from, to);
    if (body.some((line) => line.includes(needle))) return body;
  }
  throw new Error(`в deploy.yml нет шага со строкой ${needle}`);
};

describe('delegate-check вызывается конвейером', () => {
  const SELF_TEST = /^yarn delegate-check:self-test(\s|$)/;
  const CHECK = /^yarn delegate-check(\s|$)/;

  it('scripts/ci.sh зовёт self-test до самой проверки, и обе команды на верхнем уровне', () => {
    // Сравнение по СЫРЫМ строкам, а не по обрезанным: обёртка вида
    // `if [[ "${RUN_DELEGATE:-0}" == "1" ]]; then … fi` не меняет ни одного слова, только отступ,
    // и на обрезанных строках сторож остался бы зелёным при выключенной проверке.
    const raw = lines(CI_SH);
    const selfTest = raw.indexOf('yarn delegate-check:self-test');
    const check = raw.indexOf('yarn delegate-check');

    expect(selfTest).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    // Порядок из самой записи: негодная проверка приучает игнорировать вывод (LEGACY-045),
    // поэтому сначала доказательство, что проверка умеет краснеть, и только потом она сама.
    expect(selfTest).toBeLessThan(check);
  });

  it('deploy.yml зовёт те же две команды: тег v* мимо ci.yml', () => {
    const step = commands(stepWith(DEPLOY_YML, 'yarn delegate-check').join('\n'));
    const selfTest = step.findIndex((line) => SELF_TEST.test(line));
    const check = step.findIndex((line) => CHECK.test(line));

    expect(selfTest).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(selfTest).toBeLessThan(check);
  });

  it('за именем скрипта стоит настоящий файл', () => {
    // `"delegate-check": "true"` оставляет оба пути конвейера и все утверждения выше зелёными,
    // а проверок не выполняет вовсе. Так же закреплены соседние drift-check и
    // check-migration-compat.
    expect(PACKAGE_JSON.scripts['delegate-check']).toBe('node scripts/delegate-check.mjs');
    expect(PACKAGE_JSON.scripts['delegate-check:self-test']).toBe(
      'node scripts/delegate-check.mjs --self-test',
    );
  });

  it('ни один вызов не смягчён', () => {
    for (const text of [CI_SH, DEPLOY_YML]) {
      for (const line of commands(text)) {
        if (!line.includes('delegate-check')) continue;
        // Проверяется сам оператор `||`, а не список известных хвостов: двоеточие, `echo` и
        // любая другая безобидная команда справа глушат код возврата ровно так же.
        expect(line).not.toContain('||');
      }
    }
    // `set +e` снимает `set -euo pipefail` для всего, что идёт после него, — то же смягчение,
    // только на расстоянии от самой команды.
    expect(CI_SH).toContain('set -euo pipefail');
    expect(CI_SH).not.toContain('set +e');
    // Шаг целиком: `continue-on-error` и `if:` стоят не на команде, а рядом с ней, и делают
    // красный шаг незаметным ровно так же.
    const step = stepWith(DEPLOY_YML, 'yarn delegate-check');
    expect(step.some((line) => line.includes('continue-on-error'))).toBe(false);
    expect(step.some((line) => /^\s*if:/.test(line))).toBe(false);
  });
});

describe('проверка читает то, что обещает', () => {
  it('обходятся все каталоги с кодом, а не только src', () => {
    // `prisma/seed.ts` и `prisma/scripts/**` зовут делегатов, но не покрыты ни `tsconfig.json`
    // (он компилирует `src/**`), ни eslint. Опечатка в сиде краснеет не здесь, а в конвейере
    // ФРОНТА: тот гоняет `prisma db seed` в образе бэкенда, чтобы наполнить базу под e2e
    // (LEGACY-294).
    const roots = /const SOURCE_ROOTS = \[([^\]]*)\]/.exec(DELEGATE_CHECK);
    expect(roots).not.toBeNull();
    for (const root of ["'src'", "'prisma'", "'libs'"]) {
      expect(roots![1]).toContain(root);
    }
  });

  it('находки делают прогон красным, а мёртвая схема — нет', () => {
    // Без этих строк отчёт печатается, а код возврата остаётся нулевым: конвейер проходит мимо
    // найденного расхождения, и вывод читает только тот, кто его искал.
    expect(DELEGATE_CHECK).toContain("problems.push('unknown delegate access')");
    expect(DELEGATE_CHECK).toContain("problems.push('bracket access to unknown model')");
    expect(DELEGATE_CHECK).toContain("problems.push('interface declares unknown model')");
    // А вот «модель не используется» красным быть не должно: модель, которую читают только
    // связью (`select: { translations: true }`), делегата не имеет вовсе, и падение на ней
    // означало бы красный гейт на исправном коде.
    expect(DELEGATE_CHECK).not.toContain("problems.push('models never accessed')");
  });

  it('self-test стережёт обе стороны каждого класса находок', () => {
    // Случаи с ожиданием `[]` в счёт не идут поодиночке: зелёная фикстура не докажет, что
    // проверка умеет краснеть. Нужны оба класса находок и обе стороны — иначе половина
    // проверки не проверена ничем.
    expect(DELEGATE_CHECK).toContain("expect: ['unknown delegate access']");
    expect(DELEGATE_CHECK).toContain("expect: ['bracket access to unknown model']");
    expect(DELEGATE_CHECK).toContain("expect: ['interface declares unknown model']");
    // Ложная тревога — такой же отказ, как пропуск: ровно из-за неё запись заводили второй раз.
    expect(DELEGATE_CHECK).toContain('expectNoReport');
  });
});
