import { SlugRedirectService } from './slug-redirect.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Language } from '@prisma/client';

interface PrismaStub {
  slugRedirect: { deleteMany: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  slugRedirect: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
});

describe('SlugRedirectService.cleanupDeadRedirects (LEGACY-395)', () => {
  let service: SlugRedirectService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new SlugRedirectService(prisma as unknown as PrismaService);
  });

  it('does nothing when no language is dead', async () => {
    await service.cleanupDeadRedirects('tag', [], 'old-slug');

    expect(prisma.slugRedirect.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes redirects pointing at the dead slug, only for the given languages', async () => {
    await service.cleanupDeadRedirects('tag', [Language.en, Language.ru], 'old-slug');

    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: {
        entityType: 'tag',
        language: { in: [Language.en, Language.ru] },
        newSlug: 'old-slug',
      },
    });
  });

  it('writes through the given transaction client instead of this.prisma', async () => {
    const tx = { slugRedirect: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) } };

    await service.cleanupDeadRedirects(
      'page',
      [Language.en],
      'old-slug',
      tx as unknown as PrismaService,
    );

    expect(tx.slugRedirect.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.slugRedirect.deleteMany).not.toHaveBeenCalled();
  });
});

describe('SlugRedirectService: слаг снова живой (LEGACY-437)', () => {
  const ALL_LANGUAGES = Object.values(Language);
  const build = () => {
    const slugRedirect = {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({}),
    };
    return {
      slugRedirect,
      service: new SlugRedirectService({ slugRedirect } as unknown as PrismaService),
    };
  };

  it('releaseBookSlug: removes book redirects from the slug in every language', async () => {
    const { service, slugRedirect } = build();

    await service.releaseBookSlug('b');

    expect(slugRedirect.deleteMany).toHaveBeenCalledTimes(1);
    expect(slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'book', language: { in: ALL_LANGUAGES }, oldSlug: 'b' },
    });
  });

  it('record, book: the leftover redirect goes in every language, the chain stays in the language of the change', async () => {
    const { service, slugRedirect } = build();

    await service.record({ entityType: 'book', language: Language.ru, oldSlug: 'a', newSlug: 'b' });

    expect(slugRedirect.deleteMany).toHaveBeenCalledTimes(1);
    expect(slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'book', language: { in: ALL_LANGUAGES }, oldSlug: 'b' },
    });
    expect(slugRedirect.updateMany).toHaveBeenCalledTimes(1);
    expect(slugRedirect.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'book', language: Language.ru, newSlug: 'a' },
      data: { newSlug: 'b' },
    });
  });

  it('record, non-book: keeps the removal inside the language of the change', async () => {
    const { service, slugRedirect } = build();

    await service.record({ entityType: 'tag', language: Language.ru, oldSlug: 'a', newSlug: 'b' });

    expect(slugRedirect.deleteMany).toHaveBeenCalledTimes(1);
    expect(slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'tag', language: Language.ru, oldSlug: 'b' },
    });
  });

  it('recordBaseSlugChange, book: one release for all languages, the chain per language', async () => {
    const { service, slugRedirect } = build();

    await service.recordBaseSlugChange('book', 'a', 'b');

    expect(slugRedirect.deleteMany).toHaveBeenCalledTimes(1);
    expect(slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'book', language: { in: ALL_LANGUAGES }, oldSlug: 'b' },
    });
    expect(slugRedirect.upsert).toHaveBeenCalledTimes(ALL_LANGUAGES.length);
    expect(slugRedirect.updateMany).toHaveBeenCalledTimes(ALL_LANGUAGES.length);
  });
});
