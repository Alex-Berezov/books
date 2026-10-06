import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { UpdateBookDto } from './update-book.dto';

describe('UpdateBookDto: слаг (LEGACY-437)', () => {
  it('принимает пустую правку и верный слаг', () => {
    expect(dtoFieldErrors(UpdateBookDto, {})).toEqual([]);
    expect(dtoFieldErrors(UpdateBookDto, { slug: 'harry-potter' })).toEqual([]);
  });

  it('отбивает `null`: колонка NOT NULL, иначе 500', () => {
    expect(dtoFieldErrors(UpdateBookDto, { slug: null })).toContain('slug');
  });

  it('отбивает неверный формат и пустую строку', () => {
    expect(dtoFieldErrors(UpdateBookDto, { slug: 'Harry Potter' })).toContain('slug');
    expect(dtoFieldErrors(UpdateBookDto, { slug: '' })).toContain('slug');
    expect(dtoFieldErrors(UpdateBookDto, { slug: '   ' })).toContain('slug');
  });

  it('держит предел 100 после обрезки пробелов', () => {
    expect(dtoFieldErrors(UpdateBookDto, { slug: 'a'.repeat(100) })).toEqual([]);
    expect(dtoFieldErrors(UpdateBookDto, { slug: ` ${'a'.repeat(100)} ` })).toEqual([]);
    expect(dtoFieldErrors(UpdateBookDto, { slug: 'a'.repeat(101) })).toContain('slug');
  });
});
