import { BadRequestException } from '@nestjs/common';

export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SLUG_REGEX = new RegExp(SLUG_PATTERN);
/**
 * Предел длины слага на записи (`LEGACY-437`); `check-slug` и DTO версии держат то же число литералом.
 * Копия на фронте — `SLUG_MAX_LENGTH` и `isSlugLengthAllowed` в `books-front/lib/utils/slug.ts`: менять вместе.
 */
export const SLUG_MAX_LENGTH = 100;
export const SLUG_MAX_LENGTH_MESSAGE = `Slug must be at most ${SLUG_MAX_LENGTH} characters long`;
export const SLUG_REGEX_README =
  'Lowercase: Latin letters and digits, separator is a hyphen. No spaces, no double or edge hyphens. Examples: "harry-potter", "book-123"';

/**
 * Предел длины у **изменённого** слага при правке (`LEGACY-437`). В Update-DTO его не поставить: DTO не знает
 * текущий слаг, а неизменный слаг старой записи длиннее предела не должен давать 400. Зовётся сервисом с текущим
 * слагом из запертой строки; `current: null` — записи ещё нет (создание мимо Create-DTO, импорт), предел всегда.
 * Новый слаг на создании через ручку держит `@MaxLength(SLUG_MAX_LENGTH)` в Create-DTO.
 */
export function assertChangedSlugLength(
  next: string | null | undefined,
  current: string | null,
): void {
  if (next && next !== current && next.length > SLUG_MAX_LENGTH) {
    throw new BadRequestException(SLUG_MAX_LENGTH_MESSAGE);
  }
}

/**
 * Кандидат подсказки свободного слага `<base>-<n>`, не длиннее `SLUG_MAX_LENGTH` (`LEGACY-437`): база обрезается
 * под суффикс, висячие дефисы снимаются — иначе к занятому слагу из 99-100 символов подсказка выходила за предел,
 * и Create-DTO отбивал её же.
 */
export function suggestedSlugCandidate(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}
