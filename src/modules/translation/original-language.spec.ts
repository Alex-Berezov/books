import { Language } from '@prisma/client';
import { normalizeLanguageName, resolveOriginalLanguage } from './original-language';

/** Названия пяти языков сайта на пяти локалях сайта - как их пишет редактор. */
const NAMES: Record<Language, Record<Language, string>> = {
  en: { en: 'English', es: 'inglés', fr: 'anglais', pt: 'inglês', ru: 'английский' },
  es: { en: 'Spanish', es: 'español', fr: 'espagnol', pt: 'espanhol', ru: 'испанский' },
  fr: { en: 'French', es: 'francés', fr: 'français', pt: 'francês', ru: 'французский' },
  pt: { en: 'Portuguese', es: 'portugués', fr: 'portugais', pt: 'português', ru: 'португальский' },
  ru: { en: 'Russian', es: 'ruso', fr: 'russe', pt: 'russo', ru: 'русский' },
};

describe('resolveOriginalLanguage (Р10)', () => {
  for (const code of Object.values(Language)) {
    for (const locale of Object.values(Language)) {
      const name = NAMES[code][locale];
      it(`${locale} name "${name}" -> ${code}`, () => {
        expect(resolveOriginalLanguage(name)).toEqual({ kind: 'site', code });
      });
    }
    it(`code ${code} and its upper case -> ${code}`, () => {
      expect(resolveOriginalLanguage(code)).toEqual({ kind: 'site', code });
      expect(resolveOriginalLanguage(code.toUpperCase())).toEqual({ kind: 'site', code });
    });
  }

  it('keeps es and pt apart', () => {
    expect(resolveOriginalLanguage('espanhol')).toEqual({ kind: 'site', code: 'es' });
    expect(resolveOriginalLanguage('portugués')).toEqual({ kind: 'site', code: 'pt' });
    expect(resolveOriginalLanguage('spa')).toEqual({ kind: 'site', code: 'es' });
    expect(resolveOriginalLanguage('por')).toEqual({ kind: 'site', code: 'pt' });
  });

  it('ignores case, diacritics, spaces and the word "language"', () => {
    expect(resolveOriginalLanguage('  FRANCAIS ')).toEqual({ kind: 'site', code: 'fr' });
    expect(resolveOriginalLanguage('Français')).toEqual({ kind: 'site', code: 'fr' });
    expect(resolveOriginalLanguage('Английский язык')).toEqual({ kind: 'site', code: 'en' });
    expect(resolveOriginalLanguage('English language')).toEqual({ kind: 'site', code: 'en' });
  });

  it('reduces tags with a region to the base language', () => {
    expect(resolveOriginalLanguage('pt-BR')).toEqual({ kind: 'site', code: 'pt' });
    expect(resolveOriginalLanguage('en_GB')).toEqual({ kind: 'site', code: 'en' });
    expect(resolveOriginalLanguage('de-AT')).toEqual({ kind: 'other', code: 'de' });
  });

  it('recognizes languages outside the five by code and by name on the site locales', () => {
    expect(resolveOriginalLanguage('Deutsch')).toEqual({ kind: 'other', code: 'de' });
    expect(resolveOriginalLanguage('немецкий')).toEqual({ kind: 'other', code: 'de' });
    expect(resolveOriginalLanguage('German')).toEqual({ kind: 'other', code: 'de' });
    expect(resolveOriginalLanguage('allemand')).toEqual({ kind: 'other', code: 'de' });
    expect(resolveOriginalLanguage('de')).toEqual({ kind: 'other', code: 'de' });
    expect(resolveOriginalLanguage('Italian')).toEqual({ kind: 'other', code: 'it' });
    expect(resolveOriginalLanguage('польский')).toEqual({ kind: 'other', code: 'pl' });
  });

  it('empty or unrecognized -> unknown', () => {
    expect(resolveOriginalLanguage(null)).toEqual({ kind: 'unknown' });
    expect(resolveOriginalLanguage(undefined)).toEqual({ kind: 'unknown' });
    expect(resolveOriginalLanguage('')).toEqual({ kind: 'unknown' });
    expect(resolveOriginalLanguage('   ')).toEqual({ kind: 'unknown' });
    expect(resolveOriginalLanguage('Klingon-ish dialect')).toEqual({ kind: 'unknown' });
    expect(resolveOriginalLanguage('xx')).toEqual({ kind: 'unknown' });
  });

  it('the word "language" with the feminine adjective is recognized on every locale', () => {
    expect(resolveOriginalLanguage('langue française')).toEqual({ kind: 'site', code: 'fr' });
    expect(resolveOriginalLanguage('lengua española')).toEqual({ kind: 'site', code: 'es' });
    expect(resolveOriginalLanguage('língua portuguesa')).toEqual({ kind: 'site', code: 'pt' });
    expect(resolveOriginalLanguage('língua inglesa')).toEqual({ kind: 'site', code: 'en' });
    expect(resolveOriginalLanguage('lingua russa')).toEqual({ kind: 'site', code: 'ru' });
    expect(resolveOriginalLanguage('langue anglaise')).toEqual({ kind: 'site', code: 'en' });
  });

  it('historical languages are outside the five and never fold into a site language (Р10)', () => {
    expect(resolveOriginalLanguage('Ancient Greek')).toEqual({ kind: 'other', code: 'grc' });
    expect(resolveOriginalLanguage('древнегреческий')).toEqual({ kind: 'other', code: 'grc' });
    expect(resolveOriginalLanguage('grc')).toEqual({ kind: 'other', code: 'grc' });
    expect(resolveOriginalLanguage('Old English')).toEqual({ kind: 'other', code: 'ang' });
    expect(resolveOriginalLanguage('Middle English')).toEqual({ kind: 'other', code: 'enm' });
    expect(resolveOriginalLanguage('Old French')).toEqual({ kind: 'other', code: 'fro' });
    expect(resolveOriginalLanguage('Greek')).toEqual({ kind: 'other', code: 'el' });
    expect(resolveOriginalLanguage('el')).toEqual({ kind: 'other', code: 'el' });
  });

  it('normalizeLanguageName strips marks and filler words', () => {
    expect(normalizeLanguageName('Português (Brasil)')).toBe('portugues');
    expect(normalizeLanguageName('Langue  française')).toBe('francaise');
  });
});
