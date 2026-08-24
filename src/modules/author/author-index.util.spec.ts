import { Language } from '@prisma/client';
import {
  OTHER_LETTER,
  alphabetForLanguage,
  buildShortBio,
  indexLetterOf,
  isKnownLetter,
  sortLetters,
} from './author-index.util';

describe('author index', () => {
  describe('alphabetForLanguage', () => {
    it('gives Cyrillic for ru and Latin for the other four', () => {
      expect(alphabetForLanguage(Language.ru)[0]).toBe('А');
      for (const lang of [Language.en, Language.es, Language.fr, Language.pt]) {
        expect(alphabetForLanguage(lang)).toHaveLength(26);
        expect(alphabetForLanguage(lang)[0]).toBe('A');
      }
    });

    // Ъ, Ь, Ы не начинают имён и висели бы погашенными всегда; Ё свёрнута в Е
    // тем же правилом, которым É живёт под E.
    it('leaves Ё, Ъ, Ь and Ы out of the Russian index', () => {
      const ru = alphabetForLanguage(Language.ru);
      expect(ru).toHaveLength(29);
      for (const letter of ['Ё', 'Ъ', 'Ь', 'Ы']) {
        expect(ru).not.toContain(letter);
      }
    });

    it('hands out a copy, so a caller cannot mutate the shared alphabet', () => {
      const first = alphabetForLanguage(Language.ru);
      first.push('Ъ');
      expect(alphabetForLanguage(Language.ru)).not.toContain('Ъ');
    });
  });

  describe('indexLetterOf', () => {
    it('takes the first letter, upper-cased', () => {
      expect(indexLetterOf('достоевский', Language.ru)).toBe('Д');
      expect(indexLetterOf('Wilde', Language.en)).toBe('W');
    });

    // 🔴 Ровно то, ради чего заведена свёртка: ILIKE 'e%' не ловит É, и без
    // свёртки Édouard уехал бы в `#`, а счётчик буквы E разошёлся бы с сеткой.
    it('folds diacritics into the base letter', () => {
      expect(indexLetterOf('Édouard', Language.fr)).toBe('E');
      expect(indexLetterOf('Ólafur', Language.pt)).toBe('O');
      expect(indexLetterOf('Ñuño', Language.es)).toBe('N');
      expect(indexLetterOf('Šimon', Language.en)).toBe('S');
    });

    it('folds Ё into Е', () => {
      expect(indexLetterOf('Ёлкин', Language.ru)).toBe('Е');
    });

    it('ignores leading whitespace', () => {
      expect(indexLetterOf('  Пушкин', Language.ru)).toBe('П');
    });

    it('sends names that start with neither letter nor own alphabet to #', () => {
      expect(indexLetterOf('50 Cent', Language.en)).toBe(OTHER_LETTER);
      expect(indexLetterOf('«Аноним»', Language.ru)).toBe(OTHER_LETTER);
      // Латиница на русской странице — тоже не своя буква.
      expect(indexLetterOf('Wilde', Language.ru)).toBe(OTHER_LETTER);
      expect(indexLetterOf('Достоевский', Language.en)).toBe(OTHER_LETTER);
      expect(indexLetterOf('', Language.en)).toBe(OTHER_LETTER);
    });
  });

  describe('isKnownLetter', () => {
    it('accepts an own letter in either case and the # group', () => {
      expect(isKnownLetter('Д', Language.ru)).toBe(true);
      expect(isKnownLetter('д', Language.ru)).toBe(true);
      expect(isKnownLetter('é', Language.fr)).toBe(true);
      expect(isKnownLetter(OTHER_LETTER, Language.en)).toBe(true);
    });

    it('rejects a letter of another alphabet, a word and an empty string', () => {
      expect(isKnownLetter('Д', Language.en)).toBe(false);
      expect(isKnownLetter('W', Language.ru)).toBe(false);
      expect(isKnownLetter('Ab', Language.en)).toBe(false);
      expect(isKnownLetter('', Language.en)).toBe(false);
      expect(isKnownLetter('7', Language.en)).toBe(false);
    });
  });

  describe('sortLetters', () => {
    it('orders by the alphabet of the language and puts # last', () => {
      const sorted = sortLetters(
        [{ letter: OTHER_LETTER }, { letter: 'П' }, { letter: 'А' }, { letter: 'Д' }],
        Language.ru,
      );
      expect(sorted.map((r) => r.letter)).toEqual(['А', 'Д', 'П', OTHER_LETTER]);
    });

    it('does not mutate the array it was given', () => {
      const rows = [{ letter: 'Я' }, { letter: 'А' }];
      sortLetters(rows, Language.ru);
      expect(rows.map((r) => r.letter)).toEqual(['Я', 'А']);
    });
  });

  describe('buildShortBio', () => {
    it('returns null when there is nothing to show', () => {
      expect(buildShortBio(null)).toBeNull();
      expect(buildShortBio(undefined)).toBeNull();
      expect(buildShortBio('   ')).toBeNull();
      expect(buildShortBio('<p></p>')).toBeNull();
    });

    it('strips markup and collapses whitespace', () => {
      expect(buildShortBio('<p>Русский  писатель.</p>')).toBe('Русский писатель.');
    });

    // Тег заменяется пробелом, чтобы `<p>раз</p><p>два</p>` не склеилось
    // в «раздва»; на инлайновых тегах это давало пробел перед точкой.
    it('does not glue neighbouring blocks together', () => {
      expect(buildShortBio('<p>Раз</p><p>Два</p>')).toBe('Раз Два');
    });

    it('does not leave a space in front of punctuation after an inline tag', () => {
      expect(buildShortBio('<p>Русский <b>писатель</b>.</p>')).toBe('Русский писатель.');
      expect(buildShortBio('Автор <i>романа</i>, поэт')).toBe('Автор романа, поэт');
      expect(buildShortBio('Роман <b>«Идиот»</b> вышел')).toBe('Роман «Идиот» вышел');
    });

    it('decodes the entities a CMS actually produces', () => {
      expect(buildShortBio('Дюма&nbsp;&amp;&nbsp;сын &laquo;')).toBe('Дюма & сын &laquo;');
      expect(buildShortBio('&lt;тег&gt; и &quot;кавычки&quot;')).toBe('<тег> и "кавычки"');
    });

    it('keeps a short biography as it is, without an ellipsis', () => {
      const short = 'Писатель.';
      expect(buildShortBio(short)).toBe(short);
    });

    it('cuts on a word boundary and adds an ellipsis', () => {
      const long = `${'слово '.repeat(60)}хвост`;
      const result = buildShortBio(long);

      expect(result).not.toBeNull();
      expect(result!.endsWith('…')).toBe(true);
      // Ровно граница слова: обрезок «сло…» — это и есть дефект, который ловит тест.
      expect(result!.slice(0, -1).endsWith('слово')).toBe(true);
      expect([...result!].length).toBeLessThanOrEqual(161);
    });

    it('does not leave a dangling separator in front of the ellipsis', () => {
      const long = `${'a'.repeat(150)}, ${'b'.repeat(40)}`;
      expect(buildShortBio(long)).toBe(`${'a'.repeat(150)}…`);
    });

    // Биография без единого пробела в первых 160 знаках — вырожденный случай,
    // но вернуть её целиком означало бы отдать в карточку всю биографию.
    it('still cuts a biography that has no word boundary at all', () => {
      const result = buildShortBio('я'.repeat(400));
      expect([...result!].length).toBe(161);
    });
  });
});
