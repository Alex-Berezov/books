/** One entry of `GET /{categories|tags}/:id/translations` — the fields these suites assert on. */
export type TranslationResponse = {
  language: string;
  slug: string;
  description: string | null;
  seoId: number | null;
  seo: Record<string, unknown> | null;
};

/**
 * Picks the translation for `language` from a `{items, pagination}` list body (`LEGACY-379`),
 * failing the test outright when the body has another shape or the language is missing.
 */
export const findTranslation = (body: unknown, language: string): TranslationResponse => {
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new Error('Expected a {items, pagination} list body');
  }
  const found = (items as TranslationResponse[]).find((t) => t.language === language);
  if (!found) {
    throw new Error(`No ${language} translation in response`);
  }
  return found;
};
