import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Сторож LEGACY-123: третий проход `drift-check` и его вызов из обоих путей конвейера.
 *
 * Шесть запросов на сыром SQL держат имена таблиц и колонок строками внутри шаблона.
 * `tsc` внутрь шаблона не смотрит, `prisma generate` типизирует делегатов, а не сырой SQL,
 * поэтому переименование колонки рукописной миграцией проходит все шаги конвейера зелёными
 * и падает уже в рантайме на публичном маршруте. С 19.08.2026 идентификаторы этих шаблонов
 * сверяет со `schema.prisma` третий проход `scripts/drift-check.mjs`.
 *
 * Почему сторожа два. Правильность самого прохода закрывает `--self-test`: подложенный
 * дефект обязан краснеть, чистая фикстура — нет. Но self-test живёт внутри той же команды,
 * которую конвейер может перестать звать, и тогда он зелен ровно потому, что не выполняется.
 * Эта спека стережёт другое: что команда вызывается, что она вызывается **в обоих** путях —
 * `scripts/ci.sh` (его зовёт `ci.yml` на pull request) и `.github/workflows/deploy.yml`
 * (тег `v*`, где `ci.yml` не запускается вовсе, — так уже уезжали релизы мимо проверки,
 * `LEGACY-207`, `LEGACY-209`), что вызов не смягчён и не убран под условие, и что за именем
 * скрипта в `package.json` стоит настоящий файл.
 *
 * Ни `scripts/**`, ни `.github/workflows/**`, ни `package.json` не читают ни `tsc`, ни `eslint`
 * (тот ходит по `{src,apps,libs,test}/**\/*.ts`), ни один шаг конвейера, кроме спек этого каталога.
 */

const ROOT = resolve(__dirname, '..', '..');
const CI_SH = readFileSync(join(ROOT, 'scripts', 'ci.sh'), 'utf8');
const DEPLOY_YML = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const DRIFT_CHECK = readFileSync(join(ROOT, 'scripts', 'drift-check.mjs'), 'utf8');
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
 * Шаг `deploy.yml` вместе с телом: от строки `- name:` до следующей строки того же
 * отступа. Разбор ручной по той же причине, что и в соседних спеках каталога: ни `yaml`,
 * ни `js-yaml` не объявлены в `package.json`.
 */
const stepWith = (yml: string, needle: string): string[] => {
  const all = lines(yml);
  // Отступ фиксирован, как у соседей по каталогу: `- name:` на другом уровне вложенности —
  // это не шаг job'а, и считать его границей значит вернуть чужое тело.
  const heads = all
    .map((line, i) => ({ i, head: /^ {6}- name:/.test(line) }))
    .filter((x) => x.head);
  for (let k = 0; k < heads.length; k += 1) {
    const from = heads[k].i;
    let to = k + 1 < heads.length ? heads[k + 1].i : all.length;
    // Комментарий перед следующим шагом принадлежит ему, а не этому: без этого шаг «съедает»
    // чужую шапку, и утверждения о `continue-on-error` начинают стеречь не тот шаг.
    while (to - 1 > from && (isBlank(all[to - 1]) || isComment(all[to - 1]))) to -= 1;
    const body = all.slice(from, to);
    if (body.some((line) => line.includes(needle))) return body;
  }
  throw new Error(`в deploy.yml нет шага со строкой ${needle}`);
};

/** Тело функции по её объявлению — от `function <имя>(` до строки `}` того же отступа. */
const functionBody = (source: string, name: string): string => {
  const all = lines(source);
  const start = all.findIndex((line) => line.startsWith(`function ${name}(`));
  expect(start).toBeGreaterThan(-1);
  const end = all.findIndex((line, i) => i > start && line === '}');
  expect(end).toBeGreaterThan(start);
  return all.slice(start, end + 1).join('\n');
};

