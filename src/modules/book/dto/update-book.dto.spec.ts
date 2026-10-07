import { plainToInstance } from 'class-transformer';
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

  it('длину не проверяет: неизменный слаг старой книги длиннее 100 — не отказ (предел в `BookService.update`)', () => {
    expect(dtoFieldErrors(UpdateBookDto, { slug: 'a'.repeat(101) })).toEqual([]);
  });

  it('обрезает пробелы до сервиса: предел изменённого слага считается по обрезанному значению', () => {
    const padded = ` ${'a'.repeat(100)} `;
    expect(plainToInstance(UpdateBookDto, { slug: padded }).slug).toBe('a'.repeat(100));
  });
});
