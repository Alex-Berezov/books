import { CreateRightsLicenseDto } from './create-rights-license.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { NON_HTTP_URLS } from '../../../common/testing/url-field-cases';

describe('CreateRightsLicenseDto: documentUrl только http(s) (LEGACY-447)', () => {
  it.each(NON_HTTP_URLS)('отбивает %s', (url) => {
    expect(dtoFieldErrors(CreateRightsLicenseDto, { documentUrl: url })).toContain('documentUrl');
  });

  it('принимает абсолютный https-адрес', () => {
    expect(
      dtoFieldErrors(CreateRightsLicenseDto, { documentUrl: 'https://example.org/license.pdf' }),
    ).not.toContain('documentUrl');
  });

  it.each(['', null])('пустое значение %j — не задано', (value) => {
    expect(dtoFieldErrors(CreateRightsLicenseDto, { documentUrl: value })).not.toContain(
      'documentUrl',
    );
  });
});
