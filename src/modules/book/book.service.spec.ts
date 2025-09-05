import { BookService } from './book.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BookType, Language } from '@prisma/client';

interface PrismaStub {
  book: { findUnique: jest.Mock };
  bookVersion: { findMany: jest.Mock };
  bookSummary: { findFirst: jest.Mock };
  seo: { findUnique: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  book: { findUnique: jest.fn() },
  bookVersion: { findMany: jest.fn() },
  bookSummary: { findFirst: jest.fn() },
  seo: { findUnique: jest.fn() },
});

describe('BookService.getOverview', () => {
  let service: BookService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new BookService(prisma as unknown as PrismaService);
  });

  it('returns aggregated overview with languages, flags and SEO (happy path)', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
    prisma.bookVersion.findMany.mockResolvedValue([
      { id: 'v-text-en', language: Language.en, type: BookType.text, isFree: true, seoId: 1 },
      { id: 'v-audio-es', language: Language.es, type: BookType.audio, isFree: false, seoId: 2 },
      { id: 'v-ref-fr', language: Language.fr, type: BookType.referral, isFree: true, seoId: null },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1' });
    prisma.seo.findUnique.mockImplementation((args: { where: { id: number } }) => {
      if (args?.where?.id === 1)
        return Promise.resolve({ metaTitle: 'T-text', metaDescription: 'D-text' });
      if (args?.where?.id === 2)
        return Promise.resolve({ metaTitle: 'T-audio', metaDescription: 'D-audio' });
      return Promise.resolve(null);
    });

    const res = await service.getOverview('slug-1', undefined, 'es');

    expect(res.book.slug).toBe('slug-1');
    expect(new Set(res.availableLanguages)).toEqual(
      new Set([Language.en, Language.es, Language.fr]),
    );
    expect(res.hasText).toBe(true);
    expect(res.hasAudio).toBe(true);
    expect(res.hasSummary).toBe(true);
    expect(res.versionIds).toEqual({ text: 'v-text-en', audio: 'v-audio-es' });
    expect(res.seo.main?.metaTitle).toBe('T-text');
    expect(res.seo.read?.metaTitle).toBe('T-text');
    expect(res.seo.listen?.metaTitle).toBe('T-audio');
    expect(res.seo.summary?.metaTitle).toBe('T-text');
  });

  it('handles no versions gracefully', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b2', slug: 'book-2' });
    prisma.bookVersion.findMany.mockResolvedValue([]);

    const res = await service.getOverview('book-2');
    expect(res.availableLanguages).toEqual([]);
    expect(res.hasText).toBe(false);
    expect(res.hasAudio).toBe(false);
    expect(res.hasSummary).toBe(false);
    expect(res.versionIds).toEqual({ text: null, audio: null });
    expect(res.seo.main).toBeNull();
  });

  it('prefers same-language version when available', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b3', slug: 'book-3' });
    prisma.bookVersion.findMany.mockResolvedValue([
      { id: 'v-text-en', language: Language.en, type: BookType.text, isFree: true, seoId: 1 },
      { id: 'v-text-es', language: Language.es, type: BookType.text, isFree: true, seoId: 2 },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's2' });
    prisma.seo.findUnique.mockResolvedValue({
      metaTitle: 'T-any',
      metaDescription: 'D-any',
    });

    const res = await service.getOverview('book-3', 'es');
    expect(res.versionIds.text).toBe('v-text-es');
  });
});
