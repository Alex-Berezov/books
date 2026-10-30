import { ConflictException, Injectable } from '@nestjs/common';
import { Language, Prisma, BookDossier } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { SUMMARY_INPUT_CHARS_PER_TOKEN } from '../../llm/openrouter.client';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { chapterPages } from '../chapter-pages';
import { DOSSIER_STAGE, GLOSSARY_STAGE } from './dossier.constants';
import { dossierListLimits, exceedsChapterCap, refusedBeforeParts } from './dossier-groups';
import {
  DossierPartPlan,
  DossierPlanEntry,
  partKey,
  planDossierParts,
  planEntries,
} from './dossier-parts';
import { dossierPartRequest, emptyMergeInputChars, glossaryRequest } from './dossier.prompts';
import { ChapterTitle } from './dossier-demand.types';
import { summaryUsd } from './dossier-summary-usd';

/**
 * Оценка и обход исходника для досье и глоссария: куски первого прохода, цена построения,
 * граница входа сводки. Без записи в базу: строки заводит
 * `DossierBuilderService`, спрашивает их `DossierDemandService`, оценки зовут оба.
 */
@Injectable()
export class DossierEstimatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Обход исходника страницами (`F05-Rb`): куски первого прохода отдаются `visit` по одному и в
   * памяти не копятся, остаются названия глав и сжатый план. Потолка на число глав нет.
   */
  async walkSource(
    sourceVersionId: string,
    visit: (part: DossierPartPlan) => Promise<void> | void,
  ): Promise<{ titles: ChapterTitle[]; entries: DossierPlanEntry[]; parts: number }> {
    const titles: ChapterTitle[] = [];
    const entries: DossierPlanEntry[] = [];
    let parts = 0;
    for await (const page of chapterPages(this.prisma, sourceVersionId, {
      number: true,
      title: true,
      content: true,
    })) {
      for (const chapter of page) titles.push({ number: chapter.number, title: chapter.title });
      const plans = planDossierParts(page);
      for (const plan of plans) await visit(plan);
      entries.push(...planEntries(plans));
      parts += plans.length;
    }
    return { titles, entries, parts };
  }

  /**
   * Модель этапа, если сводка заведомо откажет `DOSSIER_TOO_LONG` (`refusedBeforeParts`), иначе
   * `null`. Граница входа - `stageInputCeiling`, как у обработчика перед записью уровня 0: модели
   * без цены в неё не входят, вызов на них не уйдёт.
   */
  async findRefusingModel(titles: ChapterTitle[], chapters: number): Promise<string | null> {
    const { maxTokens } = await this.llm.getStageSetting(DOSSIER_STAGE);
    // Глав не больше K - отказа на старте не бывает, границу и мерку не считаем.
    if (!exceedsChapterCap(chapters, maxTokens)) return null;
    const { maxInputChars, model } = await this.llm.stageInputCeiling(DOSSIER_STAGE, {
      charsPerToken: SUMMARY_INPUT_CHARS_PER_TOKEN,
    });
    const emptyMerged = emptyMergeInputChars(titles, dossierListLimits(maxTokens));
    return refusedBeforeParts(chapters, maxInputChars, emptyMerged, maxTokens) ? model : null;
  }

  /**
   * Оценка построения сверху: куски первого прохода (кроме `saved`) плюс сводка по ответам всех
   * кусков. Сводка, которая не влезает в контекст, считается с вызовами групп по уровням.
   */
  async estimateSource(
    sourceVersionId: string,
    saved: ReadonlySet<string> = new Set(),
  ): Promise<{
    estimateUsd: Prisma.Decimal;
    entries: DossierPlanEntry[];
    parts: number;
    titles: ChapterTitle[];
  }> {
    const held: { call?: StageCallEstimator } = {};
    let partsUsd = new Prisma.Decimal(0);
    const { titles, entries, parts } = await this.walkSource(sourceVersionId, async (part) => {
      const call = (held.call ??= await this.estimator(DOSSIER_STAGE));
      if (saved.has(partKey(part.chapterNumber, part.partIndex))) return;
      partsUsd = partsUsd.add(call.estimate(dossierPartRequest(part)));
    });
    const { call } = held;
    if (!call || parts === 0) throw this.noChapters();
    return {
      estimateUsd: partsUsd.add(summaryUsd(call, titles, parts, entries.length)),
      entries,
      parts,
      titles,
    };
  }

  async estimateGlossary(dossier: BookDossier, language: Language): Promise<Prisma.Decimal> {
    const call = await this.estimator(GLOSSARY_STAGE);
    return call.estimate(glossaryRequest({ dossier: dossier.data, language }));
  }

  /**
   * Оценщик вызова этапа для ручек: модель этапа без цены и без `maxPricePerMTok` - 409 с кодом
   * `LLM_NO_PRICE`, а не 500 (`LlmError` в HTTP сам не переводится).
   */
  async estimator(stage: string): Promise<StageCallEstimator> {
    let call: StageCallEstimator;
    try {
      call = await this.llm.stageCallEstimator(stage);
    } catch (error) {
      if (error instanceof LlmError) throw llmTaskConflict(error.code, error.message);
      throw error;
    }
    // Выключенный этап - отказ до операции, а не операция, которая откажет на первом шаге.
    if (!call.enabled) {
      throw llmTaskConflict('LLM_STAGE_DISABLED', `LLM stage "${stage}" is disabled`);
    }
    return call;
  }

  private noChapters(): ConflictException {
    return llmTaskConflict(
      'SOURCE_HAS_NO_CHAPTERS',
      'The dossier source version has no chapter text',
    );
  }
}
