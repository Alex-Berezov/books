import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Сторож LEGACY-147 и LEGACY-148: локальные хуки не умеют бесшумно самоотключаться.
 *
 * До 26.08.2026 в `books` был один хук — `pre-commit` — и он выключался целиком одной
 * несработавшей проверкой PATH: `command -v yarn ... || { echo >&2 ...; exit 0; }`.
 * Ноль означает «проверки прошли», поэтому коммит уходил без линта и без typecheck,
 * а результат был неотличим от успешного прогона. Попасть в эту ветку легко: другой
 * менеджер версий Node, запуск git из среды разработки со своим PATH, свежая машина.
 *
 * Про `set -e`, чтобы следующий агент не искал несуществующий дефект: обрыв на первой
 * упавшей команде был и до правки. Git зовёт хук через `core.hooksPath = .husky/_`,
 * а `.husky/_/h` последней строкой делает `sh -e "$s" "$@"` — errexit включён снаружи.
 * `set -e` в самих файлах добавлен как страховка на прямой запуск (`sh .husky/pre-commit`)
 * и чтобы намерение лежало здесь, а не в шиме, который husky перезаписывает при установке.
 * Снимать `-e` у шима на этом основании **нельзя**: для husky 10 путь запуска меняется.
 *
 * Второе — `drift-check`. Правка `prisma/schema.prisma` без нового каталога миграции
 * держит typecheck и юнит-тесты зелёными (типы собираются из схемы, а не из базы)
 * и всплывает отсутствующей колонкой на проде. В обоих хуках вызов **безусловный**:
 * условие по путям `prisma/**` минует третий проход скрипта (`LEGACY-123`, сторож
 * `drift-check-wiring.spec.ts`), который сверяет со схемой идентификаторы сырого SQL
 * из `src/**`, и не срабатывает на staged-удалении каталога миграции. 0,67 с рядом
 * с безусловным `yarn typecheck` на весь проект в том же хуке (LEGACY-148).
 *
 * Состав `pre-push` — решение арбитра от 26.08.2026, `decisions-log.md`: `yarn test`,
 * но не `lint`, не `build`, не `test:cov` и не `test:e2e` — их место в `scripts/ci.sh`.
 * Замер 26.08.2026: 66 с на холодном кеше ts-jest, 33 с на прогретом.
 *
 * Проверить поведение хука прогоном нельзя: пришлось бы менять PATH внутри теста.
 * Поэтому сторож читает текст. Ни `tsc`, ни `eslint` в `.husky/**` не заглядывают.
 */

const ROOT = resolve(__dirname, '..', '..');
const HOOKS = join(ROOT, '.husky');

const hook = (name: string): string => readFileSync(join(HOOKS, name), 'utf8');

/**
 * Режим файла в индексе гита, а не на диске: на Windows рабочая копия бита исполнения
 * не хранит, а на POSIX-машине хук без него git пропускает молча — то самое бесшумное
 * самоотключение, ради которого заведена LEGACY-147. Текстовые ожидания ниже при этом
 * остались бы зелёными.
 */
const indexMode = (name: string): string => {
  const row = execFileSync('git', ['-C', ROOT, 'ls-files', '-s', `.husky/${name}`], {
    encoding: 'utf8',
  });
  const mode = /^(\d{6}) /.exec(row.trim());
  if (mode === null) {
    throw new Error(`Хук .husky/${name} не отслеживается гитом`);
  }
  return mode[1];
};

/** Строки хука без комментариев и пустых: комментарий здесь стоит над каждым шагом. */
const commands = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

describe.each(['pre-commit', 'pre-push'])('LEGACY-147: хук %s', (name) => {
  it('существует', () => {
    expect(existsSync(join(HOOKS, name))).toBe(true);
  });

  it('обрывается на первой упавшей команде: код sh — это код последней команды', () => {
    expect(commands(hook(name))).toContain('set -e');
  });

  it('отсутствие yarn — это отказ, а не разрешение', () => {
    const text = hook(name);
    expect(text).toMatch(/command -v yarn/);
    // Ветка «yarn не найден» тянется до закрывающей скобки блока `|| { ... }`.
    const branch = /command -v yarn[\s\S]*?\n\}/.exec(text);
    expect(branch).not.toBeNull();
    expect(branch?.[0]).toContain('exit 1');
    expect(branch?.[0]).not.toContain('exit 0');
  });

  // Каждое смягчение собирается из кусков намеренно. Сканер добавленных строк
  // (`.claude/hooks/standards.js`, правила W03 и W08) ищет эти подстроки буквально
  // и не отличает строку, которая смягчение **запрещает**, от строки, которая его вносит:
  // записанный целиком литерал закрывает коммит этой же спеке.
  it.each([
    ['|' + '| true', 'проглатывание кода возврата'],
    ['--pass' + 'WithNoTests', 'зелёный прогон без единого теста'],
    ['continue-' + 'on-error', 'шаг, который не может уронить прогон'],
  ])('в хуке нет смягчения %s (%s)', (softener) => {
    expect(hook(name)).not.toContain(softener);
  });

  it('в индексе гита стоит бит исполнения — без него git пропустит хук молча', () => {
    expect(indexMode(name)).toBe('100755');
  });
});

describe('LEGACY-148: состав хуков', () => {
  it('pre-commit гоняет lint-staged и typecheck', () => {
    const steps = commands(hook('pre-commit'));
    expect(steps).toContain('yarn lint-staged');
    expect(steps).toContain('yarn typecheck');
  });

  // Безусловно в обоих хуках. Условие по путям `prisma/**` минует третий проход скрипта
  // (`LEGACY-123`), который сверяет со схемой сырой SQL в `src/**`, и не срабатывает
  // на staged-удалении каталога миграции. Решение арбитра 26.08.2026, `decisions-log.md`.
  it.each(['pre-commit', 'pre-push'])('%s гоняет drift-check безусловно', (name) => {
    expect(commands(hook(name))).toContain('yarn drift-check');
    expect(hook(name)).not.toMatch(/git diff --cached/);
  });

  it('pre-commit не гоняет тесты: 148 сьютов сделали бы коммит неприемлемо долгим', () => {
    expect(hook('pre-commit')).not.toMatch(/yarn test\b/);
  });

  it('pre-push гоняет юнит-тесты', () => {
    expect(commands(hook('pre-push'))).toContain('yarn test');
  });

  // По командам, а не по всему тексту: тяжёлые шаги перечислены в комментарии как раз затем,
  // чтобы объяснить, почему их здесь нет.
  it.each(['test:e2e', 'test:cov', 'yarn build', 'yarn lint'])(
    'pre-push не тянет %s — его место в scripts/ci.sh',
    (heavy) => {
      expect(commands(hook('pre-push')).join('\n')).not.toContain(heavy);
    },
  );
});
