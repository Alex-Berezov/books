import { DraftRemark } from '../draft-quality/text-checks';
import { checkLength, checkStructure, lengthBounds, sectionTitle } from './summary-checks';

/**
 * Объём, строй и название раздела пересказа (`F06-1`; `product.md` §2, §3): каждая проверка
 * краснеет на своём испорченном входе и молчит на чистом.
 */

const codes = (remarks: readonly DraftRemark[]) => remarks.map((r) => r.code);
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ') + '.';
/** Текст из `count` абзацев по `per` слов. */
const paragraphs = (count: number, per: number) =>
  Array.from({ length: count }, () => words(per)).join('\n\n');

describe('LENGTH_OUT', () => {
  it('a section of 250-700 words passes, outside is a remark', () => {
    expect(checkLength('section', words(250), 5_000)).toEqual([]);
    expect(checkLength('section', words(700), 5_000)).toEqual([]);
    expect(codes(checkLength('section', words(249), 5_000))).toEqual(['LENGTH_OUT']);
    expect(codes(checkLength('section', words(701), 5_000))).toEqual(['LENGTH_OUT']);
  });

  it('a chapter of 600 words with a section of 200 words is not LENGTH_OUT; longer than the chapter is', () => {
    expect(checkLength('section', words(200), 600)).toEqual([]);
    expect(codes(checkLength('section', words(199), 600))).toEqual(['LENGTH_OUT']);
    expect(codes(checkLength('section', words(601), 600))).toEqual(['LENGTH_OUT']);
  });

  it('an empty text is always out of bounds, also for a chapter without words', () => {
    expect(codes(checkLength('section', '', 0))).toEqual(['LENGTH_OUT']);
    expect(codes(checkLength('section', '', 5_000))).toEqual(['LENGTH_OUT']);
  });

  it('the short-chapter rule ends at 750 words of chapter text', () => {
    expect(lengthBounds('section', 749)).toEqual({ min: 250, max: 749 });
    expect(lengthBounds('section', 750)).toEqual({ min: 250, max: 700 });
  });

  it('the full summary bounds only go down with the sections', () => {
    expect(lengthBounds('full', 10_000)).toEqual({ min: 2_300, max: 4_600 });
    expect(lengthBounds('full', 3_000)).toEqual({ min: 1_800, max: 3_000 });
    expect(codes(checkLength('full', words(1_799), 3_000))).toEqual(['LENGTH_OUT']);
  });

  it('the very short summary: 600-1200 from a full of 2400, otherwise a quarter to a half', () => {
    expect(lengthBounds('brief', 2_400)).toEqual({ min: 600, max: 1_200 });
    expect(lengthBounds('brief', 2_000)).toEqual({ min: 500, max: 1_000 });
    expect(checkLength('brief', paragraphs(6, 100), 2_400)).toEqual([]);
  });

  it('the very short summary keeps 5-10 paragraphs, from 3 under 600 words', () => {
    expect(codes(checkLength('brief', paragraphs(4, 160), 2_400))).toEqual(['LENGTH_OUT']);
    expect(codes(checkLength('brief', paragraphs(11, 60), 2_400))).toEqual(['LENGTH_OUT']);
    expect(checkLength('brief', paragraphs(3, 100), 1_000)).toEqual([]);
    expect(codes(checkLength('brief', paragraphs(2, 150), 1_000))).toEqual(['LENGTH_OUT']);
  });

  it('the very short summary counts paragraphs by the subheading rule of the structure check (F06-2, хвост F06-1)', () => {
    // Десять абзацев, в одном строка «## » без пустой строки рядом: по `blocksOf` это три блока,
    // и абзацев двенадцать - больше предела; `paragraphsOf` насчитал бы десять.
    const glued = `${words(30)}\n## Part\n${words(30)}`;
    const text = [glued, ...Array.from({ length: 9 }, () => words(70))].join('\n\n');
    expect(codes(checkLength('brief', text, 2_400))).toEqual(['LENGTH_OUT']);
  });
});

