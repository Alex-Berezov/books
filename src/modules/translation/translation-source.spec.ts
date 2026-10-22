import { Language } from '@prisma/client';
import {
  dossierSourceVersionId,
  selectTranslationSource,
  SourceCandidate,
} from './translation-source';

const ALL = ['en', 'es', 'fr', 'pt', 'ru'];

let clock = 0;
function version(
  language: Language,
  originalLanguage: string | null,
  chaptersWithText = 3,
): SourceCandidate {
  clock += 1;
  return {
    id: `v-${language}`,
    language,
    originalLanguage,
    createdAt: new Date(2026, 0, clock),
    chaptersWithText,
  };
}

const select = (
  versionId: string,
  versions: SourceCandidate[],
  intakeTargets: unknown[] | null = ALL,
) => selectTranslationSource({ versionId, versions, intakeTargets });

const reasons = (r: ReturnType<typeof select>) =>
  Object.fromEntries(r.targets.map((t) => [t.language, t.available ? 'ok' : t.reason]));

describe('selectTranslationSource (D8, product.md §2.1)', () => {
  beforeEach(() => {
    clock = 0;
  });

  it('original among the five with its version: only that version translates', () => {
    const versions = [version('ru', 'русский'), version('en', 'Russian')];
    const fromRu = select('v-ru', versions);
    expect(fromRu).toMatchObject({
      canTranslate: true,
      reason: null,
      sourceVersionId: 'v-ru',
      sourceLanguage: 'ru',
      originalLanguageRaw: 'русский',
      originalLanguageMismatch: false,
    });
    expect(reasons(fromRu)).toEqual({
      en: 'VERSION_EXISTS',
      es: 'ok',
      fr: 'ok',
      pt: 'ok',
      ru: 'IS_SOURCE',
    });
    // Перевода с перевода нет: английская версия называет исходник.
    expect(select('v-en', versions)).toMatchObject({
      canTranslate: false,
      reason: 'NOT_ORIGINAL_VERSION',
      sourceVersionId: 'v-ru',
    });
  });

  it('original among the five without its version: blocked everywhere, English is not substituted (Р14)', () => {
    const versions = [version('en', 'French'), version('es', 'francés')];
    for (const id of ['v-en', 'v-es']) {
      expect(select(id, versions)).toMatchObject({
        canTranslate: false,
        reason: 'ORIGINAL_VERSION_MISSING',
        sourceVersionId: null,
        sourceLanguage: 'fr',
      });
    }
  });

  it('the original version added later becomes the source (Р14)', () => {
    const versions = [version('en', 'French')];
    expect(select('v-en', versions).reason).toBe('ORIGINAL_VERSION_MISSING');
    const withFr = [...versions, version('fr', 'français')];
    expect(select('v-fr', withFr)).toMatchObject({ canTranslate: true, sourceVersionId: 'v-fr' });
    expect(select('v-en', withFr)).toMatchObject({
      reason: 'NOT_ORIGINAL_VERSION',
      sourceVersionId: 'v-fr',
    });
  });

  it('original outside the five: translate from English', () => {
    const versions = [version('en', 'Deutsch'), version('ru', 'немецкий')];
    const fromEn = select('v-en', versions);
    expect(fromEn).toMatchObject({
      canTranslate: true,
      sourceVersionId: 'v-en',
      sourceLanguage: 'en',
      originalLanguageMismatch: false,
    });
    expect(reasons(fromEn)).toMatchObject({ en: 'IS_SOURCE', ru: 'VERSION_EXISTS', es: 'ok' });
    expect(select('v-ru', versions)).toMatchObject({
      reason: 'NOT_ENGLISH_VERSION',
      sourceVersionId: 'v-en',
    });
  });

  it('original outside the five without English: blocked', () => {
    expect(select('v-ru', [version('ru', 'German')])).toMatchObject({
      canTranslate: false,
      reason: 'ENGLISH_VERSION_MISSING',
      sourceVersionId: null,
      sourceLanguage: 'en',
    });
  });

  it('empty or unrecognized field: blocked with "set the original language"', () => {
    expect(select('v-en', [version('en', null)]).reason).toBe('SOURCE_LANGUAGE_UNKNOWN');
    expect(select('v-en', [version('en', '  ')]).reason).toBe('SOURCE_LANGUAGE_UNKNOWN');
    const unknown = select('v-en', [version('en', 'Klingon dialect')]);
    expect(unknown).toMatchObject({
      reason: 'SOURCE_LANGUAGE_UNKNOWN',
      sourceLanguage: null,
      originalLanguageMismatch: true,
    });
    expect(unknown.targets.every((t) => !t.available)).toBe(true);
  });

  it('versions disagree: the English value wins, the mismatch is shown, nothing is blocked by it (В1)', () => {
    const versions = [version('fr', 'English'), version('en', 'French')];
    const r = select('v-fr', versions);
    expect(r).toMatchObject({
      canTranslate: true,
      sourceVersionId: 'v-fr',
      sourceLanguage: 'fr',
      originalLanguageRaw: 'French',
      originalLanguageMismatch: true,
    });
  });

  it('versions disagree without English: the earliest version wins (В1)', () => {
    const versions = [version('es', 'ruso'), version('fr', 'espagnol'), version('ru', 'русский')];
    expect(select('v-ru', versions)).toMatchObject({
      sourceLanguage: 'ru',
      sourceVersionId: 'v-ru',
      originalLanguageRaw: 'ruso',
      originalLanguageMismatch: true,
      canTranslate: true,
    });
  });

  it('an unrecognized value on one version does not choose, only flags (В1)', () => {
    const versions = [version('ru', 'Klingon'), version('en', 'Russian')];
    expect(select('v-ru', versions)).toMatchObject({
      sourceLanguage: 'ru',
      originalLanguageRaw: 'Russian',
      originalLanguageMismatch: true,
      canTranslate: true,
    });
    // Пустое поле расхождением не считается.
    expect(
      select('v-ru', [version('ru', null), version('en', 'Russian')]).originalLanguageMismatch,
    ).toBe(false);
  });

  it('the source without chapter text: blocked, English is not substituted', () => {
    const versions = [version('ru', 'русский', 0), version('en', 'Russian')];
    expect(select('v-ru', versions)).toMatchObject({
      canTranslate: false,
      reason: 'SOURCE_HAS_NO_CHAPTERS',
      sourceVersionId: 'v-ru',
    });
    expect(select('v-en', versions).reason).toBe('NOT_ORIGINAL_VERSION');
  });

  it('languages outside the rights intake are unavailable (Р6)', () => {
    const r = select('v-en', [version('en', 'English')], ['en', 'fr']);
    expect(reasons(r)).toEqual({
      en: 'IS_SOURCE',
      es: 'NOT_IN_INTAKE',
      fr: 'ok',
      pt: 'NOT_IN_INTAKE',
      ru: 'NOT_IN_INTAKE',
    });
  });

  it('no intake list: blocked, every target says why (В8)', () => {
    const r = select('v-en', [version('en', 'English'), version('ru', 'English')], null);
    expect(r).toMatchObject({ canTranslate: false, reason: 'INTAKE_TARGETS_MISSING' });
    expect(reasons(r)).toEqual({
      en: 'IS_SOURCE',
      es: 'NOT_IN_INTAKE',
      fr: 'NOT_IN_INTAKE',
      pt: 'NOT_IN_INTAKE',
      ru: 'VERSION_EXISTS',
    });
  });

  it('a blocked source keeps target reasons but no target is available', () => {
    const r = select('v-en', [version('en', 'English', 0)]);
    expect(r.reason).toBe('SOURCE_HAS_NO_CHAPTERS');
    expect(r.targets.map((t) => t.available)).toEqual([false, false, false, false, false]);
    expect(r.targets.find((t) => t.language === 'es')?.reason).toBeNull();
  });

  it('every target closed by its own reason: blocked NO_AVAILABLE_TARGETS, reasons kept (В8)', () => {
    const versions = [version('en', 'English'), version('es', 'English'), version('fr', 'English')];
    const r = select('v-en', versions, ['en', 'es', 'fr']);
    expect(r).toMatchObject({
      canTranslate: false,
      reason: 'NO_AVAILABLE_TARGETS',
      sourceVersionId: 'v-en',
    });
    expect(reasons(r)).toEqual({
      en: 'IS_SOURCE',
      es: 'VERSION_EXISTS',
      fr: 'VERSION_EXISTS',
      pt: 'NOT_IN_INTAKE',
      ru: 'NOT_IN_INTAKE',
    });
  });

  it('one target still open: translation stays available', () => {
    const r = select(
      'v-en',
      [version('en', 'English'), version('es', 'English')],
      ['en', 'es', 'ru'],
    );
    expect(r).toMatchObject({ canTranslate: true, reason: null });
    expect(r.targets.filter((t) => t.available).map((t) => t.language)).toEqual(['ru']);
  });

  it('dossier source: the D8 source with text, else the version itself (Р5, В10)', () => {
    const versions = [version('ru', 'русский'), version('en', 'Russian')];
    expect(dossierSourceVersionId(select('v-en', versions), versions, 'v-en')).toBe('v-ru');
    const noSource = [version('en', 'French')];
    expect(dossierSourceVersionId(select('v-en', noSource), noSource, 'v-en')).toBe('v-en');
    // Исходник без глав с текстом для досье считается «исходника нет»: досье по своей версии.
    const emptySource = [version('ru', 'русский', 0), version('en', 'Russian')];
    expect(dossierSourceVersionId(select('v-en', emptySource), emptySource, 'v-en')).toBe('v-en');
    // Открыт сам исходник без текста: досье по нему (кнопка ответит 409 без глав).
    expect(dossierSourceVersionId(select('v-ru', emptySource), emptySource, 'v-ru')).toBe('v-ru');
  });
});
