import { SitemapService } from './sitemap.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Language } from '@prisma/client';

type PrismaStub = {
  page: { findMany: jest.Mock };
  bookVersion: { findMany: jest.Mock };
};

const createPrismaStub = (): PrismaStub => ({
  page: { findMany: jest.fn() },
  bookVersion: { findMany: jest.fn() },
});

describe('SitemapService (unit)', () => {
  let service: SitemapService;
  let prisma: PrismaStub;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new SitemapService(prisma as unknown as PrismaService);
    process.env = { ...ORIGINAL_ENV, LOCAL_PUBLIC_BASE_URL: 'http://localhost:5000/static' };
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-09-06T12:00:00Z'));
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  it('robots.txt includes sitemap url and is cached', () => {
    const first = service.robots();
    const second = service.robots();
    expect(first.body).toContain('Sitemap: http://localhost:5000/static/sitemap.xml');
    expect(first.contentType).toBe('text/plain; charset=utf-8');
    expect(second.body).toBe(first.body); // cached content equality
    expect(second.contentType).toBe(first.contentType);
  });

  it('sitemap index lists all language sitemaps and caches by TTL', () => {
    const first = service.sitemapIndex();
    expect(first.body).toContain('<sitemapindex');
    expect(first.contentType).toBe('application/xml; charset=utf-8');
    for (const lang of Object.values(Language)) {
      expect(first.body).toContain(`http://localhost:5000/static/sitemap-${lang}.xml`);
    }
    const second = service.sitemapIndex();
    expect(second.body).toBe(first.body);
    expect(second.contentType).toBe(first.contentType);
  });

  it('perLanguage builds urls for pages and books and respects cache TTL', async () => {
    prisma.page.findMany.mockResolvedValueOnce([{ slug: 'about' }, { slug: 'contacts' }]);
    prisma.bookVersion.findMany.mockResolvedValueOnce([
      { book: { slug: 'first-book' } },
      { book: { slug: 'second-book' } },
      // duplicate slug to ensure Set uniqueness
      { book: { slug: 'first-book' } },
    ]);

    const first = await service.perLanguage('en');
    expect(first.body).toContain('<urlset');
    expect(first.body).toContain('http://localhost:5000/static/en/pages/about');
    expect(first.body).toContain('http://localhost:5000/static/en/pages/contacts');
    expect(first.body).toContain('http://localhost:5000/static/en/books/first-book');
    expect(first.body).toContain('http://localhost:5000/static/en/books/second-book');

    // Cached: second call without advancing time returns same object
    const second = await service.perLanguage('en');
    expect(second.body).toBe(first.body);
    expect(second.contentType).toBe(first.contentType);

    // Advance beyond default 60s TTL to invalidate cache
    jest.setSystemTime(new Date('2025-09-06T12:01:01Z'));

    prisma.page.findMany.mockResolvedValueOnce([{ slug: 'updated' }]);
    prisma.bookVersion.findMany.mockResolvedValueOnce([]);
    const third = await service.perLanguage('en');
    expect(third.body).not.toBe(first.body);
    expect(third.body).toContain('http://localhost:5000/static/en/pages/updated');
  });

  it('falls back to default public base when env not set', async () => {
    // Recreate service with env without LOCAL_PUBLIC_BASE_URL
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LOCAL_PUBLIC_BASE_URL;
    const fresh = new SitemapService(prisma as unknown as PrismaService);
    prisma.page.findMany.mockResolvedValueOnce([{ slug: 'home' }]);
    prisma.bookVersion.findMany.mockResolvedValueOnce([{ book: { slug: 'book' } }]);

    const robots = fresh.robots();
    expect(robots.body).toContain('Sitemap: http://localhost:3000/sitemap.xml');

    const index = fresh.sitemapIndex();
    expect(index.body).toContain('http://localhost:3000/sitemap-en.xml');

    const per = await fresh.perLanguage('en');
    expect(per.body).toContain('http://localhost:3000/en/pages/home');
    expect(per.body).toContain('http://localhost:3000/en/books/book');
  });
});