describe('STRUCTURE_BROKEN', () => {
  const short = 'Anna leaves the house.';
  const body = (n: number) =>
    Array.from({ length: n }, (_, i) => `## Part ${i + 1}\n\nAnna goes on.`).join('\n\n');

  it('a first sentence longer than 160 characters is a remark', () => {
    const long = `${'Anna '.repeat(40).trim()} leaves.`;
    expect(codes(checkStructure({ target: 'section' }, long))).toEqual(['STRUCTURE_BROKEN']);
    expect(checkStructure({ target: 'section' }, `${short} Then the rain starts.`)).toEqual([]);
  });

  const full = (sections: number) => ({ target: 'full' as const, sections });

  it('the full summary of a long book: an introduction and 4-10 subheadings', () => {
    expect(checkStructure(full(8), `${short}\n\n${body(4)}`)).toEqual([]);
    expect(checkStructure(full(8), `${short}\n\n${body(10)}`)).toEqual([]);
    expect(codes(checkStructure(full(8), `${short}\n\n${body(3)}`))).toEqual(['STRUCTURE_BROKEN']);
    expect(codes(checkStructure(full(8), `${short}\n\n${body(11)}`))).toEqual(['STRUCTURE_BROKEN']);
    expect(codes(checkStructure(full(8), body(5)))).toEqual(['STRUCTURE_BROKEN']);
  });

  it('a subheading glued to the paragraph above by one line break still counts', () => {
    const glued = `${short}\n## Part 1\n\nOne.\n## Part 2\nTwo.\n\n## Part 3\n\nThree.\n\n## Part 4\n\nFour.`;
    expect(checkStructure(full(8), glued)).toEqual([]);
    expect(codes(checkStructure(full(8), `## Part 1\n${short}\n\n${body(4)}`))).toEqual([
      'STRUCTURE_BROKEN',
    ]);
  });

  it('the full summary of a book of 1-3 sections has no subheadings; from 4 sections it has them', () => {
    expect(checkStructure(full(3), `${short}\n\nAnna goes on.`)).toEqual([]);
    expect(codes(checkStructure(full(3), `${short}\n\n${body(1)}`))).toEqual(['STRUCTURE_BROKEN']);
    expect(checkStructure(full(4), `${short}\n\n${body(4)}`)).toEqual([]);
    expect(codes(checkStructure(full(4), `${short}\n\nAnna goes on.`))).toEqual([
      'STRUCTURE_BROKEN',
    ]);
  });

  it('a section has no subheadings', () => {
    expect(codes(checkStructure({ target: 'section' }, `${short}\n\n## Part\n\nMore.`))).toEqual([
      'STRUCTURE_BROKEN',
    ]);
  });

  it('the very short summary has no subheadings', () => {
    expect(codes(checkStructure({ target: 'brief' }, `${short}\n\n## Part\n\nMore.`))).toEqual([
      'STRUCTURE_BROKEN',
    ]);
    expect(checkStructure({ target: 'brief' }, `${short}\n\nMore.`)).toEqual([]);
  });
});

describe('sectionTitle (§2.1)', () => {
  it('one chapter - its title as in the reader; several - first – last', () => {
    expect(sectionTitle([{ number: 1, title: 'Part One' }], 'en')).toBe('Part One');
    expect(
      sectionTitle(
        [
          { number: 3, title: 'The Storm' },
          { number: 2, title: 'The House' },
        ],
        'en',
      ),
    ).toBe('The House – The Storm');
  });

  it('chapters without a title - the form of the version language, for one and for a range', () => {
    const one = [{ number: 5, title: '' }];
    const two = [
      { number: 5, title: '' },
      { number: 7, title: ' ' },
    ];
    expect(sectionTitle(one, 'ru')).toBe('Глава 5');
    expect(sectionTitle(one, 'en')).toBe('Chapter 5');
    expect(sectionTitle(one, 'es')).toBe('Capítulo 5');
    expect(sectionTitle(one, 'fr')).toBe('Chapitre 5');
    expect(sectionTitle(one, 'pt')).toBe('Capítulo 5');
    expect(sectionTitle(two, 'ru')).toBe('Главы 5–7');
    expect(sectionTitle(two, 'en')).toBe('Chapters 5–7');
    expect(sectionTitle(two, 'es')).toBe('Capítulos 5–7');
    expect(sectionTitle(two, 'fr')).toBe('Chapitres 5–7');
    expect(sectionTitle(two, 'pt')).toBe('Capítulos 5–7');
  });

  it('a range with one titled end keeps the titled form for both ends', () => {
    expect(
      sectionTitle(
        [
          { number: 1, title: 'Prologue' },
          { number: 2, title: '' },
        ],
        'en',
      ),
    ).toBe('Prologue – Chapter 2');
  });
});
