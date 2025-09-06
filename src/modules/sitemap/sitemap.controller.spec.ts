import { SitemapController } from './sitemap.controller';
import { SitemapService } from './sitemap.service';
import { Response } from 'express';
import { Language } from '@prisma/client';

describe('SitemapController (unit)', () => {
  let controller: SitemapController;
  let service: jest.Mocked<Pick<SitemapService, 'sitemapIndex' | 'perLanguage' | 'robots'>>;

  beforeEach(() => {
    service = {
      sitemapIndex: jest.fn(),
      perLanguage: jest.fn(),
      robots: jest.fn(),
    };
    controller = new SitemapController(service as unknown as SitemapService);
  });

  const createResMock = () => {
    const headers: Record<string, string> = {};
    const body: { sent?: string } = {};
    const res = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      send: (b: string) => {
        body.sent = b;
      },
    } as unknown as Response;
    return { res, headers, body };
  };

  it('sitemapIndex sets content-type and sends body', () => {
    service.sitemapIndex.mockReturnValue({
      body: '<xml/>',
      contentType: 'application/xml; charset=utf-8',
    });
    const { res, headers, body } = createResMock();

    controller.sitemapIndex(res);

    expect(headers['Content-Type']).toBe('application/xml; charset=utf-8');
    expect(body.sent).toBe('<xml/>');
    expect(service.sitemapIndex).toHaveBeenCalledTimes(1);
  });

  it('sitemapForLang delegates to service.perLanguage with lang and sets headers/body', async () => {
    service.perLanguage.mockResolvedValue({
      body: '<urlset/>',
      contentType: 'application/xml; charset=utf-8',
    });
    const { res, headers, body } = createResMock();

    await controller.sitemapForLang(Language.en, res);

    expect(service.perLanguage).toHaveBeenCalledWith('en');
    expect(headers['Content-Type']).toBe('application/xml; charset=utf-8');
    expect(body.sent).toBe('<urlset/>');
  });

  it('robots sets text/plain content-type and sends body', () => {
    service.robots.mockReturnValue({
      body: 'User-agent: *\n',
      contentType: 'text/plain; charset=utf-8',
    });
    const { res, headers, body } = createResMock();

    controller.robots(res);

    expect(service.robots).toHaveBeenCalledTimes(1);
    expect(headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(body.sent).toBe('User-agent: *\n');
  });
});
