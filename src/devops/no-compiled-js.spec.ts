import { relative, resolve, sep } from 'node:path';

import { SRC_ROOT, listFiles, relativeToSrc } from '../common/testing/controller-decorators';

/**
 * Сторож `LEGACY-388`: ни под `src/**`, ни под `test/**` не лежит ни одного `.js`.
 *
 * `books/package.json` объявляет `jest.moduleFileExtensions: ["js", "json", "ts"]` —
 * `js` **раньше** `ts`. Поэтому безрасширенный импорт `from './controller-decorators'`
 * резолвится в скомпилированный `.js`, если такой оказался рядом с исходником,
 * а `transform` (`"^.+\.(t|j)s$": "ts-jest"`) принимает его наравне с `.ts`.
 * Появляется такой файл от одного `npx tsc <файл>` без `--noEmit` — от обычной
 * разовой сверки типов по одному файлу.
 *
 * 🔴 Дальше его не видит никто. В `.gitignore` компиляционный выхлоп назван только
 * каталогами (`/dist`, `/dist-test`, `/build`), в запретных границах диффа
 * (`.claude/hooks/rules.books.json`) до 15.09.2026 глоба `src/**\/*.js` не было,
 * а `eslint` до незаведённого в гит файла не доходит. Файл остаётся untracked,
 * на дифф не влияет — и читается jest при каждом прогоне.
 *
 * Цена: общая оснастка разбора контроллеров (`src/common/testing/`) — единственный
 * вход тринадцати сторожей и одной e2e-спеки. Замороженная копия делает их зелёными,
 * **не исполнив текущего кода**: правка `stripLiterals`, расширение `VERBS`, новый
 * признак гварда до прогона не доедут. `yarn test:cov` идёт в обеих ветках выката
 * (`scripts/ci.sh`, `deploy.yml`), то есть гейт остаётся зелёным по факту
 * неисполнения — тот же класс, что `LEGACY-294`.
 *
 * 🔴 Это не теория. 14.09.2026 два таких файла (`controller-decorators.js`,
 * `module-registration.js`) лежали в дереве во время захода по `LEGACY-010`,
 * и первая проба на отказ нового сторожа прошла по ним, а не по спеке.
 *
 * ⚠️ Сторож берёт `listFiles` из того самого файла, который и подменяется
 * скомпилированной копией, — и это осознанно, а не недосмотр. Обе копии перечисляют
 * диск одинаково, поэтому подменённый хелпер найдёт и вернёт в том числе
 * `controller-decorators.js`: сторож краснеет на собственной болезни. Писать здесь
 * девятую рукописную копию `readdirSync` ради мнимой независимости запрещено
 * (`LEGACY-290`).
 *
 * Три строки закрывают три разных пути, и ни одна не заменяет другую:
 * `src/**\/*.js` в `.gitignore` (файл не уедет в коммит случайно),
 * тот же глоб в `diffBoundaries.forbidden` (не уедет и намеренно),
 * и эта спека — единственная, кто видит untracked-файл.
 *
 * 🔴 **`test/` проверяется наравне с `src/`, и это не симметрия ради симметрии.**
 * `test/jest-e2e.json` несёт ровно такой же `moduleFileExtensions` с `js` впереди,
 * а e2e-спеки импортируют хелперы (`./helpers/...`) без расширения — то есть класс
 * там тот же самый. Разница в цене: до 15.09.2026 `test/**\/*.js` не был закрыт **ничем**,
 * поэтому такой файл не только подменял хелпер, но и уезжал в коммит незамеченным.
 * Пропустить его здесь значило бы закрыть половину класса и объявить запись закрытой.
 */
const TEST_ROOT = resolve(SRC_ROOT, '..', 'test');

const compiledJsUnderSrc = (): string[] =>
  listFiles(SRC_ROOT, (path) => path.endsWith('.js')).map(relativeToSrc);

const compiledJsUnderTest = (): string[] =>
  listFiles(TEST_ROOT, (path) => path.endsWith('.js')).map(
    (file) => `test/${relative(TEST_ROOT, file).split(sep).join('/')}`,
  );

describe('LEGACY-388: скомпилированный .js рядом с исходником', () => {
  it('под src/ нет ни одного .js — иначе jest читает его вместо исходника', () => {
    expect(compiledJsUnderSrc()).toEqual([]);
  });

  it('под test/ нет ни одного .js — у e2e тот же moduleFileExtensions', () => {
    expect(compiledJsUnderTest()).toEqual([]);
  });

  /**
   * Страховка от «проверено ноль единиц»: если обход перестанет что-либо находить,
   * оба сравнения с пустотой выше прошли бы молча и сторож стал бы зелен от пустоты.
   */
  it('обход вообще видит файлы — иначе пустота выше ничего не значит', () => {
    expect(listFiles(SRC_ROOT, (path) => path.endsWith('.ts')).length).toBeGreaterThan(100);
    expect(listFiles(TEST_ROOT, (path) => path.endsWith('.ts')).length).toBeGreaterThan(10);
  });
});
