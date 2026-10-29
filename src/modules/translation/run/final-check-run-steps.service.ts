import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { assembleTranslatedChapter } from '../assemble/chapter-assembly';
import {
  ASSEMBLY_CHUNK_SELECT,
  chapterAssemblyInput,
  chunksOfChapter,
  InputChunk,
} from '../assemble/chapter-input';
import { ChapterLayout, splitChapter } from '../chapter-blocks';
import { TranslatedBlock } from '../translate/translate.format';
import { nameEntriesOf } from '../check/mechanical-check';
import { callIndependent, translatorsOf } from '../check/independent-call';
import { addChapterFindings, CHAPTER_FINDINGS_SELECT } from '../assemble/chapter-findings';
import { FinalChapter, FinalFinding, finalCodeCheck } from '../final-check/final-check-code';
import { FINAL_CHECK_STAGE, FINAL_FINDING_CODES } from '../final-check/final-check.constants';
import {
  anchoredIssues,
  FINAL_CHECK_SHAPE,
  finalCheckAnswerOf,
  finalCheckFailed,
  finalCheckInputOf,
  finalCheckRequest,
} from '../final-check/final-check.prompts';
import {
  finalCheckBypassed,
  FinalCheckChapter,
  FinalCheckState,
  finalCheckStateJson,
  finalCheckStateOf,
} from '../final-check/final-check-state';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import {
  RUN_CHAPTER_CHUNKS_MAX,
  RUN_LANGUAGE_UNFINISHED,
  RUN_MAX_CHAPTERS,
  RUN_TX_OPTIONS,
  FINAL_CODE_TX_OPTIONS,
} from './translation-run.constants';
import { LanguageRow, RunStepSupportService, stageModelsOf } from './run-step-support.service';
import { MetadataDraftRunStepsService } from './metadata-draft-run-steps.service';

