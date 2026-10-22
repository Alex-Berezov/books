import { splitChapter } from '../chapter-blocks';
import {
  CHUNK_MAX_WORDS,
  CHUNK_MIN_WORDS,
  ContestedWindow,
  fallbackBoundary,
  planChunks,
} from './chapter-chunks';

const words = (count: number, word = 'word') => Array.from({ length: count }, () => word).join(' ');
const p = (text: string) => `<p>${text}</p>`;

describe('planChunks', () => {
  it('cuts a 10 000-word chapter into chunks inside the corridor', async () => {
    const html = Array.from({ length: 100 }, () => p(words(100))).join('');
    const chunks = await planChunks(splitChapter(html));
    expect(chunks.reduce((sum, c) => sum + c.words, 0)).toBe(10_000);
    for (const chunk of chunks) {
      expect(chunk.words).toBeGreaterThanOrEqual(CHUNK_MIN_WORDS);
      expect(chunk.words).toBeLessThanOrEqual(CHUNK_MAX_WORDS);
    }
    // Куски идут подряд и покрывают главу.
    chunks.forEach((c, i) => {
      expect(c.firstBlock).toBe(i === 0 ? 1 : chunks[i - 1].lastBlock + 1);
    });
    expect(chunks[chunks.length - 1].lastBlock).toBe(100);
  });

  it('keeps a chapter shorter than the corridor as one chunk', async () => {
    const chunks = await planChunks(splitChapter(p(words(800)) + p(words(400))));
    expect(chunks).toEqual([{ firstBlock: 1, lastBlock: 2, words: 1_200 }]);
  });

  it('prefers a scene separator and does not ask the model', async () => {
    const html =
      Array.from({ length: 18 }, () => p(words(100))).join('') +
      '<hr>' +
      Array.from({ length: 18 }, () => p(words(100))).join('');
    const pick = jest.fn();
    const chunks = await planChunks(splitChapter(html), pick);
    expect(pick).not.toHaveBeenCalled();
    // Блок 19 - `hr`: кусок кончается на нём.
    expect(chunks[0]).toEqual({ firstBlock: 1, lastBlock: 19, words: 1_800 });
  });

  it('treats "***" and an empty paragraph as scene separators', async () => {
    const stars =
      Array.from({ length: 20 }, () => p(words(100))).join('') +
      p('* * *') +
      Array.from({ length: 16 }, () => p(words(100))).join('');
    expect((await planChunks(splitChapter(stars), jest.fn()))[0].lastBlock).toBe(21);

    const empty =
      Array.from({ length: 17 }, () => p(words(100))).join('') +
      '<p>&nbsp;</p>' +
      Array.from({ length: 19 }, () => p(words(100))).join('');
    expect((await planChunks(splitChapter(empty), jest.fn()))[0].lastBlock).toBe(17);
  });

  it('does not tear a dialogue line from the previous one', async () => {
    // Все стыки окна - перед репликой, кроме одного: код берёт его.
    const html =
      Array.from({ length: 15 }, () => p(words(100))).join('') +
      Array.from({ length: 10 }, (_, i) => p(i === 6 ? words(100) : `— ${words(99)}`)).join('') +
      Array.from({ length: 30 }, () => p(words(100))).join('');
    const chunks = await planChunks(splitChapter(html));
    const boundary = chunks[0].lastBlock + 1;
    expect(splitChapter(html).blocks[boundary - 1].html.startsWith('—')).toBe(false);
  });

  it('asks the model for a contested joint and takes its answer', async () => {
    const html = Array.from({ length: 40 }, () => p(words(100))).join('');
    const pick = jest.fn((w: ContestedWindow) => Promise.resolve(w.candidates[2].block));
    const chunks = await planChunks(splitChapter(html), pick);
    const window = pick.mock.calls[0][0];
    expect(window.candidates[0]).toMatchObject({ words: 1_500, beforeDialogue: false });
    expect(window.candidates[0].head).toBe(words(12));
    expect(chunks[0].lastBlock).toBe(window.candidates[2].block - 1);
  });

  it('a model answer before a dialogue line is replaced by the code boundary', async () => {
    // Окно 1500-3000 слов: блоки 16-21 - реплики, 22 и дальше - повествование.
    const html =
      Array.from({ length: 15 }, () => p(words(100))).join('') +
      Array.from({ length: 6 }, () => p(`— ${words(99)}`)).join('') +
      Array.from({ length: 30 }, () => p(words(100))).join('');
    const chunks = await planChunks(splitChapter(html), (w) =>
      Promise.resolve(w.candidates.find((c) => c.beforeDialogue)?.block ?? 0),
    );
    const next = splitChapter(html).blocks[chunks[0].lastBlock];
    expect(next.html.startsWith('—')).toBe(false);
  });

  it('falls back to the code boundary when the model answers outside the window', async () => {
    const html = Array.from({ length: 40 }, () => p(words(100))).join('');
    const chunks = await planChunks(splitChapter(html), () => Promise.resolve(999));
    // Середина коридора - 2250 слов: ближайший кандидат - 2200 или 2300, первый по порядку.
    expect(chunks[0].words).toBe(2_200);
  });

  it('does not glue a block longer than the corridor to the short blocks before it', async () => {
    const chunks = await planChunks(splitChapter(p(words(100)) + p(words(3_500)) + p(words(100))));
    expect(chunks.map((c) => c.words)).toEqual([100, 3_500, 100]);
    expect(chunks.every((c, i) => i !== 0 || c.words <= CHUNK_MAX_WORDS)).toBe(true);
  });

  it('keeps a block longer than the corridor as its own chunk', async () => {
    const chunks = await planChunks(splitChapter(p(words(4_000)) + p(words(2_000))));
    expect(chunks).toEqual([
      { firstBlock: 1, lastBlock: 1, words: 4_000 },
      { firstBlock: 2, lastBlock: 2, words: 2_000 },
    ]);
  });
});

describe('fallbackBoundary', () => {
  it('skips a candidate before dialogue when an allowed one exists', () => {
    expect(
      fallbackBoundary({
        candidates: [
          { block: 5, words: 2_250, beforeDialogue: true, head: '' },
          { block: 7, words: 2_900, beforeDialogue: false, head: '' },
        ],
      }),
    ).toBe(7);
  });
});
