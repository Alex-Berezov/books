import { createHash } from 'node:crypto';
import {
  fingerprintOfChapters,
  stalePaths,
  worldChapterIssues,
  worldChapterItems,
  worldCompareKey,
  worldItemKey,
} from './world-quote-check';

describe('worldChapterItems (F08-2) — единственный обход пунктов с главой', () => {
  it('этапы пути, сцены и цитаты с путями и ключами по содержанию; пункт без главы пропущен', () => {
    const items = worldChapterItems({
      arc: {
        from: 'a',
        to: 'b',
        stages: [
          { title: 't', text: 'x', chapter: 4 },
          { title: 'no chapter', text: 'y', chapter: null as unknown as number },
        ],
      },
      scenes: [{ chapter: 2, title: 's', text: 'scene' }],
      quotes: [{ text: 'Q', chapter: 1, interpretation: 'I' }],
    });
    expect(items.map(({ path, chapter, kind }) => ({ path, chapter, kind }))).toEqual([
      { path: 'arc.stages.0', chapter: 4, kind: 'arc.stages' },
      { path: 'scenes.0', chapter: 2, kind: 'scenes' },
      { path: 'quotes.0', chapter: 1, kind: 'quotes' },
    ]);
    expect(items[2].key).toBe(worldItemKey('quotes', { chapter: 1, text: 'Q' }));
    expect(items[2].text).toBe('Q');
  });
});

describe('fingerprintOfChapters (F08-2, решение арбитра R3b)', () => {
  it('md5 строки «номер:md5» по главам через запятую — формат один с SQL versionFingerprint', () => {
    const md5 = (v: string) => createHash('md5').update(v, 'utf8').digest('hex');
    expect(
      fingerprintOfChapters([
        { number: 1, digest: 'aa' },
        { number: 2, digest: 'bb' },
      ]),
    ).toBe(md5('1:aa,2:bb'));
    // Пустая версия — md5 пустой строки, как coalesce(string_agg(...), '') в базе.
    expect(fingerprintOfChapters([])).toBe(md5(''));
  });
});

describe('строка сравнения пары (F08-8c): две главы, один ключ', () => {
  const row = { feature: 'F', a: 'A', chapterA: 1, b: 'B', chapterB: 9 };
  const entity = { arc: null, scenes: null, quotes: null, compare: [row] };

  it('worldChapterItems: пункт на главу каждой стороны, поле главы и общий ключ строки', () => {
    expect(worldChapterItems(entity)).toEqual([
      {
        kind: 'compare',
        path: 'compare.0',
        field: 'chapterA',
        key: worldCompareKey(row),
        chapter: 1,
        text: 'A',
      },
      {
        kind: 'compare',
        path: 'compare.0',
        field: 'chapterB',
        key: worldCompareKey(row),
        chapter: 9,
        text: 'B',
      },
    ]);
  });

  it('глава одной стороны не из версии — отказ путём её поля; stalePaths — строка один раз', () => {
    const issues = worldChapterIssues(
      entity,
      (n) => n !== 9,
      () => true,
    );
    expect(issues.map((i) => `${i.item}.${i.field}`)).toEqual(['compare.0.chapterB']);
    expect(stalePaths(entity, new Set([worldCompareKey(row)]))).toEqual(['compare.0']);
  });

  it('worldCompareKey: поля разделены — разные строки не совпадают ключом', () => {
    const x = worldCompareKey({ feature: 'F', a: 'x', chapterA: 1, b: '3', chapterB: 12 });
    const y = worldCompareKey({ feature: 'F', a: 'x1', chapterA: 1, b: '3', chapterB: 2 });
    expect(x).not.toBe(y);
  });
});