describe('drift-check вызывается конвейером', () => {
  const SELF_TEST = /^yarn drift-check:self-test(\s|$)/;
  const CHECK = /^yarn drift-check(\s|$)/;

  it('scripts/ci.sh зовёт self-test до самой проверки, и обе команды на верхнем уровне', () => {
    // Сравнение по СЫРЫМ строкам, а не по обрезанным: обёртка вида
    // `if [[ "${RUN_DRIFT:-0}" == "1" ]]; then … fi` не меняет ни одного слова, только отступ,
    // и на обрезанных строках сторож остался бы зелёным при выключенной проверке.
    const raw = lines(CI_SH);
    const selfTest = raw.indexOf('yarn drift-check:self-test');
    const check = raw.indexOf('yarn drift-check');

    expect(selfTest).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    // Порядок из записи: негодная проверка приучает игнорировать вывод (LEGACY-045),
    // поэтому сначала доказательство, что проверка умеет краснеть, и только потом она сама.
    expect(selfTest).toBeLessThan(check);
  });

  it('deploy.yml зовёт те же две команды: тег v* мимо ci.yml', () => {
    const step = commands(stepWith(DEPLOY_YML, 'yarn drift-check').join('\n'));
    const selfTest = step.findIndex((line) => SELF_TEST.test(line));
    const check = step.findIndex((line) => CHECK.test(line));

    expect(selfTest).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(selfTest).toBeLessThan(check);
  });

  it('за именем скрипта стоит настоящий файл', () => {
    // `"drift-check": "true"` оставляет оба пути конвейера и все утверждения выше зелёными,
    // а проверок не выполняет вовсе. Так же закреплён и соседний `check-migration-compat`.
    expect(PACKAGE_JSON.scripts['drift-check']).toBe('node scripts/drift-check.mjs');
    expect(PACKAGE_JSON.scripts['drift-check:self-test']).toBe(
      'node scripts/drift-check.mjs --self-test',
    );
  });

  it('ни один вызов не смягчён', () => {
    for (const text of [CI_SH, DEPLOY_YML]) {
      for (const line of commands(text)) {
        if (!line.includes('drift-check')) continue;
        // Любое `||`, а не только `|| true`: `|| :` и `|| echo …` глушат код возврата так же.
        expect(line).not.toContain('||');
        expect(line).not.toContain('--allow-unparsed');
      }
    }
    // `set +e` снимает `set -euo pipefail` для всего, что идёт после него, — то же смягчение,
    // только на расстоянии от самой команды.
    expect(CI_SH).toContain('set -euo pipefail');
    expect(CI_SH).not.toContain('set +e');
    // Шаг целиком: `continue-on-error` и `if:` стоят не на команде, а рядом с ней, и делают
    // красный шаг незаметным ровно так же.
    const step = stepWith(DEPLOY_YML, 'yarn drift-check');
    expect(step.some((line) => line.includes('continue-on-error'))).toBe(false);
    expect(step.some((line) => /^\s*if:/.test(line))).toBe(false);
  });
});

describe('третий проход подключён, а не просто написан', () => {
  it('checkRepo зовёт проверку сырого SQL', () => {
    expect(functionBody(DRIFT_CHECK, 'checkRepo')).toContain('checkRawSql(repo, schema)');
  });

  it('проверка сырого SQL читает все каталоги с кодом, а не один файл', () => {
    const body = functionBody(DRIFT_CHECK, 'checkRawSql');
    expect(body).toContain('SOURCE_ROOTS.flatMap((root) => listSourceFiles(join(repo, root)))');
    // `prisma/scripts/**` держит обслуживающие скрипты с настоящим сырым SQL, `libs/**` —
    // источник, который eslint уже считает своим: то же переименование ломает и их.
    const roots = /const SOURCE_ROOTS = \[([^\]]*)\]/.exec(DRIFT_CHECK);
    expect(roots).not.toBeNull();
    for (const root of ["'src'", "'prisma'", "'libs'"]) {
      expect(roots![1]).toContain(root);
    }
  });

  it('находки прохода делают прогон красным', () => {
    const body = functionBody(DRIFT_CHECK, 'checkRawSql');
    // Без обеих строк отчёт печатается, а код возврата остаётся нулевым: конвейер
    // проходит мимо найденного расхождения, и вывод читает только тот, кто его искал.
    expect(body).toContain("problems.push('raw SQL identifiers')");
    expect(body).toContain("problems.push('unresolved raw SQL')");
    // Нулевое покрытие — тоже отказ: прочитать ноль шаблонов и отрапортовать согласие значит
    // вернуться к состоянию до LEGACY-123, но уже с отметкой «сверено».
    expect(body).toContain('templates === 0');
  });

  it('self-test стережёт обе половины прохода', () => {
    // Случаи с ожиданием `[]` в счёт не идут: зелёная фикстура не докажет, что проверка
    // умеет краснеть. Нужны оба класса находок — иначе половина прохода не проверена ничем.
    expect(DRIFT_CHECK).toContain("expect: ['raw SQL identifiers']");
    expect(DRIFT_CHECK).toContain("expect: ['unresolved raw SQL']");
  });
});
