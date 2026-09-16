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
