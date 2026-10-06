import { CreateBookFromClearanceDto } from './create-book-from-clearance.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';

const slugErrors = (payload: Record<string, unknown>) =>
  dtoFieldErrors(CreateBookFromClearanceDto, payload).filter((field) => field === 'slug');

describe('CreateBookFromClearanceDto: длина слага (LEGACY-437)', () => {
  it('новая книга: 100 символов проходит, 101 — нет', () => {
    expect(slugErrors({ slug: 'a'.repeat(100) })).toEqual([]);
    expect(slugErrors({ slug: 'a'.repeat(101) })).toEqual(['slug']);
  });

  it('привязка к существующей книге: длину слага не проверяет', () => {
    expect(slugErrors({ slug: 'a'.repeat(101), attachToExistingBook: true })).toEqual([]);
  });

  it('явный `attachToExistingBook: false` — новая книга, длина проверяется', () => {
    expect(slugErrors({ slug: 'a'.repeat(101), attachToExistingBook: false })).toEqual(['slug']);
  });

  it('формат проверяется в обоих режимах', () => {
    expect(slugErrors({ slug: 'Bad Slug' })).toEqual(['slug']);
    expect(slugErrors({ slug: 'Bad Slug', attachToExistingBook: true })).toEqual(['slug']);
  });
});
