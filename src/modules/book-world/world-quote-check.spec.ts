import { createHash } from 'node:crypto';
import { fingerprintOfChapters, worldChapterItems, worldItemKey } from './world-quote-check';

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
