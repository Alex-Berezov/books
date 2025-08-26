import { Language } from '@prisma/client';

// Supported languages as a Set for fast membership checks
const SUPPORTED = new Set<Language>(Object.values(Language));

export function getDefaultLanguage(): Language {
  const env = (process.env.DEFAULT_LANGUAGE || 'en').toLowerCase();
  const maybe = env as Language;
  return SUPPORTED.has(maybe) ? maybe : Language.en;
}

// Very small Accept-Language parser: returns ordered list of tags (lang only) by quality
export function parseAcceptLanguage(header?: string): string[] {
  if (!header) return [];
  try {
    const parts = header.split(',').map((p) => p.trim());
    const parsed = parts
      .map((part) => {
        const [tag, ...params] = part.split(';').map((s) => s.trim());
        const qParam = params.find((x) => x.startsWith('q='));
        const q = qParam ? Number(qParam.slice(2)) : 1;
        // reduce fr-FR -> fr
        const base = tag.toLowerCase().split('-')[0];
        return { tag: base, q: isNaN(q) ? 0 : q } as const;
      })
      .filter((x) => !!x.tag)
      .sort((a, b) => b.q - a.q);
    return parsed.map((x) => x.tag);
  } catch {
    return [];
  }
}

/**
 * Resolve requested language using query -> Accept-Language -> DEFAULT_LANGUAGE.
 * Optionally restrict to available list; if provided, returns only a lang that exists in available.
 */
export function resolveRequestedLanguage(options: {
  queryLang?: string | null;
  acceptLanguage?: string | null;
  available?: Language[];
}): Language | undefined {
  const availableSet = options.available ? new Set(options.available) : undefined;

  const validate = (value?: string | null): Language | undefined => {
    if (!value) return undefined;
    const lower = value.toLowerCase();
    const lang = lower as Language;
    if (!SUPPORTED.has(lang)) return undefined;
    if (availableSet && !availableSet.has(lang)) return undefined;
    return lang;
  };

  // 1) explicit query
  const q = validate(options.queryLang);
  if (q) return q;

  // 2) Accept-Language header by preference order
  for (const tag of parseAcceptLanguage(options.acceptLanguage || undefined)) {
    const candidate = validate(tag);
    if (candidate) return candidate;
  }

  // 3) DEFAULT_LANGUAGE
  const def = getDefaultLanguage();
  if (!availableSet || availableSet.has(def)) return def;

  return undefined;
}

export function getSupportedLanguages(): Language[] {
  return Object.values(Language);
}
