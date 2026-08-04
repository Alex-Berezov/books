/**
 * Indexability thresholds for taxonomy pages (tag / genre / category / collection).
 *
 * A term with almost no books is thin content, but the threshold must not be
 * high: narrow pages collect long-tail queries well. Threshold is 3, not 10.
 *
 * Hysteresis keeps pages from flapping between indexable and noindex while the
 * book count oscillates around the threshold:
 *   - close  (noindex) when the count drops to CLOSE_AT_OR_BELOW or lower;
 *   - open   (index)   when the count reaches OPEN_AT_OR_ABOVE or higher;
 *   - in between, keep the previous state.
 *
 * The resulting state is persisted on the term translation
 * (`autoIndexable`), never recomputed on the fly — the sitemap and the robots
 * meta tag must agree at all times.
 */

/** Count at or below which the page is closed from indexing. */
export const CLOSE_AT_OR_BELOW = 2;

/** Count at or above which the page is re-opened for indexing. */
export const OPEN_AT_OR_ABOVE = 5;

/** Documented product threshold: pages with fewer books are not worth indexing. */
export const INDEXABLE_MIN_BOOKS = 3;

/**
 * Resolve the automatic indexability state.
 *
 * @param bookCount published books currently attached to the term in this language
 * @param previous previously stored state; defaults to open for a brand-new term
 */
export function resolveAutoIndexable(bookCount: number, previous: boolean): boolean {
  if (bookCount <= CLOSE_AT_OR_BELOW) return false;
  if (bookCount >= OPEN_AT_OR_ABOVE) return true;
  return previous;
}
