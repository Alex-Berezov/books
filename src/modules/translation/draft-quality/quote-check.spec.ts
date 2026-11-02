import { findVerbatim, indexChapters, paragraphsOf, quoteInChapter } from './quote-check';

/**
 * Общая дословность цитат и правило абзаца (`F06-1`, вынос из заготовки анализа `F05-11` без смены
 * поведения): прямые проверки модуля, а не только через обёртку анализа.
 */

describe('paragraphsOf', () => {
  it('splits by an empty line, trims the edges, drops blank paragraphs; CRLF and spaces count as empty', () => {
    expect(paragraphsOf('  One.  \n\nTwo.\r\n\r\nThree.\n \n\n')).toEqual([
      'One.',
      'Two.',
      'Three.',
    ]);
    expect(paragraphsOf('   ')).toEqual([]);
    expect(paragraphsOf('')).toEqual([]);
  });
});

describe('findVerbatim', () => {
  const paragraphs = [
    ...indexChapters(new Map([[1, '  Anna  said: «Go home.»  \n\nBob left.']])).values(),
  ].flat();

  it('returns the fragment as in the reader, edges of the paragraph do not shift it', () => {
    expect(findVerbatim('Anna said: "Go home."', paragraphs)).toBe('Anna  said: «Go home.»');
    expect(findVerbatim('Bob left.', paragraphs)).toBe('Bob left.');
  });

  it('an empty quote or one across paragraphs is not found', () => {
    expect(findVerbatim('  ', paragraphs)).toBeNull();
    expect(findVerbatim('home.» Bob', paragraphs)).toBeNull();
  });
});

describe('quoteInChapter', () => {
  const chapters = indexChapters(new Map([[2, 'The  long   quote here.']]));

  it('collapses the spaces of a fragment only when it is longer than the given limit', () => {
    expect(quoteInChapter('The long quote here.', 2, chapters, 100)).toEqual({
      text: 'The  long   quote here.',
    });
    expect(quoteInChapter('The long quote here.', 2, chapters, 20)).toEqual({
      text: 'The long quote here.',
    });
  });

  it('names why a quote is not taken', () => {
    expect(quoteInChapter('x', 0, chapters, 100)).toEqual({ reason: 'NO_CHAPTER' });
    expect(quoteInChapter('x', 9, chapters, 100)).toEqual({ reason: 'CHAPTER_MISSING' });
    expect(quoteInChapter('missing', 2, chapters, 100)).toEqual({ reason: 'NOT_FOUND' });
  });
});
