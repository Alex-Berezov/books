import { Language, Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { ANSWER_CHARS_PER_TOKEN } from '../../llm/openrouter.client';
import { ChapterLayout, splitChapter } from '../chapter-blocks';
import {
  ChapterChunk,
  ContestedWindow,
  fallbackBoundary,
  planChunks,
} from '../chunking/chapter-chunks';
import { DOSSIER_STAGE, GLOSSARY_STAGE } from '../dossier/dossier.constants';
import type { DossierService } from '../dossier/dossier.service';
import { SPLIT_STAGE, TRANSLATE_TAIL_MAX_CHARS } from './translate.constants';
import { pieceInput } from './translate-piece';
import { splitRequest, translateRequest } from './translate.prompts';

/**
 * Оценка перевода главы сверху - общая у сравнения (`F05-3`) и запуска (`F05-4b`): куски по
 * границам кода, каждый спорный стык - вызов `split`, каждый кусок - вызов `translate` с хвостом
 * прошлого куска наибольшей длины.
 */

export interface ChapterPlan {
  number: number;
  layout: ChapterLayout;
  chunks: ChapterChunk[];
  /** Спорные стыки по границам кода: каждый - вызов `split` в оценке сверху. */
  windows: ContestedWindow[];
}

export async function planChapter(number: number, content: string): Promise<ChapterPlan> {
  const layout = splitChapter(content);
  const windows: ContestedWindow[] = [];
  const chunks = await planChunks(layout, (w) => {
    windows.push(w);
    return Promise.resolve(fallbackBoundary(w));
  });
  return { number, layout, chunks, windows };
}

/** Есть ли в главе что переводить: `hr` и картинки без подписей - нет. */
export function hasTranslatableText(plan: ChapterPlan): boolean {
  return plan.layout.blocks.some((b) => b.translatable);
}

/** Все куски главы одной моделью; `extra` - вход сверх промпта (досье и глоссарий не готовы). */
export function chapterTranslateUsd(
  call: StageCallEstimator,
  plan: ChapterPlan,
  context: {
    dossier: unknown;
    glossary: unknown;
    sourceLanguage: Language;
    targetLanguage: Language;
    extra: number;
  },
): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  for (let index = 0; index < plan.chunks.length; index++) {
    const request = translateRequest(
      pieceInput({
        layout: plan.layout,
        chunks: plan.chunks,
        index,
        dossier: context.dossier,
        glossary: context.glossary,
        sourceLanguage: context.sourceLanguage,
        targetLanguage: context.targetLanguage,
        chapterNumber: plan.number,
        previousTail: index > 0 ? 'x'.repeat(TRANSLATE_TAIL_MAX_CHARS) : null,
      }),
    );
    total = total.add(call.estimate(request, context.extra));
  }
  return total;
}

/** Спорные стыки главы моделью `split`; этап недоступен - ноль (стыки ставит код, Р7). */
export function chapterSplitUsd(
  split: StageCallEstimator | null,
  plan: ChapterPlan,
): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  if (split) for (const w of plan.windows) total = total.add(split.estimate(splitRequest(w)));
  return total;
}

/** `split` выключен или без цены - не отказ: стыки ставит код (Р7), оценка - ноль. */
export async function splitEstimator(llm: LlmService): Promise<StageCallEstimator | null> {
  try {
    const call = await llm.stageCallEstimator(SPLIT_STAGE);
    return call.enabled ? call : null;
  } catch (error) {
    if (error instanceof LlmError) return null;
    throw error;
  }
}

/** Готовые досье и глоссарий языка - их данные идут в промпт; не готовы - `null`. */
export async function readyContext(
  prisma: PrismaService,
  dossiers: DossierService,
  sourceVersionId: string,
  language: Language,
): Promise<{ dossierData: unknown; glossaryData: unknown }> {
  const dossier = await dossiers.latestDossier(sourceVersionId);
  if (dossier?.status !== 'ready') return { dossierData: null, glossaryData: null };
  const glossary = await prisma.bookGlossary.findUnique({
    where: { dossierId_language: { dossierId: dossier.id, language } },
    select: { status: true, data: true },
  });
  return {
    dossierData: dossier.data,
    glossaryData: glossary?.status === 'ready' ? glossary.data : null,
  };
}

/** Сверху: досье и глоссарий размером в `maxTokens` своих этапов, в символах. */
export async function contextUpperChars(llm: LlmService): Promise<number> {
  const [dossier, glossary] = await Promise.all([
    llm.getStageSetting(DOSSIER_STAGE),
    llm.getStageSetting(GLOSSARY_STAGE),
  ]);
  return (dossier.maxTokens + glossary.maxTokens) * ANSWER_CHARS_PER_TOKEN;
}
