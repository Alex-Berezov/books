import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { splitChapter } from '../chapter-blocks';
import { AssemblyChunk, assembleTranslatedChapter } from './chapter-assembly';

const CHAPTER =
  '<h2>Chapter I</h2><p>First paragraph.</p><p>Second paragraph.</p><hr /><p>Third paragraph.</p>';

/** Перевод «на испанский» - блок с меткой: собранная глава показывает, откуда взят текст. */
function translated(n: number, text = `ES ${n}`) {
  return { n, text };
}

function chunk(
  chunkIndex: number,
  firstBlock: number,
  lastBlock: number,
  overrides: Partial<AssemblyChunk> = {},
): AssemblyChunk {
  const blocks: Array<{ n: number; text: string }> = [];
  for (let n = firstBlock; n <= lastBlock; n++) if (n !== 4) blocks.push(translated(n));
  return {
    chunkIndex,
    firstBlock,
    lastBlock,
    status: 'done',
    blocks,
    flagReason: null,
    ...overrides,
  };
}

describe('assembleTranslatedChapter', () => {
  const layout = splitChapter(CHAPTER);

  it('puts the translated blocks in place and keeps the shell and the scene break', () => {
    const result = assembleTranslatedChapter(layout, [chunk(0, 1, 2), chunk(1, 3, 5)]);
    expect(result).toMatchObject({ status: 'assembled', flagReason: null, findings: [] });
    if (result.status !== 'assembled') throw new Error('not assembled');
    expect(result.content).toBe('<h2>ES 1</h2><p>ES 2</p><p>ES 3</p><hr /><p>ES 5</p>');
    expect(result.length).toBe(result.content.length);
  });

  it('cleans the assembled chapter with the same sanitizer as a manual save', () => {
    const result = assembleTranslatedChapter(layout, [
      chunk(0, 1, 2, { blocks: [translated(1), translated(2, 'ES <script>x</script>2')] }),
      chunk(1, 3, 5),
    ]);
    if (result.status !== 'assembled') throw new Error('not assembled');
    expect(result.content).not.toContain('script');
  });

  it('flags a chapter longer than the limit and does not assemble it (Р8)', () => {
    const long = 'x'.repeat(RICH_HTML_MAX_LENGTH.body);
    const result = assembleTranslatedChapter(layout, [
      chunk(0, 1, 2, { blocks: [translated(1), translated(2, long)] }),
      chunk(1, 3, 5),
    ]);
    expect(result.status).toBe('flagged');
    expect(result.flagReason).toBe('CHAPTER_TOO_LONG');
    expect(result.length).toBeGreaterThan(RICH_HTML_MAX_LENGTH.body);
  });

  it('flags a repeated block on a seam with the seam number', () => {
    const result = assembleTranslatedChapter(layout, [
      chunk(0, 1, 2, { blocks: [translated(1), translated(2, 'El segundo párrafo del texto')] }),
      chunk(1, 3, 5, { blocks: [translated(3, 'El segundo párrafo del texto'), translated(5)] }),
    ]);
    expect(result).toMatchObject({
      status: 'assembled',
      flagReason: 'SEAM_REPEAT',
      seamIndex: 1,
      findings: [{ code: 'SEAM_REPEAT', seam: 1 }],
    });
  });

  it('flags the next piece starting with the tail of the previous one', () => {
    const tail = 'The tail of the previous piece, long enough';
    const result = assembleTranslatedChapter(layout, [
      chunk(0, 1, 2, { blocks: [translated(1), translated(2, tail)] }),
      chunk(1, 3, 5, { blocks: [translated(3, `${tail} and then the third.`), translated(5)] }),
    ]);
    expect(result.flagReason).toBe('SEAM_REPEAT');
  });

  it('a repeat that is in the source is not a seam flag', () => {
    const same = splitChapter('<p>Again.</p><p>Again.</p>');
    const result = assembleTranslatedChapter(same, [
      chunk(0, 1, 1, { blocks: [translated(1, 'Otra vez.')] }),
      chunk(1, 2, 2, { blocks: [translated(2, 'Otra vez.')] }),
    ]);
    expect(result).toMatchObject({ status: 'assembled', flagReason: null });
  });

  it('a flagged piece with a translation goes into the chapter with a flag', () => {
    const result = assembleTranslatedChapter(layout, [
      chunk(0, 1, 2, { status: 'flagged', flagReason: 'SEMANTIC_FAIL' }),
      chunk(1, 3, 5),
    ]);
    expect(result).toMatchObject({
      status: 'assembled',
      flagReason: 'CHUNK_FLAGGED',
      findings: [{ code: 'CHUNK_FLAGGED', chunkIndex: 0, chunkReason: 'SEMANTIC_FAIL' }],
    });
  });

  it('a piece without a translation keeps the chapter out of the draft, no source fallback', () => {
    const result = assembleTranslatedChapter(layout, [
      chunk(0, 1, 2),
      chunk(1, 3, 5, { status: 'flagged', flagReason: 'CHUNK_TOO_LONG', blocks: null }),
    ]);
    expect(result).toMatchObject({
      status: 'flagged',
      flagReason: 'CHUNK_UNTRANSLATED',
      findings: [{ code: 'CHUNK_UNTRANSLATED', chunkIndex: 1 }],
    });
  });

  it.each([
    ['a hole between pieces', [chunk(0, 1, 2), chunk(1, 4, 5)]],
    ['a missing tail', [chunk(0, 1, 2), chunk(1, 3, 4)]],
    ['pieces out of order', [chunk(0, 1, 2), chunk(2, 3, 5)]],
    ['no pieces', []],
  ])('pieces that do not cover the chapter - CHUNKS_MISMATCH: %s', (_name, chunks) => {
    expect(assembleTranslatedChapter(layout, chunks)).toMatchObject({
      status: 'flagged',
      flagReason: 'CHUNKS_MISMATCH',
    });
  });

  it('an empty source chapter is an empty chapter without a flag', () => {
    const empty = splitChapter('');
    const result = assembleTranslatedChapter(empty, [chunk(0, 0, 0, { blocks: [] })]);
    expect(result).toMatchObject({ status: 'assembled', flagReason: null, length: 0 });
  });

  it('a chapter of exactly the limit is assembled, one character more is flagged (Р8)', () => {
    const one = splitChapter('<p>Source.</p>');
    const shell = '<p></p>'.length;
    const at = (length: number) =>
      assembleTranslatedChapter(one, [
        chunk(0, 1, 1, { blocks: [translated(1, 'x'.repeat(length - shell))] }),
      ]);
    expect(at(RICH_HTML_MAX_LENGTH.body)).toMatchObject({
      status: 'assembled',
      length: RICH_HTML_MAX_LENGTH.body,
    });
    expect(at(RICH_HTML_MAX_LENGTH.body + 1)).toMatchObject({
      status: 'flagged',
      flagReason: 'CHAPTER_TOO_LONG',
      length: RICH_HTML_MAX_LENGTH.body + 1,
    });
  });

  it('two different short source lines translated alike on a seam are not a repeat', () => {
    const lines = splitChapter('<p>Yes.</p><p>Sure.</p>');
    const result = assembleTranslatedChapter(lines, [
      chunk(0, 1, 1, { blocks: [translated(1, '¡Sí!')] }),
      chunk(1, 2, 2, { blocks: [translated(2, '¡Sí!')] }),
    ]);
    expect(result).toMatchObject({ status: 'assembled', flagReason: null });
  });

  it('the seam number is that of the seam with the repeat', () => {
    const three = splitChapter(
      '<p>First long paragraph of the source.</p><p>Second long paragraph of it.</p><p>Third long paragraph here.</p>',
    );
    const long = (n: number) => translated(n, `Párrafo largo número ${n} del texto`);
    const result = assembleTranslatedChapter(three, [
      chunk(0, 1, 1, { blocks: [long(1)] }),
      chunk(1, 2, 2, { blocks: [long(2)] }),
      chunk(2, 3, 3, { blocks: [{ n: 3, text: long(2).text }] }),
    ]);
    expect(result).toMatchObject({ flagReason: 'SEAM_REPEAT', seamIndex: 2 });
  });
});
