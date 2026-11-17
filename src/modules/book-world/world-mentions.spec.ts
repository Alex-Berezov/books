import { htmlToParagraphs } from '../translation/content-draft/content-draft.text';
import {
  WorldMentionCounter,
  countInParagraph,
  foldMention,
  mentionForms,
  publicMentionForms,
  type WorldMentionSource,
} from './world-mentions';

const olga: WorldMentionSource = {
  key: 'olga',
  name: 'Ольга',
  aliases: ['Оля'],
  aliasExclusions: null,
};

function count(entities: WorldMentionSource[], chapters: [number, string | null][], co?: string[]) {
  const counter = new WorldMentionCounter(entities, new Set(co ?? []));
  for (const [n, html] of chapters) counter.addChapterText(n, htmlToParagraphs(html ?? ''));
  return counter.result();
}

describe('world-mentions', () => {
  it('ищет форму целым словом: «Ольга» не находится в «Ольгину»', () => {
    const r = count([olga], [[1, '<p>Он пошёл к Ольгину дому.</p>']]).get('olga')!;
    expect(r.chapters).toEqual([]);
    expect(r.first).toBeNull();
  });

  it('форма внутри более длинного слова не считается («Ольга» в «Ольгами»)', () => {
    const r = count([olga], [[1, '<p>Он говорил с Ольгами.</p>']]).get('olga')!;
    expect(r.chapters).toEqual([]);
  });

  it('находит форму в начале и в конце абзаца и рядом со знаками', () => {
    expect(countInParagraph(foldMention('Ольга, подожди! Сказала Ольга.'), ['ольга'])).toBe(2);
  });

  it('не учитывает регистр', () => {
    const r = count([olga], [[2, '<p>ОЛЬГА вошла.</p>']]).get('olga')!;
    expect(r.chapters).toEqual([2]);
  });

  it('ё и е — одна буква в обе стороны', () => {
    const fedor: WorldMentionSource = {
      key: 'f',
      name: 'Фёдор',
      aliases: null,
      aliasExclusions: null,
    };
    const semen: WorldMentionSource = {
      key: 's',
      name: 'Семен',
      aliases: null,
      aliasExclusions: null,
    };
    const r = count([fedor, semen], [[1, '<p>Федор и Семён.</p>']]);
    expect(r.get('f')!.chapters).toEqual([1]);
    expect(r.get('s')!.chapters).toEqual([1]);
  });

  it('исключение снимает ложное срабатывание', () => {
    const vera: WorldMentionSource = {
      key: 'vera',
      name: 'Вера',
      aliases: ['вера'],
      aliasExclusions: ['ВЕРА'],
    };
    expect(mentionForms(vera)).toEqual([]);
    expect(count([vera], [[1, '<p>Его вера крепка.</p>']]).get('vera')!.chapters).toEqual([]);
  });

  it('формы публичного списка: исходное написание, тот же отбор, что у подсчёта (F08-5 Q2)', () => {
    const anna: WorldMentionSource = {
      key: 'anna',
      name: 'Анна Каренина',
      aliases: [' Анна ', 'анна', 'Анну', 'Ан', 'Каренина', 'Аннушка'],
      aliasExclusions: ['каренина'],
    };
    // Исключение, короткая форма и повтор по свёрнутому виду уходят; первое написание остаётся.
    expect(publicMentionForms(anna)).toEqual(['Анна Каренина', 'Анна', 'Анну', 'Аннушка']);
    expect(publicMentionForms(anna).map(foldMention)).toEqual(mentionForms(anna));
  });

  it('формы публичного списка: повтор по ё/е и по пробелам — одна форма, первое написание', () => {
    const fedor: WorldMentionSource = {
      key: 'fedor',
      name: 'Фёдор Павлович',
      aliases: ['Федор  Павлович', 'Фёдор'],
      aliasExclusions: null,
    };
    expect(publicMentionForms(fedor)).toEqual(['Фёдор Павлович', 'Фёдор']);
  });

  it('форма короче 3 букв не считается', () => {
    const r = count(
      [{ key: 'li', name: 'Ли', aliases: ['Ли Мин'], aliasExclusions: null }],
      [
        [1, '<p>Ли ушёл.</p>'],
        [2, '<p>Ли Мин вернулся.</p>'],
      ],
    ).get('li')!;
    expect(r.chapters).toEqual([2]);
  });

  it('глава без текста и глава из одной разметки ничего не дают', () => {
    const r = count(
      [olga],
      [
        [1, null],
        [2, ''],
        [3, '<p><img src="olga.png" alt="Ольга"></p>'],
      ],
    );
    expect(r.get('olga')!.chapters).toEqual([]);
  });

  it('считает вхождения по главам, первую главу и абзацы по правилу paragraphsOf', () => {
    const r = count(
      [olga],
      [
        [5, '<h2>Ольга</h2><p>Нет.</p><p>Оля и Ольга.</p>'],
        [3, '<p>Ольга.</p>'],
      ],
    ).get('olga')!;
    expect(r.chapters).toEqual([3, 5]);
    expect(r.first).toBe(3);
    expect(r.perChapter).toEqual({ '3': 1, '5': 3 });
    expect(r.paragraphs).toEqual({ '3': [0], '5': [0, 2] });
  });

  it('перекрывающиеся формы в одном месте — одно вхождение', () => {
    expect(countInParagraph('анна каренина и анна', ['анна', 'анна каренина'])).toBe(2);
  });

  it('coPresence симметричен и только между названными ключами', () => {
    const ivan: WorldMentionSource = {
      key: 'ivan',
      name: 'Иван',
      aliases: null,
      aliasExclusions: null,
    };
    const town: WorldMentionSource = {
      key: 'town',
      name: 'Город',
      aliases: null,
      aliasExclusions: null,
    };
    const r = count(
      [olga, ivan, town],
      [
        [1, '<p>Ольга и Иван. Город.</p>'],
        [2, '<p>Иван один.</p>'],
        [3, '<p>Ольга и Иван.</p>'],
      ],
      ['olga', 'ivan'],
    );
    expect(r.get('olga')!.coPresence).toEqual({ ivan: [1, 3] });
    expect(r.get('ivan')!.coPresence).toEqual({ olga: [1, 3] });
    expect(r.get('town')!.coPresence).toEqual({});
  });
});