/** Итоговая проверка языка кодом и моделью (`F05-6`, 6c). */
@Injectable()
export class FinalCheckRunStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly support: RunStepSupportService,
    private readonly metadataDraft: MetadataDraftRunStepsService,
  ) {}

  /**
   * Итоговая проверка (`F05-6`, шаг 5) - после сборки последней главы, до `metadata` (решение
   * арбитра `F05 | F05-6`, 6c В6): кодом один раз, затем моделью глава за шаг. Язык, у которого
   * этап `metadata` начат до неё (запуск шёл во время выката), её не догоняет: в отчёте -
   * «не проводилась».
   */
  async finalCheckStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const state = finalCheckStateOf(lang.finalCheck);
    if (state?.done || finalCheckBypassed(state, lang.metadata))
      return this.metadataDraft.metadataStep(lang, ctx);
    if (!state?.code) return this.finalCodeStep(lang, ctx);
    return this.finalModelStep(lang, state, ctx);
  }

  /** Собранная глава языка без разметки - вход проверок кодом и моделью; `null` - исходник правили. */
  private async assembledChapter(
    lang: LanguageRow,
    number: number,
  ): Promise<{ layout: ChapterLayout; content: string; chunks: InputChunk[] } | null> {
    const input = await chapterAssemblyInput(this.prisma, lang.run.bookVersionId, lang.id, number);
    if (!input) return null;
    const layout = splitChapter(input.content);
    const assembly = assembleTranslatedChapter(layout, input.chunks);
    if (assembly.status !== 'assembled') return null;
    return { layout, content: assembly.content, chunks: input.chunks };
  }

  /**
   * Итоговая проверка кодом: главы исходника ↔ главы перевода, пустые, прогон глоссария по всему
   * тексту (6c В7). Три выборки на весь язык - главы исходника, строки глав и куски, - без запроса
   * на главу. Находки глав и состояние языка - одной транзакцией под замком строки языка: шаг,
   * повторённый после потерянной аренды, видит записанный `code` и находки второй раз не пишет.
   */
  private async finalCodeStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const [sources, rows, chunks] = await Promise.all([
      this.prisma.chapter.findMany({
        where: { bookVersionId: lang.run.bookVersionId },
        select: { number: true, content: true },
        orderBy: { number: 'asc' },
        take: RUN_MAX_CHAPTERS,
      }),
      this.prisma.translationChapter.findMany({
        where: { runLanguageId: lang.id },
        select: { ...CHAPTER_FINDINGS_SELECT, status: true },
        orderBy: { chapterNumber: 'asc' },
        take: RUN_MAX_CHAPTERS,
      }),
      this.prisma.translationChunk.findMany({
        where: { runLanguageId: lang.id },
        select: { ...ASSEMBLY_CHUNK_SELECT, chapterNumber: true },
        orderBy: [{ chapterNumber: 'asc' }, { chunkIndex: 'asc' }],
        take: RUN_MAX_CHAPTERS * RUN_CHAPTER_CHUNKS_MAX,
      }),
    ]);
    const byChapter = new Map<number, typeof chunks>();
    for (const c of chunks) {
      const own = byChapter.get(c.chapterNumber);
      if (own) own.push(c);
      else byChapter.set(c.chapterNumber, [c]);
    }
    const rowOf = new Map(rows.map((r) => [r.chapterNumber, r]));
    const chapters: FinalChapter[] = [];
    for (const source of sources) {
      const layout = splitChapter(source.content);
      const sourceBlocks = layout.blocks.filter((b) => b.translatable).length;
      const row = rowOf.get(source.number);
      let text: string | null = null;
      if (row?.status === 'assembled' && sourceBlocks > 0) {
        const own = byChapter.get(source.number) ?? [];
        // Главу правили после сборки - перевод проверялся бы не с того исходника.
        if (!chunksOfChapter(source.content, own)) return this.support.pauseStale(lang);
        const assembly = assembleTranslatedChapter(layout, own);
        if (assembly.status !== 'assembled') return this.support.pauseStale(lang);
        text = richHtmlText(assembly.content);
      }
      chapters.push({
        number: source.number,
        text,
        sourceBlocks,
        inTranslation: row !== undefined,
      });
    }
    const { glossary } = await this.support.contextOf(lang);
    const entries = nameEntriesOf(((glossary ?? {}) as { entries?: unknown[] }).entries ?? []);
    const result = finalCodeCheck(chapters, entries, lang.language);
    const state: FinalCheckState = { code: { missing: result.missing }, chapters: [], done: false };
    await ctx.renewLease();
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<Array<{ finalCheck: Prisma.JsonValue }>>`
        SELECT "finalCheck" FROM "TranslationRunLanguage" WHERE "id" = ${lang.id} FOR UPDATE`;
      if (finalCheckStateOf(current[0]?.finalCheck)?.code) return;
      const written = await tx.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { finalCheck: finalCheckStateJson(state) },
      });
      if (written.count === 0) return;
      for (const [number, found] of result.findings) {
        const row = rowOf.get(number);
        if (row) await addChapterFindings(tx, lang.id, row, found);
      }
    }, FINAL_CODE_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /**
   * Итоговая проверка моделью: начало и конец главы, модель другого семейства, чем модели кусков
   * главы (6c В5). Глава за шаг; ответ - в состояние языка вместе с находкой главы. Отказ всех
   * моделей по политике - пауза этапа; нет независимой, этап недоступен - находка, язык дальше.
   */
  private async finalModelStep(
    lang: LanguageRow,
    state: FinalCheckState,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const done = new Set(state.chapters.map((c) => c.number));
    const row = await this.prisma.translationChapter.findFirst({
      where: {
        runLanguageId: lang.id,
        status: 'assembled',
        ...(done.size > 0 ? { chapterNumber: { notIn: [...done] } } : {}),
      },
      select: CHAPTER_FINDINGS_SELECT,
      orderBy: { chapterNumber: 'asc' },
    });
    if (!row) {
      await this.prisma.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { finalCheck: finalCheckStateJson({ ...state, done: true }) },
      });
      return { kind: 'continue' };
    }
    const assembled = await this.assembledChapter(lang, row.chapterNumber);
    if (!assembled) return this.support.pauseStale(lang);
    const { run } = lang;
    const translated = assembled.chunks.flatMap(
      (c) => (Array.isArray(c.blocks) ? c.blocks : []) as unknown as TranslatedBlock[],
    );
    const input = finalCheckInputOf({
      layout: assembled.layout,
      translated,
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      chapterNumber: row.chapterNumber,
      context: await this.support.contextOf(lang),
    });
    let record: FinalCheckChapter;
    let found: FinalFinding[] = [];
    // Глава без текста в исходнике: читать модели нечего (пустая глава перевода, решение арбитра).
    if (input.blocks.length === 0) {
      record = { number: row.chapterNumber, outcome: 'pass', model: '', costUsd: '0' };
    } else if (!translated.some((b) => input.blocks.includes(b.n) && b.text.trim() !== '')) {
      // Перевод пуст - флаг `CHAPTER_EMPTY` уже поставила проверка кодом; за чтение пустоты не платим.
      record = { number: row.chapterNumber, outcome: 'empty', model: '', costUsd: '0' };
    } else {
      const outcome = await callIndependent(
        this.llm,
        run.operationId,
        FINAL_CHECK_STAGE,
        finalCheckRequest(input),
        FINAL_CHECK_SHAPE,
        finalCheckAnswerOf,
        translatorsOf(assembled.chunks),
        stageModelsOf(run, FINAL_CHECK_STAGE),
        ctx,
      );
      const base = { number: row.chapterNumber, model: '', costUsd: '0' };
      switch (outcome.kind) {
        case 'no_provider':
          return this.support.pauseNoProvider(lang, FINAL_CHECK_STAGE, outcome.models);
        case 'not_independent':
          record = { ...base, outcome: 'not_independent' };
          found = [{ code: FINAL_FINDING_CODES.FINAL_NOT_INDEPENDENT }];
          break;
        case 'unavailable':
          record = { ...base, outcome: 'unavailable' };
          found = [{ code: FINAL_FINDING_CODES.FINAL_CHECK_UNAVAILABLE }];
          break;
        case 'too_long':
          record = { ...base, outcome: 'too_long' };
          found = [{ code: FINAL_FINDING_CODES.FINAL_CHECK_INPUT_TOO_LONG }];
          break;
        case 'invalid':
          record = { ...base, outcome: 'invalid', costUsd: outcome.costUsd.toString() };
          found = [
            {
              code: FINAL_FINDING_CODES.FINAL_CHECK_INVALID_RESPONSE,
              costUsd: record.costUsd,
            },
          ];
          break;
        case 'answered': {
          const paid = { model: outcome.model, costUsd: outcome.costUsd.toString() };
          const failed = finalCheckFailed(outcome.answer, input.blocks);
          record = { ...base, ...paid, outcome: failed ? 'fail' : 'pass' };
          const issues = anchoredIssues(outcome.answer, input.blocks);
          found = !failed
            ? [{ code: FINAL_FINDING_CODES.FINAL_CHECKED, ...paid }]
            : issues.length > 0
              ? issues.map((i) => ({
                  code: FINAL_FINDING_CODES.FINAL_CHECK_FAIL,
                  block: i.block,
                  issue: i.problem,
                  ...paid,
                }))
              : [{ code: FINAL_FINDING_CODES.FINAL_CHECK_FAIL, ...paid }];
          break;
        }
      }
    }
    // Аренда продлена - шаг ещё наш: ответ пишется без условия на прочитанное состояние, иначе
    // запись мимо теряла бы оплаченный ответ (как у `metadata`).
    await ctx.renewLease();
    const next: FinalCheckState = { ...state, chapters: [...state.chapters, record] };
    await this.prisma.$transaction(async (tx) => {
      const written = await tx.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { finalCheck: finalCheckStateJson(next) },
      });
      if (written.count > 0 && found.length > 0) {
        await addChapterFindings(tx, lang.id, row, found, { where: { status: 'assembled' } });
      }
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }
}
