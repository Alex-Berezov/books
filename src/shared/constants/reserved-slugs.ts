/**
 * Slugs the frontend router already owns.
 *
 * A CMS page slug becomes the first path segment after the language prefix
 * (`/:lang/:slug`), which is the same place every static route of the frontend
 * lives. App Router resolves a static segment before a dynamic one, always — so
 * a page saved with the slug `catalog` is not a page with a conflict, it is a
 * page with no address at all. Uniqueness checks do not see this: the collision
 * is with a route, not with a row.
 *
 * ⚠️ The list mirrors the directories under `books-front/app/[lang]/`. The two
 * live in different repositories and are kept in step by hand — the same
 * arrangement as `SUPPORTED_LANGS`. What guards it is `yarn check:reserved-slugs`
 * in the frontend: it fails when a route exists that this list does not mention.
 * The guard runs where the routes are, so it catches a new route; it cannot
 * catch an entry deleted from here. Removing one is therefore a deliberate act.
 *
 * Taxonomy, book and author **slugs** are absent on purpose: they sit under a
 * prefix (`/:lang/category/:slug`, `/:lang/author/:slug`), so a category named
 * `book` collides with nothing.
 *
 * The prefixes themselves are a different matter and are listed: `author` and
 * `authors` are both here because `/:lang/author/:slug` and the hub at
 * `/:lang/authors` are real route segments, and a CMS page saved under either
 * name would have no address at all.
 */
export const RESERVED_SLUGS = [
  '403',
  'audiobooks',
  'auth',
  'author',
  'authors',
  'book',
  'bookshelf',
  'catalog',
  'categories',
  'category',
  'collection',
  'collections',
  'deletion',
  'genre',
  'genres',
  'listen',
  'new-releases',
  'popular-books',
  'privacy',
  'profile',
  'read',
  'summary',
  'tag',
  'tags',
  'terms',
  'versions',
] as const;

const RESERVED_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS);

/** True when the slug would be shadowed by a frontend route. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUG_SET.has(slug.trim().toLowerCase());
}

export const RESERVED_SLUG_MESSAGE =
  'This slug is reserved by a site route and would never be reachable. Choose another one.';
