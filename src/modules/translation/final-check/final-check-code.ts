import { Language } from '@prisma/client';
import { formFound, NameEntry, normalized } from '../check/mechanical-check';
import {
  FINAL_FINDING_CODES,
  FINAL_FRAGMENT_CHARS,
  FinalFindingCode,
} from './final-check.constants';

/**
 * Итоговая проверка кодом (`F05-6`, шаг 5): главы исходника ↔ главы перевода по номерам, ни одной
 * пустой, прогон глоссария по всему тексту языка. Модель здесь не зовётся - она в шаге языка.
 */

/** Находка итоговой проверки на главе: код и опора в тексте (форма, фрагмент или номер блока). */
export interface FinalFinding {
  code: FinalFindingCode;
  /** Запись глоссария (`GLOSSARY_SOURCE_FORM`). */
  key?: string;
  form?: string;
  target?: string;
  fragment?: string;
  /** Номер блока исходника, о котором замечание модели. */
  block?: number;
  issue?: string;
  model?: string;
  costUsd?: string;
}

/** Глава языка на итоговой проверке: номер, собранный перевод без разметки, блоков текста в исходнике. */
export interface FinalChapter {
  number: number;
  /** `null` - собранного текста нет: глава с флагом (Р8, кусок без перевода) или её нет вовсе. */
  text: string | null;
  sourceBlocks: number;
  /** У языка есть строка этой главы: нет - глава пропала, а не помечена флагом сборки. */
  inTranslation: boolean;
}

const wordsIn = (text: string) => normalized(text).match(/\p{L}+/gu) ?? [];

/**
 * Записи глоссария, исходная форма которых в переводе - второе, несовместимое написание имени
 * (решение арбитра `F05 | F05-6`, 6c В7): не `keepOriginal`, целевая форма не совпадает с исходной
 * по `formFound`, исходная форма - не целевая форма другой записи.
 */
export function divergentEntries(entries: readonly NameEntry[], language: Language): NameEntry[] {
  // Слова целевых форм - один раз на запись, а не на каждую пару (глоссарий бывает в тысячи записей).
  const targets = entries.map((e) => wordsIn(e.target));
  return entries.filter(
    (e, i) =>
      !e.keepOriginal &&
      e.source.trim() !== '' &&
      !formFound(e.source, targets[i], language) &&
      !targets.some((words, j) => j !== i && formFound(e.source, words, language)),
  );
}

/**
 * Фрагмент текста вокруг первого слова формы целым словом, как ищет `formFound` («Anna» - не
 * в «Annabel»); не нашлось (диакритика, падеж) - сама форма.
 */
export function fragmentOf(text: string, form: string): string {
  const first = form.match(/\p{L}+/u)?.[0];
  if (!first) return form;
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'iu').exec(text);
  if (!match) return form;
  const from = Math.max(0, match.index - FINAL_FRAGMENT_CHARS);
  return text.slice(from, match.index + first.length + FINAL_FRAGMENT_CHARS).trim();
}

/**
 * Находки кодом по главам и номера глав исходника, которых нет среди глав перевода. Главы без
 * текста в исходнике пропускаются (решение арбитра `F05 | F05-6`: пустая глава исходника -
 * пустая глава перевода); глава с флагом сборки - не пропавшая: её причина уже в отчёте
 * (`notWrittenChapters`), второй раз её не называем.
 */
export function finalCodeCheck(
  chapters: readonly FinalChapter[],
  glossary: readonly NameEntry[],
  language: Language,
): { missing: number[]; findings: Map<number, FinalFinding[]> } {
  const missing: number[] = [];
  const findings = new Map<number, FinalFinding[]>();
  const divergent = divergentEntries(glossary, language);
  for (const chapter of chapters) {
    if (chapter.sourceBlocks === 0) continue;
    if (!chapter.inTranslation) {
      missing.push(chapter.number);
      continue;
    }
    if (chapter.text === null) continue;
    const found: FinalFinding[] = [];
    if (chapter.text.trim() === '') {
      found.push({ code: FINAL_FINDING_CODES.CHAPTER_EMPTY });
    } else {
      const words = wordsIn(chapter.text);
      for (const e of divergent) {
        if (!formFound(e.source, words, language)) continue;
        found.push({
          code: FINAL_FINDING_CODES.GLOSSARY_SOURCE_FORM,
          key: e.key,
          form: e.source,
          target: e.target,
          fragment: fragmentOf(chapter.text, e.source),
        });
      }
    }
    if (found.length > 0) findings.set(chapter.number, found);
  }
  return { missing, findings };
}
