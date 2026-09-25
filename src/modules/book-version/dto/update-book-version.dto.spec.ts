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
