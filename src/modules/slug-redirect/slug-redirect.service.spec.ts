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
