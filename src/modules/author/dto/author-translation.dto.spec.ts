import { AuthorTranslationDto } from './author-translation.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { NON_HTTP_URLS } from '../../../common/testing/url-field-cases';

const errors = (overrides: Record<string, unknown>) =>
  dtoFieldErrors(AuthorTranslationDto, overrides);

describe('AuthorTranslationDto: ссылки только http(s) (LEGACY-447)', () => {
  const fields = ['wikidataUrl', 'wikipediaUrl', 'photoUrl'];

  it.each(fields.flatMap((field) => NON_HTTP_URLS.map((url) => [field, url])))(
    'отбивает %s = %s',
    (field, url) => {
      expect(errors({ [field]: url })).toContain(field);
    },
  );

  it.each(fields)('принимает абсолютный https-адрес в %s', (field) => {
    expect(errors({ [field]: 'https://en.wikipedia.org/wiki/Oscar_Wilde' })).not.toContain(field);
  });

  // `''` — «не задано», как при прежнем `@IsString()` (решение арбитра T94).
  it.each(fields)('пустая строка и null в %s — не задано', (field) => {
    expect(errors({ [field]: '' })).not.toContain(field);
    expect(errors({ [field]: null })).not.toContain(field);
  });
});
