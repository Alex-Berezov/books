import { CreateClaimAttachmentDto } from './create-claim-attachment.dto';
import { CreateRightsClaimDto } from './create-rights-claim.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { NON_HTTP_URLS } from '../../../common/testing/url-field-cases';

describe('претензии: ссылки только http(s) (LEGACY-447)', () => {
  it.each(NON_HTTP_URLS)('вложение отбивает url = %s', (url) => {
    expect(dtoFieldErrors(CreateClaimAttachmentDto, { url })).toContain('url');
  });

  it.each(NON_HTTP_URLS)('претензия отбивает originalNoticeUrl = %s', (url) => {
    expect(dtoFieldErrors(CreateRightsClaimDto, { originalNoticeUrl: url })).toContain(
      'originalNoticeUrl',
    );
  });

  it.each(NON_HTTP_URLS)('претензия отбивает элемент infringingUrls = %s', (url) => {
    expect(
      dtoFieldErrors(CreateRightsClaimDto, { infringingUrls: ['https://example.org/a', url] }),
    ).toContain('infringingUrls');
  });

  it('принимает абсолютные https-адреса', () => {
    expect(
      dtoFieldErrors(CreateClaimAttachmentDto, { url: 'https://example.org/a.pdf' }),
    ).not.toContain('url');
    const claimErrors = dtoFieldErrors(CreateRightsClaimDto, {
      originalNoticeUrl: 'https://example.org/notice',
      infringingUrls: ['https://example.org/a', 'http://example.com/b'],
    });
    expect(claimErrors).not.toContain('originalNoticeUrl');
    expect(claimErrors).not.toContain('infringingUrls');
  });

  it('пустая строка и null — не задано', () => {
    for (const value of ['', null]) {
      expect(dtoFieldErrors(CreateClaimAttachmentDto, { url: value })).not.toContain('url');
      expect(dtoFieldErrors(CreateRightsClaimDto, { originalNoticeUrl: value })).not.toContain(
        'originalNoticeUrl',
      );
    }
  });
});
