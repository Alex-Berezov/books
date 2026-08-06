import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../src/modules/seo/indexability/taxonomy-indexability.service';

/**
 * A planted control input for the nightly sweep.
 *
 * `lastChanged: 0` in the status endpoint is what a healthy sweep reports on a
 * settled database — and it is also what a sweep that does no work at all would
 * report. The only way to tell those apart is to hand the mechanism a value that
 * is deliberately wrong and require it to notice. That is this file: a term with
 * 8 published books whose `autoIndexable` says `false`, and a term with 1 book
 * whose `autoIndexable` says `true`. A run that leaves either of them alone is
 * reporting success without doing the work.
 *
 * Runs against the throwaway database the e2e harness builds, never production.
 */
describe('Taxonomy indexability recompute — planted control input', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let indexability: TaxonomyIndexabilityService;

  let openableCategoryId: string;
  let closableCategoryId: string;
  const stamp = Date.now();

  // One book per version: BookVersion is unique on (bookId, language), so a
  // single book cannot hold eight English versions.
  const makePublishedVersions = async (count: number, categoryId: string) => {
    for (let i = 0; i < count; i += 1) {
      const book = await prisma.book.create({
        data: { slug: `ctrl-book-${categoryId}-${i}-${stamp}` },
      });
      const version = await prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language: 'en',
          title: `Control ${i}`,
          author: 'A',
          description: 'D',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'published',
          slug: `ctrl-${categoryId}-${i}-${stamp}`,
        },
      });
      await prisma.bookCategory.create({
        data: { bookVersionId: version.id, categoryId },
      });
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    indexability = moduleRef.get(TaxonomyIndexabilityService);
    app = moduleRef.createNestApplication();
    await app.init();

    // 8 books — comfortably above the OPEN_AT_OR_ABOVE = 5 threshold.
    const openable = await prisma.category.create({
      data: {
        slug: `ctrl-open-${stamp}`,
        key: `ctrl-open-${stamp}`,
        name: 'Control Open',
        type: 'genre',
        translations: {
          create: {
            language: 'en',
            name: 'Control Open',
            slug: `ctrl-open-en-${stamp}`,
            // The lie: eight published books, and the cache says do not index.
            bookCount: 0,
            autoIndexable: false,
          },
        },
      },
    });
    openableCategoryId = openable.id;
    await makePublishedVersions(8, openableCategoryId);

    // 1 book — below CLOSE_AT_OR_BELOW = 2.
    const closable = await prisma.category.create({
      data: {
        slug: `ctrl-close-${stamp}`,
        key: `ctrl-close-${stamp}`,
        name: 'Control Close',
        type: 'genre',
        translations: {
          create: {
            language: 'en',
            name: 'Control Close',
            slug: `ctrl-close-en-${stamp}`,
            // The opposite lie: one book, and the cache says index it.
            bookCount: 99,
            autoIndexable: true,
          },
        },
      },
    });
    closableCategoryId = closable.id;
    await makePublishedVersions(1, closableCategoryId);
  });

  afterAll(async () => {
    await app.close();
  });

  it('notices the planted values, fixes them, and says how many it opened and closed', async () => {
    const result = await indexability.recomputeAll();

    // The number that proves work happened. Zero here would mean the sweep
    // reported success without looking at anything.
    expect(result.categoryTranslations).toBeGreaterThan(0);
    expect(result.changed).toBeGreaterThanOrEqual(2);
    expect(result.opened).toBeGreaterThanOrEqual(1);
    expect(result.closed).toBeGreaterThanOrEqual(1);

    const opened = await prisma.categoryTranslation.findFirst({
      where: { categoryId: openableCategoryId, language: 'en' },
    });
    expect(opened?.bookCount).toBe(8);
    expect(opened?.autoIndexable).toBe(true);

    const closed = await prisma.categoryTranslation.findFirst({
      where: { categoryId: closableCategoryId, language: 'en' },
    });
    expect(closed?.bookCount).toBe(1);
    expect(closed?.autoIndexable).toBe(false);
  });

  it('reports a non-zero scan on a settled database, so "0 changed" stays distinguishable', async () => {
    // Everything is already correct after the first run.
    const result = await indexability.recomputeAll();

    expect(result.changed).toBe(0);
    expect(result.opened).toBe(0);
    expect(result.closed).toBe(0);
    expect(result.categoryTranslations + result.tagTranslations).toBeGreaterThan(0);
  });
});
