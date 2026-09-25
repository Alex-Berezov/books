import { CreateBookVersionDto } from './create-book-version.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { versionPayload } from './version-content-fields.fixture';

describe('CreateBookVersionDto: описание и обложка', () => {
  it('принимает создание без описания и обложки', () => {
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({}))).toEqual([]);
  });

  it('принимает пустые описание и обложку', () => {
    expect(
      dtoFieldErrors(CreateBookVersionDto, versionPayload({ description: '', coverImageUrl: '' })),
    ).toEqual([]);
  });

  it('отбивает нестроковую обложку, а не пропускает её в базу', () => {
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: 123 }))).toContain(
      'coverImageUrl',
    );
    expect(
      dtoFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: { set: 'x' } })),
    ).toContain('coverImageUrl');
  });

  it('отбивает `null` в колонках, которые его не принимают', () => {
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ description: null }))).toContain(
      'description',
    );
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: null }))).toContain(
      'coverImageUrl',
    );
  });

  it('по-прежнему требует настоящий адрес у заполненной обложки', () => {
    expect(
      dtoFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: 'not-a-url' })),
    ).toContain('coverImageUrl');
    expect(
      dtoFieldErrors(
        CreateBookVersionDto,
        versionPayload({ coverImageUrl: 'https://cdn.example.com/cover.jpg' }),
      ),
    ).toEqual([]);
  });
});

describe('CreateBookVersionDto: форма элементов symbols/characters/quotes/faq (LEGACY-402)', () => {
  it('принимает верную форму каждого поля', () => {
    expect(
      dtoFieldErrors(
        CreateBookVersionDto,
        versionPayload({
          symbols: [{ title: 'Portrait', description: 'Represents the soul' }],
          characters: [{ name: 'Dorian Gray', description: 'Main character' }],
          quotes: [{ text: 'To live is the rarest thing in the world.', author: 'Oscar Wilde' }],
          faq: [{ question: 'What is the genre?', answer: 'Gothic fiction' }],
        }),
      ),
    ).toEqual([]);
  });

  it('цитата не требует автора', () => {
    expect(
      dtoFieldErrors(CreateBookVersionDto, versionPayload({ quotes: [{ text: 'Just a line' }] })),
    ).toEqual([]);
  });

  it('отбивает элемент без обязательных полей', () => {
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ symbols: [{}] }))).toContain(
      'symbols',
    );
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ characters: [{}] }))).toContain(
      'characters',
    );
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ quotes: [{}] }))).toContain(
      'quotes',
    );
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ faq: [{}] }))).toContain('faq');
  });

  it('отбивает элемент с лишним полем', () => {
    expect(
      dtoFieldErrors(
        CreateBookVersionDto,
        versionPayload({ faq: [{ question: 'Q', answer: 'A', extra: true }] }),
      ),
    ).toContain('faq');
  });

  it('отбивает не-объект и голую строку в элементе', () => {
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ symbols: ['x'] }))).toContain(
      'symbols',
    );
    expect(dtoFieldErrors(CreateBookVersionDto, versionPayload({ quotes: [null] }))).toContain(
      'quotes',
    );
  });
});
