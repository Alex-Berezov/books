import { ConfirmMediaDto } from './create-media.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { NON_HTTP_URLS } from '../../../common/testing/url-field-cases';

describe('ConfirmMediaDto: url только http(s) (LEGACY-447)', () => {
  it.each(NON_HTTP_URLS)('отбивает %s', (url) => {
    expect(dtoFieldErrors(ConfirmMediaDto, { key: 'covers/x.jpg', url })).toContain('url');
  });

  it('принимает адрес локального хранилища по умолчанию', () => {
    expect(
      dtoFieldErrors(ConfirmMediaDto, {
        key: 'covers/x.jpg',
        url: 'http://localhost:5000/covers/x.jpg',
      }),
    ).not.toContain('url');
  });
});
