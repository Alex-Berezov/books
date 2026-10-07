import { BadRequestException } from '@nestjs/common';
import {
  assertChangedSlugLength,
  SLUG_MAX_LENGTH,
  SLUG_MAX_LENGTH_MESSAGE,
  suggestedSlugCandidate,
} from './slug';

/** `LEGACY-437`: предел длины только у нового или изменённого слага. */
describe('assertChangedSlugLength', () => {
  const atLimit = 'a'.repeat(SLUG_MAX_LENGTH);
  const overLimit = 'a'.repeat(SLUG_MAX_LENGTH + 1);

  it('пропускает неизменный слаг длиннее предела и отсутствующий слаг', () => {
    expect(() => assertChangedSlugLength(overLimit, overLimit)).not.toThrow();
    expect(() => assertChangedSlugLength(undefined, overLimit)).not.toThrow();
  });

  it('отбивает изменённый и новый слаг длиннее предела, пропускает слаг на пределе', () => {
    expect(() => assertChangedSlugLength(overLimit, 'old')).toThrow(
      new BadRequestException(SLUG_MAX_LENGTH_MESSAGE),
    );
    expect(() => assertChangedSlugLength(overLimit, null)).toThrow(BadRequestException);
    expect(() => assertChangedSlugLength(atLimit, 'old')).not.toThrow();
    expect(() => assertChangedSlugLength(atLimit, null)).not.toThrow();
  });
});

describe('suggestedSlugCandidate', () => {
  it.each([
    [99, 2],
    [100, 2],
    [99, 10],
    [100, 10],
  ])('база из %i символов с суффиксом -%i не выходит за предел', (length, n) => {
    const candidate = suggestedSlugCandidate('a'.repeat(length), n);
    expect(candidate.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(candidate.endsWith(`-${n}`)).toBe(true);
  });

  it('короткую базу не трогает', () => {
    expect(suggestedSlugCandidate('harry-potter', 2)).toBe('harry-potter-2');
  });

  it('снимает висячий дефис на месте обрезки', () => {
    // 97 символов, 98-й — дефис: под суффикс `-2` база режется до 98 и кончается дефисом.
    const base = `${'a'.repeat(97)}-bbbb`;
    expect(suggestedSlugCandidate(base, 2)).toBe(`${'a'.repeat(97)}-2`);
  });
});
