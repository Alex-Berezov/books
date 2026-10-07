import { UpdateBookVersionDto } from './update-book-version.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';

describe('UpdateBookVersionDto: описание и обложка', () => {
  it('принимает очистку описания и обложки пустой строкой', () => {
    expect(dtoFieldErrors(UpdateBookVersionDto, { description: '', coverImageUrl: '' })).toEqual(
      [],
    );
  });

  it('отбивает нестроковую обложку', () => {
    expect(dtoFieldErrors(UpdateBookVersionDto, { coverImageUrl: 123 })).toContain('coverImageUrl');
    expect(dtoFieldErrors(UpdateBookVersionDto, { coverImageUrl: ['a'] })).toContain(
      'coverImageUrl',
    );
  });

  it('отбивает `null` в описании и обложке', () => {
    expect(dtoFieldErrors(UpdateBookVersionDto, { description: null })).toContain('description');
    expect(dtoFieldErrors(UpdateBookVersionDto, { coverImageUrl: null })).toContain(
      'coverImageUrl',
    );
  });
});

describe('UpdateBookVersionDto: форма элементов symbols/characters/quotes/faq (LEGACY-402)', () => {
  it('принимает верную форму каждого поля', () => {
    expect(
      dtoFieldErrors(UpdateBookVersionDto, {
        symbols: [{ title: 'Portrait', description: 'Represents the soul' }],
        characters: [{ name: 'Dorian Gray', description: 'Main character' }],
        quotes: [{ text: 'To live is the rarest thing in the world.', author: 'Oscar Wilde' }],
        faq: [{ question: 'What is the genre?', answer: 'Gothic fiction' }],
      }),
    ).toEqual([]);
  });

  it('отбивает элемент без обязательных полей', () => {
    expect(dtoFieldErrors(UpdateBookVersionDto, { symbols: [{}] })).toContain('symbols');
    expect(dtoFieldErrors(UpdateBookVersionDto, { characters: [{}] })).toContain('characters');
    expect(dtoFieldErrors(UpdateBookVersionDto, { quotes: [{}] })).toContain('quotes');
    expect(dtoFieldErrors(UpdateBookVersionDto, { faq: [{}] })).toContain('faq');
  });

  it('отбивает элемент с лишним полем', () => {
    expect(
      dtoFieldErrors(UpdateBookVersionDto, {
        faq: [{ question: 'Q', answer: 'A', extra: true }],
      }),
    ).toContain('faq');
  });
});

describe('UpdateBookVersionDto: формат слага (LEGACY-437)', () => {
  it('принимает слаг по SLUG_PATTERN и правку без слага', () => {
    expect(dtoFieldErrors(UpdateBookVersionDto, { slug: 'harry-potter-2' })).toEqual([]);
    expect(dtoFieldErrors(UpdateBookVersionDto, { title: 'Harry Potter' })).toEqual([]);
  });

  it('отбивает слаг не по формату; длину не проверяет', () => {
    for (const slug of ['Harry-Potter', 'harry potter', 'harry-', 'harry_potter', 'гарри', '']) {
      expect(dtoFieldErrors(UpdateBookVersionDto, { slug })).toContain('slug');
    }
    // С `T109` (решение арбитра 07.10.2026, A) предел 100 — в сервисе и только у изменённого слага:
    // DTO текущего слага не знает, а неизменный слаг старой версии длиннее 100 — не отказ.
    expect(dtoFieldErrors(UpdateBookVersionDto, { slug: 'a'.repeat(101) })).toEqual([]);
    expect(dtoFieldErrors(UpdateBookVersionDto, { slug: 'a'.repeat(100) })).toEqual([]);
    // `null` записал бы NULL в колонку слага без редиректа (`LEGACY-437`, класс `LEGACY-062`).
    expect(dtoFieldErrors(UpdateBookVersionDto, { slug: null })).toContain('slug');
    expect(dtoFieldErrors(UpdateBookVersionDto, {})).toEqual([]);
  });
});

describe('UpdateBookVersionDto: `null` в обязательных колонках (LEGACY-437, T110)', () => {
  it.each(['language', 'title', 'author', 'type', 'isFree'])('отбивает `null` в %s', (field) => {
    expect(dtoFieldErrors(UpdateBookVersionDto, { [field]: null })).toContain(field);
  });

  it('принимает правку без этих полей и с верными значениями', () => {
    expect(dtoFieldErrors(UpdateBookVersionDto, {})).toEqual([]);
    expect(
      dtoFieldErrors(UpdateBookVersionDto, {
        language: 'en',
        title: 'Harry Potter',
        author: 'J.K. Rowling',
        type: 'audio',
        isFree: false,
      }),
    ).toEqual([]);
  });
});
