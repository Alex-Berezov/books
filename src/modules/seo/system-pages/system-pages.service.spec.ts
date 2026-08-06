import { Logger } from '@nestjs/common';
import { Language } from '@prisma/client';
import { SystemPagesService } from './system-pages.service';
import { SYSTEM_PAGE_LANGUAGES, SYSTEM_PAGE_SLUGS } from './system-pages.constants';
import { PrismaService } from '../../../prisma/prisma.service';

type Row = { slug: string; language: Language; status: string };

const everythingPublished = (): Row[] =>
  SYSTEM_PAGE_SLUGS.flatMap(({ slug }) =>
    SYSTEM_PAGE_LANGUAGES.map((language) => ({ slug, language, status: 'published' })),
  );

const prismaWith = (rows: Row[] | Error) =>
  ({
    page: {
      findMany: jest.fn(() =>
        rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
      ),
    },
  }) as unknown as PrismaService;

describe('SystemPagesService', () => {
  it('is quiet when every system slug is published in every language', async () => {
    const status = await new SystemPagesService(prismaWith(everythingPublished())).check();

    expect(status.ok).toBe(true);
    expect(status.problems).toHaveLength(0);
    expect(status.pages).toHaveLength(SYSTEM_PAGE_SLUGS.length);
  });

  /**
   * The exact production incident: the title "Homepage" regenerated the slug, so
   * `homepage-index` stopped existing and `homepage` appeared next to it. The
   * homepage kept answering 200 the whole time.
   */
  it('reports a slug that was renamed out from under the lookup', async () => {
    const rows = everythingPublished()
      .filter((r) => r.slug !== 'homepage-index')
      .concat(
        SYSTEM_PAGE_LANGUAGES.map((language) => ({
          slug: 'homepage',
          language,
          status: 'published',
        })),
      );

    const status = await new SystemPagesService(prismaWith(rows)).check();

    expect(status.ok).toBe(false);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0].slug).toBe('homepage-index');
    expect(status.problems[0].missingIn).toEqual(SYSTEM_PAGE_LANGUAGES);
  });

  it('reports a hub that is missing in one language only', async () => {
    const rows = everythingPublished().filter(
      (r) => !(r.slug === 'taxonomy-tags-index' && r.language === Language.fr),
    );

    const status = await new SystemPagesService(prismaWith(rows)).check();

    expect(status.ok).toBe(false);
    expect(status.problems.map((p) => p.slug)).toEqual(['taxonomy-tags-index']);
    expect(status.problems[0].missingIn).toEqual([Language.fr]);
  });

  /** A draft page is not served publicly, so it is a problem, not a pass. */
  it('counts an unpublished page as unresolved and says it is a draft', async () => {
    const rows = everythingPublished().map((r) =>
      r.slug === 'taxonomy-genres-index' && r.language === Language.ru
        ? { ...r, status: 'draft' }
        : r,
    );

    const status = await new SystemPagesService(prismaWith(rows)).check();

    expect(status.ok).toBe(false);
    expect(status.problems[0].draftIn).toEqual([Language.ru]);
    expect(status.problems[0].missingIn).toHaveLength(0);
  });

  /**
   * "Could not check" is not "fine" — the same rule the live SEO audit follows.
   */
  it('does not report a pass when the query itself failed', async () => {
    const status = await new SystemPagesService(prismaWith(new Error('db down'))).check();

    expect(status.ok).toBe(false);
    expect(status.error).toContain('db down');
    expect(status.problems).toHaveLength(0);
  });

  it('logs every unresolved page at startup instead of failing silently', async () => {
    const rows = everythingPublished().filter((r) => r.slug !== 'taxonomy-collections-index');
    const service = new SystemPagesService(prismaWith(rows));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await service.onApplicationBootstrap();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('taxonomy-collections-index');
    error.mockRestore();
  });

  it('does not crash the application when the check cannot run at startup', async () => {
    const service = new SystemPagesService(prismaWith(new Error('db down')));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
