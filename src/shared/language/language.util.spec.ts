import { Language } from '@prisma/client';
import {
  getDefaultLanguage,
  parseAcceptLanguage,
  resolveRequestedLanguage,
  getSupportedLanguages,
} from './language.util';

describe('language.util', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  describe('parseAcceptLanguage', () => {
    it('returns empty array for empty/undefined header', () => {
      expect(parseAcceptLanguage()).toEqual([]);
      expect(parseAcceptLanguage('')).toEqual([]);
    });

    it('parses simple list and orders by q', () => {
      const header = 'fr-FR;q=0.7, en;q=1, es;q=0.9';
      // should reduce fr-FR -> fr and sort by q: en (1), es (0.9), fr (0.7)
      expect(parseAcceptLanguage(header)).toEqual(['en', 'es', 'fr']);
    });

    it('treats missing q as 1 and invalid q as 0', () => {
      const header = 'pt, fr;q=foo, es;q=0.5';
      // pt -> q=1, fr -> q=0 (invalid), es -> q=0.5
      expect(parseAcceptLanguage(header)).toEqual(['pt', 'es', 'fr']);
    });

    it('is robust to malformed input', () => {
      // Random malformed string should not throw and return []
      expect(parseAcceptLanguage(';=,;;;')).toEqual([]);
    });
  });

  describe('getDefaultLanguage', () => {
    it('returns env DEFAULT_LANGUAGE when supported', () => {
      process.env.DEFAULT_LANGUAGE = 'fr';
      expect(getDefaultLanguage()).toBe('fr');
    });

    it('falls back to en when env is missing/unsupported', () => {
      delete process.env.DEFAULT_LANGUAGE;
      expect(getDefaultLanguage()).toBe('en');

      process.env.DEFAULT_LANGUAGE = 'zz';
      expect(getDefaultLanguage()).toBe('en');
    });
  });

  describe('resolveRequestedLanguage', () => {
    it('prefers explicit queryLang when valid', () => {
      const lang = resolveRequestedLanguage({
        queryLang: 'es',
        acceptLanguage: 'fr',
        available: undefined,
      });
      expect(lang).toBe('es');
    });

    it('falls back to Accept-Language order when query is absent/invalid', () => {
      const lang = resolveRequestedLanguage({
        queryLang: undefined,
        acceptLanguage: 'fr;q=0.6, pt;q=0.9',
        available: undefined,
      });
      expect(lang).toBe('pt');
    });

    it('returns DEFAULT_LANGUAGE when no query/header matches', () => {
      process.env.DEFAULT_LANGUAGE = 'fr';
      const lang = resolveRequestedLanguage({
        queryLang: undefined,
        acceptLanguage: 'zz, xx',
        available: undefined,
      });
      expect(lang).toBe('fr');
    });

    it('honors available list: rejects unsupported values and returns default only if available', () => {
      process.env.DEFAULT_LANGUAGE = 'en';
      // available: only pt
      const available: Language[] = ['pt'] as unknown as Language[];

      // header proposes es (not in available) -> try default en (also not in available) -> undefined
      const none = resolveRequestedLanguage({
        queryLang: undefined,
        acceptLanguage: 'es',
        available,
      });
      expect(none).toBeUndefined();

      // when query matches available -> selected
      const q = resolveRequestedLanguage({ queryLang: 'pt', acceptLanguage: 'es', available });
      expect(q).toBe('pt');
    });

    it('handles case-insensitive inputs', () => {
      process.env.DEFAULT_LANGUAGE = 'EN';
      const lang = resolveRequestedLanguage({
        queryLang: 'Fr',
        acceptLanguage: 'ES;q=1',
        available: undefined,
      });
      expect(lang).toBe('fr');
    });
  });

  describe('getSupportedLanguages', () => {
    it('returns the same set as Prisma Language enum', () => {
      const fromUtil = new Set(getSupportedLanguages());
      const fromEnum = new Set(Object.values(Language));
      expect(fromUtil).toEqual(fromEnum);
    });
  });
});
