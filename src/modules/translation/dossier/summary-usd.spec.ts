import { Prisma } from '@prisma/client';
import { StageCallEstimator } from '../../llm/llm.service';
import { ANSWER_CHARS_PER_TOKEN } from '../../llm/openrouter.client';
import { SUMMARY_ITEM_WRAPPER_CHARS } from './dossier-groups';
import { summaryUsd } from './dossier-demand.service';

/**
 * Оценка сводки досье (`F05-12`): вызов стоит 1 цент плюс по центу за тысячу символов «ответов
 * прошлых шагов» - так по сумме видно и число вызовов, и входы, которые им насчитаны.
 */
const estimator = (maxTokens: number, contextLength: number | null) => {
  const extras: number[] = [];
  const call: StageCallEstimator = {
    maxTokens,
    enabled: true,
    contextLength,
    estimate: (_request, extraInputTokens = 0) => {
      extras.push(extraInputTokens);
      return new Prisma.Decimal(0.01).add(new Prisma.Decimal(extraInputTokens).div(100_000));
    },
  };
  return { call, extras };
};

const titles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `C${i + 1}` }));

describe('summaryUsd', () => {
  it('a single summary counts each answer with the JSON wrapper of its item and the comma', () => {
    const { call, extras } = estimator(2_000, null);
    summaryUsd(call, titles(2), 3, 2);
    expect(extras).toEqual([3 * (2_000 * ANSWER_CHARS_PER_TOKEN + SUMMARY_ITEM_WRAPPER_CHARS)]);
  });

  it('more chapters than a group may list: level 0 groups and a final summary, even when the input fits', () => {
    // maxTokens 16 000 - по 18 глав в группе: 250 глав - четырнадцать групп и итог.
    const { call, extras } = estimator(16_000, null);
    const usd = summaryUsd(call, titles(250), 250, 250);
    const item = 16_000 * ANSWER_CHARS_PER_TOKEN + SUMMARY_ITEM_WRAPPER_CHARS;
    // Групп сверху ⌊250/18⌋ + 1 = 14: тринадцать вызовов без входа кусков, один - с ответами всех
    // 250 кусков (группы делят куски), итог - из четырнадцати ответов групп.
    expect(extras).toEqual([0, 250 * item, 14 * item]);
    const call$ = (chars: number) =>
      new Prisma.Decimal(0.01).add(new Prisma.Decimal(chars).div(100_000));
    expect(usd.toString()).toBe(
      call$(0)
        .mul(13)
        .add(call$(250 * item))
        .add(call$(14 * item))
        .toString(),
    );
  });

  it('chapters up to the limit and an input that fits: one call; one chapter more - groups', () => {
    const at = estimator(16_000, null);
    summaryUsd(at.call, titles(18), 18, 18);
    expect(at.extras).toHaveLength(1);
    const over = estimator(16_000, null);
    summaryUsd(over.call, titles(19), 19, 19);
    expect(over.extras).toHaveLength(3);
  });

  it('a book over the chapter limit costs more than the same pieces in fewer chapters', () => {
    const many = estimator(16_000, null);
    const few = estimator(16_000, null);
    const grouped = summaryUsd(many.call, titles(250), 250, 250);
    const single = summaryUsd(few.call, titles(18), 250, 18);
    expect(grouped.gt(single)).toBe(true);
  });

  it('a known context: level 0 groups by the input, levels above by the input without chapter lists', () => {
    // maxTokens 2 000 (по 2 главы в группе), контекст 40 000: во вход влезает ~9 ответов.
    const { call, extras } = estimator(2_000, 40_000);
    const usd = summaryUsd(call, titles(60), 60, 60);
    const item = 2_000 * ANSWER_CHARS_PER_TOKEN + SUMMARY_ITEM_WRAPPER_CHARS;
    // Уровень 0: группы по главам (по 2) и входу вперемешку - вызовы без кусков плюс один со всеми.
    expect(extras[0]).toBe(0);
    expect(extras[1]).toBe(60 * item);
    // Уровни выше - вход из ответов групп по ёмкости уровня (не меньше двух), итог - остаток.
    const upper = extras.slice(2);
    expect(upper.length).toBeGreaterThanOrEqual(2);
    for (const chars of upper) {
      expect(chars % item).toBe(0);
      expect(chars / item).toBeGreaterThanOrEqual(2);
    }
    expect(usd.gt(new Prisma.Decimal(0))).toBe(true);
  });
});
