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
