import { CreateBookVersionDto } from './create-book-version.dto';
import { contentFieldErrors, versionPayload } from './version-content-fields.fixture';

describe('CreateBookVersionDto: описание и обложка', () => {
  it('принимает создание без описания и обложки', () => {
    expect(contentFieldErrors(CreateBookVersionDto, versionPayload({}))).toEqual([]);
  });

  it('принимает пустые описание и обложку', () => {
    expect(
      contentFieldErrors(
        CreateBookVersionDto,
        versionPayload({ description: '', coverImageUrl: '' }),
      ),
    ).toEqual([]);
  });

  it('отбивает нестроковую обложку, а не пропускает её в базу', () => {
    expect(
      contentFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: 123 })),
    ).toContain('coverImageUrl');
    expect(
      contentFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: { set: 'x' } })),
    ).toContain('coverImageUrl');
  });

  it('отбивает `null` в колонках, которые его не принимают', () => {
    expect(
      contentFieldErrors(CreateBookVersionDto, versionPayload({ description: null })),
    ).toContain('description');
    expect(
      contentFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: null })),
    ).toContain('coverImageUrl');
  });

  it('по-прежнему требует настоящий адрес у заполненной обложки', () => {
    expect(
      contentFieldErrors(CreateBookVersionDto, versionPayload({ coverImageUrl: 'not-a-url' })),
    ).toContain('coverImageUrl');
    expect(
      contentFieldErrors(
        CreateBookVersionDto,
        versionPayload({ coverImageUrl: 'https://cdn.example.com/cover.jpg' }),
      ),
    ).toEqual([]);
  });
});
