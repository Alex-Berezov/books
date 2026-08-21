import { UpdateBookVersionDto } from './update-book-version.dto';
import { contentFieldErrors } from './version-content-fields.fixture';

describe('UpdateBookVersionDto: описание и обложка', () => {
  it('принимает очистку описания и обложки пустой строкой', () => {
    expect(
      contentFieldErrors(UpdateBookVersionDto, { description: '', coverImageUrl: '' }),
    ).toEqual([]);
  });

  it('отбивает нестроковую обложку', () => {
    expect(contentFieldErrors(UpdateBookVersionDto, { coverImageUrl: 123 })).toContain(
      'coverImageUrl',
    );
    expect(contentFieldErrors(UpdateBookVersionDto, { coverImageUrl: ['a'] })).toContain(
      'coverImageUrl',
    );
  });

  it('отбивает `null` в описании и обложке', () => {
    expect(contentFieldErrors(UpdateBookVersionDto, { description: null })).toContain(
      'description',
    );
    expect(contentFieldErrors(UpdateBookVersionDto, { coverImageUrl: null })).toContain(
      'coverImageUrl',
    );
  });
});
