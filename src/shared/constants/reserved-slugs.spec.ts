import { isReservedSlug, RESERVED_SLUGS } from './reserved-slugs';

describe('reserved slugs', () => {
  it('claims every route segment the frontend serves under /:lang', () => {
    // Spot-checks, not a copy of the list: these are the segments an editor is
    // most likely to reach for, and each one is a real page in the site.
    for (const slug of ['catalog', 'privacy', 'terms', 'book', 'author', 'tag', 'read']) {
      expect(isReservedSlug(slug)).toBe(true);
    }
  });

  it('leaves ordinary slugs alone', () => {
    for (const slug of ['about-us', 'war-and-peace', 'catalogue', 'books', 'my-catalog']) {
      expect(isReservedSlug(slug)).toBe(false);
    }
  });

  it('matches on the whole segment, not a prefix', () => {
    // `catalog-2` is what the suggestion builder offers when `catalog` is
    // refused. If reservation matched prefixes, the suggestion would be refused
    // too and the editor would have nowhere to go.
    expect(isReservedSlug('catalog-2')).toBe(false);
    expect(isReservedSlug('book-club')).toBe(false);
  });

  it('normalises case and surrounding whitespace', () => {
    expect(isReservedSlug('Catalog')).toBe(true);
    expect(isReservedSlug(' catalog ')).toBe(true);
  });

  it('holds no duplicates and no entry that fails the slug format', () => {
    expect(new Set(RESERVED_SLUGS).size).toBe(RESERVED_SLUGS.length);
    for (const slug of RESERVED_SLUGS) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});
