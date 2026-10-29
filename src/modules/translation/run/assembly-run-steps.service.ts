import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { assembleTranslatedChapter } from '../assemble/chapter-assembly';
import { chapterAssemblyInput } from '../assemble/chapter-input';
import { splitChapter } from '../chapter-blocks';
import { CHECK_SEMANTIC_STAGE } from '../check/check.constants';
import { callIndependent, translatorsOf } from '../check/independent-call';
import {
  addChapterFindings,
  CHAPTER_FINDINGS_SELECT,
  ChapterFindingsRow,
} from '../assemble/chapter-findings';
import {
  nextSeam,
  SEAM_FINDING_CODES,
  SEAM_SHAPE,
  seamAnswerOf,
  seamFailed,
  SeamFinding,
  seamFindingsOf,
  seamInputOf,
  seamProblems,
  seamRequest,
} from '../check/seam-check';
import { RUN_TX_OPTIONS } from './translation-run.constants';
import { LanguageRow, RunStepSupportService, stageModelsOf } from './run-step-support.service';
import { FinalCheckRunStepsService } from './final-check-run-steps.service';

/** Сборка глав языка и стыки моделью (`F05-6`, 6a, 6c). */
@Injectable()
export class AssemblyRunStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly support: RunStepSupportService,
    private readonly finalCheck: FinalCheckRunStepsService,
  ) {}

  /**
   * Сборка глав языка (`F05-6`, 6a; решение арбитра `F05 | F05-6` о дроблении): глава за шаг по
   * порядку номеров исходника, затем этап `metadata`, затем язык доделан (черновик версии - 6b).
   * Перед первой главой - сверка отпечатка исходника: главу, переведённую раньше, могли править,
   * пока переводилась последняя (карточка, «От `F05-4a`»), а её куски уже не сверяются.
   */
  async assemblyStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    // Глава со стыками на проверке моделью (6c) доделывается раньше следующей.
    const pending = await this.prisma.translationChapter.findFirst({
      where: { runLanguageId: lang.id, status: 'pending' },
      select: CHAPTER_FINDINGS_SELECT,
    });
    if (pending) return this.seamStep(lang, pending, ctx);
    // Главы собираются строго по порядку номеров: следующая - после последней собранной.
    const last = await this.prisma.translationChapter.aggregate({
      where: { runLanguageId: lang.id },
      _max: { chapterNumber: true },
    });
    const after = last._max.chapterNumber;
    const next = await this.prisma.chapter.findFirst({
      where: {
        bookVersionId: lang.run.bookVersionId,
        ...(after === null ? {} : { number: { gt: after } }),
      },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    if (!next) return this.finalCheck.finalCheckStep(lang, ctx);
    if (after === null && (await this.support.isStale(lang.run)))
      return this.support.pauseStale(lang);
    return this.assembleChapterStep(lang, next.number, ctx);
  }

  /**
   * Сборка одной главы (`F05-6`, шаги 2-3, стыки кодом). Строка главы и счётчик флагов - одной
   * транзакцией; повтор шага строку не дублирует (`skipDuplicates`) и флаг второй раз не считает.
   * Собранная глава из нескольких кусков - `pending`: её стыки читает модель (`seamStep`), затем
   * `assembled` (решение арбитра `F05 | F05-6`, 6c В4).
   */
  private async assembleChapterStep(
    lang: LanguageRow,
    number: number,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const input = await chapterAssemblyInput(this.prisma, lang.run.bookVersionId, lang.id, number);
    // Главу удалили, добавили или правили после нарезки - перевод собран не с того исходника.
    if (!input) return this.support.pauseStale(lang);
    const result = assembleTranslatedChapter(splitChapter(input.content), input.chunks);
    const status =
      result.status === 'assembled' && input.chunks.length > 1 ? 'pending' : result.status;
    await ctx.renewLease();
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.translationChapter.createMany({
        data: [
          {
            runLanguageId: lang.id,
            chapterNumber: number,
            status,
            flagReason: result.flagReason,
            length: result.length,
            lengthLimit: RICH_HTML_MAX_LENGTH.body,
            seamIndex: result.status === 'assembled' ? result.seamIndex : null,
            findings: result.findings as unknown as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count > 0 && result.flagReason !== null) {
        await tx.translationRunLanguage.update({
          where: { id: lang.id },
          data: { flaggedChapters: { increment: 1 } },
        });
      }
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /**
   * Стык главы моделью (`F05-6`, шаг 3; решение арбитра `F05 | F05-6`, 6c В4): стык за шаг, этап
   * `check_semantic` со своим промптом, модели - другого семейства, чем модели обоих кусков стыка.
   * Оплаченный ответ - находкой главы до решения: повтор шага его не оплачивает. Все стыки
   * разобраны - глава `assembled`, провал - флаг с номером стыка, не повтор.
   */
  private async seamStep(
    lang: LanguageRow,
    row: ChapterFindingsRow,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const { run } = lang;
    const input = await chapterAssemblyInput(
      this.prisma,
      run.bookVersionId,
      lang.id,
      row.chapterNumber,
    );
    if (!input) return this.support.pauseStale(lang);
    const seam = nextSeam(input.chunks.length, row.findings);
    if (seam === null) {
      // Находки уже на главе: дописывать нечего, флаг и номер стыка - из них.
      await this.prisma.$transaction(async (tx) => {
        await addChapterFindings(tx, lang.id, row, [], {
          data: { status: 'assembled' },
          where: { status: 'pending' },
          flagFrom: seamFindingsOf(row.findings),
        });
      }, RUN_TX_OPTIONS);
      return { kind: 'continue' };
    }
    const [previous, next] = [input.chunks[seam - 1], input.chunks[seam]];
    const models = stageModelsOf(run, CHECK_SEMANTIC_STAGE);
    const outcome = await callIndependent(
      this.llm,
      run.operationId,
      CHECK_SEMANTIC_STAGE,
      seamRequest(
        seamInputOf(splitChapter(input.content), previous, next, {
          sourceLanguage: run.sourceLanguage,
          targetLanguage: lang.language,
        }),
      ),
      SEAM_SHAPE,
      seamAnswerOf,
      translatorsOf([previous, next]),
      models,
      ctx,
    );
    let finding: SeamFinding;
    switch (outcome.kind) {
      case 'no_provider':
        return this.support.pauseNoProvider(lang, CHECK_SEMANTIC_STAGE, outcome.models);
      case 'not_independent':
        finding = { code: SEAM_FINDING_CODES.SEAM_NOT_INDEPENDENT, seam };
        break;
      case 'unavailable':
        finding = { code: SEAM_FINDING_CODES.SEAM_CHECK_UNAVAILABLE, seam };
        break;
      case 'too_long':
        finding = { code: SEAM_FINDING_CODES.SEAM_CHECK_INPUT_TOO_LONG, seam };
        break;
      case 'invalid':
        finding = {
          code: SEAM_FINDING_CODES.SEAM_CHECK_INVALID_RESPONSE,
          seam,
          costUsd: outcome.costUsd.toString(),
        };
        break;
      case 'answered':
        finding = seamFailed(outcome.answer)
          ? {
              code: SEAM_FINDING_CODES.SEAM_BROKEN,
              seam,
              model: outcome.model,
              costUsd: outcome.costUsd.toString(),
              problems: seamProblems(outcome.answer),
            }
          : {
              code: SEAM_FINDING_CODES.SEAM_CHECKED,
              seam,
              model: outcome.model,
              costUsd: outcome.costUsd.toString(),
            };
        break;
    }
    // Аренда продлена - шаг ещё наш: ответ стыка пишется, пока глава на проверке стыков; флаг -
    // при закрытии главы, когда разобраны все стыки.
    await ctx.renewLease();
    await this.prisma.$transaction(async (tx) => {
      await addChapterFindings(tx, lang.id, row, [finding], {
        where: { status: 'pending' },
        flagFrom: [],
      });
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }
}
