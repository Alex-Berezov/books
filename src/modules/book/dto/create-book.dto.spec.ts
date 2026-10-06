import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { CreateBookDto } from './create-book.dto';

describe('CreateBookDto: слаг (LEGACY-437)', () => {
  it('принимает 100 символов и отбивает 101', () => {
    expect(dtoFieldErrors(CreateBookDto, { slug: 'a'.repeat(100) })).toEqual([]);
    expect(dtoFieldErrors(CreateBookDto, { slug: 'a'.repeat(101) })).toContain('slug');
  });

  it('отбивает `null` и отсутствующий слаг', () => {
    expect(dtoFieldErrors(CreateBookDto, { slug: null })).toContain('slug');
    expect(dtoFieldErrors(CreateBookDto, {})).toContain('slug');
  });
});
