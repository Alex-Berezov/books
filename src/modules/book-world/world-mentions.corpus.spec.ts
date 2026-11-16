import { parallelChapters } from '../../common/testing/language-corpus';
import { htmlToParagraphs } from '../translation/content-draft/content-draft.text';
import { WorldMentionCounter } from './world-mentions';

/**
 * F08-2, приёмка `product.md` §19 п.7 (решение арбитра `F08 | F08-2` B2): присутствие героев одной
 * книги (три героя приёмки — Иисус, Пётр, Иоанн — и Иуда на границу слова) совпадает с ручной разметкой. Книга — Евангелие от Марка (16 глав, общественное
 * достояние, `test/fixtures/language-corpus/mark/ru.txt`). Эталон глав размечен вручную поиском
 * по формам имени целым словом, без регистра, `ё` = `е` (команда — в деле пачки F08-2) и вписан
 * литералами, не выведен из счётчика.
 */
const chapters = parallelChapters('ru');
const html = (text: string) =>
  text
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('');

const counted = (() => {
  const counter = new WorldMentionCounter(
    [
      {
        key: 'jesus',
        name: 'Иисус',
        aliases: ['Иисуса', 'Иисусу', 'Иисусом', 'Иисусе'],
        aliasExclusions: null,
      },
      {
        // Имя с «ё», в тексте — «Петр»: `ё` = `е`; второе имя — «Симон». Счётчик видит форму, а не
        // человека: «Симон» — и Симон Киринеянин (15:21), поэтому глава 15 засчитана Петру; и брат
        // Иисуса Симон (6:3, «брат Иакова, Иосии, Иуды и Симона») — глава 6 засчитана Петру и Иуде.
        // Исключение формы тут не помогает — это работа редактора на пилоте (F08-6).
        key: 'peter',
        name: 'Пётр',
        aliases: ['Петра', 'Петру', 'Петром', 'Петре', 'Симон', 'Симона', 'Симону', 'Симоном'],
        aliasExclusions: null,
      },
      {
        // Креститель и апостол — одна форма у двух людей: счётчик видит форму, а не человека.
        key: 'john',
        name: 'Иоанн',
        aliases: ['Иоанна', 'Иоанну', 'Иоанном', 'Иоанне'],
        aliasExclusions: null,
      },
      {
        key: 'judas',
        name: 'Иуда',
        aliases: ['Иуды', 'Иуде', 'Иуду', 'Иудою', 'Иудой'],
        aliasExclusions: null,
      },
    ],
    new Set(['jesus', 'peter', 'john', 'judas']),
  );
  chapters.forEach((text, i) => counter.addChapterText(i + 1, htmlToParagraphs(html(text))));
  return counter.result();
})();

describe('присутствие на тексте книги: Евангелие от Марка, ru (F08-2, §19 п.7)', () => {
  it('в книге 16 глав', () => {
    expect(chapters).toHaveLength(16);
  });

  it('Иисус — все главы, кроме 4', () => {
    expect(counted.get('jesus')!.chapters).toEqual([
      1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(counted.get('jesus')!.first).toBe(1);
  });

  it('Пётр (Петр, Симон): «ё» в имени находит «Петр» в тексте', () => {
    expect(counted.get('peter')!.chapters).toEqual([1, 3, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16]);
  });

  it('Иоанн', () => {
    expect(counted.get('john')!.chapters).toEqual([1, 3, 5, 6, 8, 9, 10, 11, 13, 14]);
  });

  it('граница слова: «Иуда» не находится в «Иудея» (главы 3 и 7 — Иудея, в 7 Иуды нет)', () => {
    expect(counted.get('judas')!.chapters).toEqual([3, 6, 14]);
  });

  it('совместное присутствие — пересечение глав', () => {
    expect(counted.get('judas')!.coPresence).toEqual({
      jesus: [3, 6, 14],
      peter: [3, 6, 14],
      john: [3, 6, 14],
    });
  });
});
