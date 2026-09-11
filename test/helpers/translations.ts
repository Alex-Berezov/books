/** One entry of `GET /{categories|tags}/:id/translations` — the fields these suites assert on. */
export type TranslationResponse = {
  language: string;
  slug: string;
  description: string | null;
  seoId: number | null;
  seo: Record<string, unknown> | null;
};

/** Picks the translation for `language`, failing the test outright when it is missing. */
export const findTranslation = (body: unknown, language: string): TranslationResponse => {
  const found = (body as TranslationResponse[]).find((t) => t.language === language);
  if (!found) {
    throw new Error(`No ${language} translation in response`);
  }
  return found;
};
