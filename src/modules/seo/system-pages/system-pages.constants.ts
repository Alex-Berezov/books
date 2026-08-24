import { Language } from '@prisma/client';

/**
 * The pages the public site looks up for itself, addressed by an immutable key.
 *
 * Until 09.08.2026 the address was the slug — a field the admin form generates
 * from the title, so renaming the title rewrote the value the site searches by.
 * Nothing errored when that happened: the homepage fell back to dictionary
 * strings and the four taxonomy hubs quietly lost their metaTitle,
 * metaDescription, h1, SEO text and FAQ. Losing the SEO content of four hub
 * pages looked exactly like normal operation, and it did happen in production —
 * `homepage-index` became `homepage` on an ordinary save.
 *
 * `Page.systemKey` is now that address. It is not editable — the field is absent
 * from the page DTOs, so `forbidNonWhitelisted` answers 400 to any attempt to
 * send it. The slug went back to being an ordinary field: changing it moves the
 * page's public URL (and leaves a redirect, see `seo-rules.md`) but no longer
 * severs anything.
 *
 * The keys were backfilled from these slugs by
 * `prisma/migrations/20260809000000_page_system_key`:
 * `homepage-index`, `taxonomy-{categories,genres,collections,tags}-index`.
 */
export const SYSTEM_PAGE_KEYS = [
  { key: 'homepage', purpose: 'Homepage editorial content, FAQ and book collections' },
  { key: 'taxonomy-categories', purpose: 'Categories hub: meta, H1, SEO text, FAQ' },
  { key: 'taxonomy-genres', purpose: 'Genres hub: meta, H1, SEO text, FAQ' },
  { key: 'taxonomy-collections', purpose: 'Collections hub: meta, H1, SEO text, FAQ' },
  { key: 'taxonomy-tags', purpose: 'Tags hub: meta, H1, SEO text, FAQ' },
  // Не `taxonomy-authors`: автор не термин таксономии. `TaxonomyType` его не
  // включает, и хаб авторов рисуется своей формой карточки, а не `TaxonomyOverview`.
  { key: 'authors-hub', purpose: 'Authors hub: meta, H1, SEO text, FAQ' },
] as const;

export type SystemPageKey = (typeof SYSTEM_PAGE_KEYS)[number]['key'];

/**
 * The accepted values of `GET /:lang/pages/by-key/:systemKey`. A closed list, so
 * the route cannot be used to enumerate arbitrary pages by a column an editor
 * never sees.
 */
export const SYSTEM_PAGE_KEY_VALUES: SystemPageKey[] = SYSTEM_PAGE_KEYS.map((p) => p.key);

export const isSystemPageKey = (value: string): value is SystemPageKey =>
  (SYSTEM_PAGE_KEY_VALUES as string[]).includes(value);

/**
 * Every system page must exist in every supported language. This is not an
 * aspiration: all 25 combinations were verified published on production before
 * the rule was written, so a report from this check means something changed,
 * not that the site never met the bar.
 */
export const SYSTEM_PAGE_LANGUAGES: Language[] = Object.values(Language);
