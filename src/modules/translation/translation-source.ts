import { Language } from '@prisma/client';
import { OriginalLanguage, resolveOriginalLanguage } from './original-language';

/**
 * Почему перевод с этой версии недоступен (решение арбитра `F05 | F05-2`, В8). Подписи - на
 * фронте по коду. Порядок проверок - порядок перечня. Один список на тип и Swagger.
 */
export const TRANSLATION_BLOCK_REASONS = [
  'SOURCE_LANGUAGE_UNKNOWN',
  'ORIGINAL_VERSION_MISSING',
  'ENGLISH_VERSION_MISSING',
  'NOT_ORIGINAL_VERSION',
  'NOT_ENGLISH_VERSION',
  'SOURCE_HAS_NO_CHAPTERS',
  'INTAKE_TARGETS_MISSING',
  // Исходник годен, но все языки закрыты своими причинами - переводить не на что.
  'NO_AVAILABLE_TARGETS',
] as const;
export type TranslationBlockReason = (typeof TRANSLATION_BLOCK_REASONS)[number];

/** Почему недоступен язык цели. Причину «на язык идёт перевод» добавит `F05-4`. */
export const TRANSLATION_TARGET_REASONS = ['IS_SOURCE', 'VERSION_EXISTS', 'NOT_IN_INTAKE'] as const;
export type TranslationTargetReason = (typeof TRANSLATION_TARGET_REASONS)[number];

export interface SourceCandidate {
  id: string;
  language: Language;
  originalLanguage: string | null;
  createdAt: Date;
  /** Глав с непустым `content`. */
  chaptersWithText: number;
}

export interface TranslationTarget {
  language: Language;
  available: boolean;
  reason: TranslationTargetReason | null;
}

export interface TranslationSource {
  canTranslate: boolean;
  reason: TranslationBlockReason | null;
  /** Исходник по D8; `null` - его нет (нет версии на языке оригинала или английской). */
  sourceVersionId: string | null;
  /** Язык исходника: язык оригинала из пяти или `en` для оригинала вне пяти. */
  sourceLanguage: Language | null;
  /** Значение поля, по которому выбран язык оригинала, - как записано. */
  originalLanguageRaw: string | null;
  /** У версий книги поле расходится (В1): выбор показан, но не закрывает перевод. */
  originalLanguageMismatch: boolean;
  targets: TranslationTarget[];
}

const SITE_LANGUAGES = Object.values(Language);

function sameLanguage(a: OriginalLanguage, b: OriginalLanguage): boolean {
  return a.kind !== 'unknown' && b.kind !== 'unknown' && a.code === b.code;
}

/**
 * Сведение поля по всем версиям книги (В1): распознанные совпали - оно; расходятся - значение
 * английской версии, иначе самой ранней. Нераспознанные непустые значения в выборе не
 * участвуют, но дают флаг расхождения.
 */
export function resolveBookOriginalLanguage(versions: readonly SourceCandidate[]): {
  language: OriginalLanguage;
  raw: string | null;
  mismatch: boolean;
} {
  const ordered = [...versions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const resolved = ordered.map((v) => ({ v, lang: resolveOriginalLanguage(v.originalLanguage) }));
  const recognized = resolved.filter((r) => r.lang.kind !== 'unknown');
  const unrecognized = resolved.some(
    (r) => r.lang.kind === 'unknown' && r.v.originalLanguage?.trim(),
  );
  if (recognized.length === 0) {
    return { language: { kind: 'unknown' }, raw: null, mismatch: unrecognized };
  }
  const agree = recognized.every((r) => sameLanguage(r.lang, recognized[0].lang));
  const chosen = agree
    ? recognized[0]
    : (recognized.find((r) => r.v.language === Language.en) ?? recognized[0]);
  return {
    language: chosen.lang,
    raw: chosen.v.originalLanguage,
    mismatch: !agree || unrecognized,
  };
}

/**
 * Выбор исходника перевода по D8 (`product.md` §2.1) для открытой версии. Перевода с перевода
 * нет: исходник один на книгу, остальные версии переводить не дают и называют его.
 *
 * `intakeTargets` - одобренные языки анкеты прав (`approvedTargetLanguages`), `null` - списка нет.
 */
export function selectTranslationSource(input: {
  versionId: string;
  versions: readonly SourceCandidate[];
  intakeTargets: readonly unknown[] | null;
}): TranslationSource {
  const { versions, intakeTargets } = input;
  const original = resolveBookOriginalLanguage(versions);
  const sourceLanguage = sourceLanguageOf(original.language);
  const source = sourceLanguage ? versions.find((v) => v.language === sourceLanguage) : undefined;

  let reason: TranslationBlockReason | null = null;
  if (!sourceLanguage) reason = 'SOURCE_LANGUAGE_UNKNOWN';
  else if (!source)
    reason =
      original.language.kind === 'site' ? 'ORIGINAL_VERSION_MISSING' : 'ENGLISH_VERSION_MISSING';
  else if (source.id !== input.versionId)
    reason = original.language.kind === 'site' ? 'NOT_ORIGINAL_VERSION' : 'NOT_ENGLISH_VERSION';
  else if (source.chaptersWithText === 0) reason = 'SOURCE_HAS_NO_CHAPTERS';
  else if (!intakeTargets) reason = 'INTAKE_TARGETS_MISSING';

  const existing = new Set(versions.map((v) => v.language));
  const targetReason = (language: Language): TranslationTargetReason | null => {
    if (language === sourceLanguage) return 'IS_SOURCE';
    if (existing.has(language)) return 'VERSION_EXISTS';
    if (!intakeTargets?.includes(language)) return 'NOT_IN_INTAKE';
    return null;
  };
  const own = SITE_LANGUAGES.map((language) => ({ language, reason: targetReason(language) }));
  // Последней в порядке В8: свёртка уже посчитанных причин целей, не своё правило языков.
  if (reason === null && own.every((t) => t.reason !== null)) reason = 'NO_AVAILABLE_TARGETS';
  const targets = own.map(
    (t): TranslationTarget => ({ ...t, available: reason === null && t.reason === null }),
  );

  return {
    canTranslate: reason === null,
    reason,
    sourceVersionId: source?.id ?? null,
    sourceLanguage,
    originalLanguageRaw: original.raw,
    originalLanguageMismatch: original.mismatch,
    targets,
  };
}

/** Язык исходника: оригинал из пяти - он, оригинал вне пяти - английский, не распознан - нет. */
function sourceLanguageOf(original: OriginalLanguage): Language | null {
  if (original.kind === 'site') return original.code;
  if (original.kind === 'other') return Language.en;
  return null;
}

/**
 * Версия, по которой строится досье (Р5): исходник D8 с текстом глав - его; исходника нет или
 * у него нет глав с текстом - сама версия (решение арбитра `F05 | F05-2`, В10): заготовка
 * работает на любой версии с текстом (`product.md` §5.1 п.1). Версия, созданная переводом,
 * берёт досье своего запуска (Р18) - это `F05-4`.
 */
export function dossierSourceVersionId(
  source: TranslationSource,
  versions: readonly SourceCandidate[],
  versionId: string,
): string {
  const candidate = versions.find((v) => v.id === source.sourceVersionId);
  return candidate && candidate.chaptersWithText > 0 ? candidate.id : versionId;
}
