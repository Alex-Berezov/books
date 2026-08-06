import { Language } from '@prisma/client';

/**
 * The pages the public site looks up by a hard-coded slug.
 *
 * Every one of these is found by a value an editor can change: the slug is
 * generated from the title in the admin form, so renaming the title used to
 * rewrite the key the site searches by. When that happens nothing errors — the
 * homepage falls back to dictionary strings and the four taxonomy hubs quietly
 * lose their metaTitle, metaDescription, h1, SEO text and FAQ. Losing the SEO
 * content of four hub pages looked exactly like normal operation.
 *
 * The permanent fix is an immutable key (`Page.systemKey`, see
 * `books-app-docs/tasks/system-pages-slug/TASK.md` §A2), which needs a
 * migration. Until then the breakage is at least no longer silent.
 */
export const SYSTEM_PAGE_SLUGS = [
  { slug: 'homepage-index', purpose: 'Homepage editorial content, FAQ and book collections' },
  { slug: 'taxonomy-categories-index', purpose: 'Categories hub: meta, H1, SEO text, FAQ' },
  { slug: 'taxonomy-genres-index', purpose: 'Genres hub: meta, H1, SEO text, FAQ' },
  { slug: 'taxonomy-collections-index', purpose: 'Collections hub: meta, H1, SEO text, FAQ' },
  { slug: 'taxonomy-tags-index', purpose: 'Tags hub: meta, H1, SEO text, FAQ' },
] as const;

/**
 * Every system page must exist in every supported language. This is not an
 * aspiration: all 25 combinations were verified published on production before
 * the rule was written, so a report from this check means something changed,
 * not that the site never met the bar.
 */
export const SYSTEM_PAGE_LANGUAGES: Language[] = Object.values(Language);
