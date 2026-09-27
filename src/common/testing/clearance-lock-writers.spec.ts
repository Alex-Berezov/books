import { readFileSync } from 'fs';
import {
  SRC_ROOT,
  closingParen,
  listFiles,
  relativeToSrc,
  topLevelArgs,
} from './controller-decorators';

/**
 * Сторож писателей пометки stale со своей транзакцией (`LEGACY-368`, T56).
 *
 * Пометка с чужим `tx` пишет свою версию, проверку прав и профиль внутри транзакции
 * вызывающего. Замок группы клиренса обязан быть взят первым оператором этой транзакции —
 * иначе со встречной правкой главы соседней версии получается цикл 40P01. Путь без `tx`
 * после решения владельца от 27.09.2026 пишет одну строку версии без фан-аута и замка не берёт;
 * путь с `tx` держит только место вызова,
 * а компилятор его не видит: `Prisma.TransactionClient` из голой `$transaction` подходит так же.
 *
 * Поэтому здесь две проверки: каждый вызов с `tx` лежит **внутри** колбэка
 * `runInLockedClearance(` / `runInLockedClearanceScope(`, и перечень таких мест заморожен —
 * новое место роняет спеку и требует решения, а не проходит зелёным.
 */

/** Писатель пометки и позиция аргумента `tx` (с нуля). */
const WRITERS: Record<string, number> = {
  checkVersionStaleness: 4,
  logContentChangeForRightsProfile: 5,
};

/** Сам сервис пересчёта пробрасывает `tx` вызывающего насквозь — его вызовы не места записи. */
const FORWARDING_FILE = 'modules/rights-intake/rights-content-hash.service.ts';

const LOCK_RE = /\.runInLockedClearance(?:Scope)?\(/g;
const CALL_RE = new RegExp(`\\.(${Object.keys(WRITERS).join('|')})\\(`, 'g');

type WriterCall = { writer: string; txArg: string | null; locked: boolean; line: number };

/**
 * Вызовы писателей пометки в тексте файла: чем передан `tx` (или `null`) и лежит ли вызов внутри
 * колбэка замка. Одна функция на сторожа и его самопроверку — проверяется то, что исполняется.
 */
const scanWriterCalls = (text: string): WriterCall[] => {
  const lockSpans = [...text.matchAll(LOCK_RE)].map((match) => {
    const open = match.index + match[0].length - 1;
    return [open, closingParen(text, open)] as const;
  });
  return [...text.matchAll(CALL_RE)].map((match) => {
    const writer = match[1];
    const open = match.index + match[0].length - 1;
    const args = topLevelArgs(text, open, closingParen(text, open));
    const at = match.index;
    return {
      writer,
      txArg: args[WRITERS[writer]] ?? null,
      locked: lockSpans.some(([start, end]) => start < at && at < end),
      line: text.slice(0, at).split('\n').length,
    };
  });
};

type Site = { file: string; writer: string; count: number; why: string };

/** Замороженный перечень: место записи с `tx` — файл, писатель, число вызовов. */
const EXPECTED: Site[] = [
  {
    file: 'modules/chapter/chapter.service.ts',
    writer: 'checkVersionStaleness',
    count: 3,
    why: 'создание, правка и удаление главы — строки главы и пометка версии в одной транзакции под замком',
  },
  {
    file: 'modules/audio-chapter/audio-chapter.service.ts',
    writer: 'checkVersionStaleness',
    count: 4,
    why: 'создание, правка, удаление и перестановка аудиоглав — под замком группы версии',
  },
  {
    file: 'modules/book-version/book-version.service.ts',
    writer: 'checkVersionStaleness',
    count: 4,
    why: 'правка версии и три ручки участников версии — строка версии пишется до пометки, замок первым',
  },
];

describe('писатели пометки stale с tx идут под замком клиренса (LEGACY-368)', () => {
  const found = new Map<string, number>();
  const outsideLock: string[] = [];

  beforeAll(() => {
    const sources = listFiles(
      SRC_ROOT,
      (path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'),
    );

    for (const file of sources) {
      const rel = relativeToSrc(file);
      if (rel === FORWARDING_FILE) continue;
      for (const call of scanWriterCalls(readFileSync(file, 'utf8'))) {
        if (call.txArg === null) continue;
        const key = `${rel}::${call.writer}`;
        found.set(key, (found.get(key) ?? 0) + 1);
        if (!call.locked) {
          outsideLock.push(`${rel}:${call.line} ${call.writer}(…, ${call.txArg}) вне замка`);
        }
      }
    }
  });

  it('каждый вызов с tx лежит внутри колбэка runInLockedClearance(Scope)', () => {
    expect(outsideLock).toEqual([]);
  });

  it('перечень мест записи с tx совпадает с замороженным', () => {
    const actual = Object.fromEntries([...found.entries()].sort());
    const expected = Object.fromEntries(
      EXPECTED.map(({ file, writer, count }) => [`${file}::${writer}`, count] as const).sort(),
    );

    // Новое место — не дописывай строку, пока не убедился, что замок взят первым оператором
    // транзакции: строка версии, тронутая до замка, возвращает цикл.
    expect(actual).toEqual(expected);
  });

  it('у каждого места перечня названа причина', () => {
    for (const site of EXPECTED) expect(site.why.length).toBeGreaterThan(20);
  });

  it('разбор видит вызов вне замка и не путает скобки и запятые в строках и комментариях', () => {
    const text = [
      "await this.lock.runInLockedClearance(id, async (tx) => { log('(');",
      '  await this.hash.checkVersionStaleness(id, "X", null, true, tx);',
      '});',
      'await this.hash.checkVersionStaleness(id, "Y)", null, true, tx);',
      'await this.hash.checkVersionStaleness(id, "Z", null, true);',
      'await this.hash.checkVersionStaleness(id, trigger, // см. (T56, ещё',
      '  null, true, tx);',
    ].join('\n');

    expect(scanWriterCalls(text)).toEqual([
      { writer: 'checkVersionStaleness', txArg: 'tx', locked: true, line: 2 },
      { writer: 'checkVersionStaleness', txArg: 'tx', locked: false, line: 4 },
      { writer: 'checkVersionStaleness', txArg: null, locked: false, line: 5 },
      { writer: 'checkVersionStaleness', txArg: 'tx', locked: false, line: 6 },
    ]);
  });
});
