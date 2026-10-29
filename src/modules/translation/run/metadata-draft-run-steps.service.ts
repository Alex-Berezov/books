import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { CREATE_FROM_RUN_REJECTIONS } from '../../book-version/create-from-run';
import { DRAFT_DELETED, NO_CHAPTERS_WRITTEN } from '../draft/draft.constants';
import { TranslationDraftService } from '../draft/translation-draft.service';
import { checkMetadata, MetadataResult } from '../metadata/metadata-check';
import {
  METADATA_ATTEMPTS_MAX,
  METADATA_INVALID,
  METADATA_STAGE,
  METADATA_TOO_LONG,
} from '../metadata/metadata.constants';
import {
  MetadataState,
  metadataFailures,
  metadataRemarks,
  metadataSourceHash,
  metadataStateJson,
  metadataStateOf,
} from '../metadata/metadata-state';
import { callMetadata, metadataInputOf, metadataSourceFields } from '../metadata/metadata-step';
import { RUN_LANGUAGE_UNFINISHED } from './translation-run.constants';
import { LanguageRow, RunStepSupportService, stageModelsOf } from './run-step-support.service';

/** Этап `metadata` и черновик версии (`F05-6`, 4, 6b). */
@Injectable()
export class MetadataDraftRunStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly support: RunStepSupportService,
    private readonly drafts: TranslationDraftService,
  ) {}

  /**
   * Этап `metadata` (`F05-6`, шаг 4): название, описание, автор и названия глав на целевом языке.
   * Ответ с попыткой пишется в язык до решения - повтор шага его не оплачивает. Провал проверок -
   * повтор с замечаниями, вторая неудача - `failed` языка (`METADATA_INVALID`). Перед вызовом -
   * сверка отпечатка: названия глав входят в него, за устаревший вход не платим.
   */
  async metadataStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const state: MetadataState = metadataStateOf(lang.metadata) ?? { attempts: [], result: null };
    if (state.result) return this.draftStep(lang, ctx, state.result);
    if (metadataFailures(state) >= METADATA_ATTEMPTS_MAX) {
      return this.support.failLanguage(lang, METADATA_INVALID);
    }
    if (await this.support.isStale(lang.run)) return this.support.pauseStale(lang);
    const fields = await metadataSourceFields(
      this.prisma,
      lang.run.bookVersionId,
      lang.run.sourceLanguage,
    );
    if (!fields) return this.support.pauseStale(lang);
    const { input, source } = metadataInputOf(
      { ...fields, targetLanguage: lang.language },
      await this.support.contextOf(lang),
      metadataRemarks(state),
    );
    const models = stageModelsOf(lang.run, METADATA_STAGE);
    const outcome = await callMetadata(this.llm, lang.run.operationId, input, ctx, models);
    let failed = false;
    switch (outcome.kind) {
      case 'too_long':
        return this.support.failLanguage(lang, METADATA_TOO_LONG);
      case 'no_provider':
        return this.support.pauseNoProvider(lang, METADATA_STAGE, outcome.models);
      case 'invalid':
        // Ответ не по форме и после повтора с замечанием внутри вызова (`METADATA_REMARKS`) -
        // это и есть повтор карточки: ещё один круг заплатил бы снова без замечаний проверки.
        state.attempts.push({
          model: '',
          costUsd: outcome.costUsd.toString(),
          outcome: 'invalid',
          remarks: [],
        });
        failed = true;
        break;
      case 'answered': {
        const checked = checkMetadata(source, outcome.answer);
        state.attempts.push({
          model: outcome.model,
          costUsd: outcome.costUsd.toString(),
          outcome: checked.ok ? 'pass' : 'fail',
          remarks: checked.ok ? [] : checked.remarks,
        });
        if (checked.ok) {
          state.result = checked.result;
          // Снимок полей, с которых переведено: черновик сверит его под замком (6c В1).
          state.sourceHash = metadataSourceHash(fields);
        }
        break;
      }
    }
    // Аренда продлена - шаг ещё наш (`renewLease` бросает, если её забрали): ответ пишется без
    // условия на прочитанную строку, иначе запись мимо (строку тронул «продолжить») теряла бы
    // оплаченный ответ и платила бы за него снова.
    await ctx.renewLease();
    await this.prisma.translationRunLanguage.updateMany({
      where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: { metadata: metadataStateJson(state) },
    });
    return failed ? this.support.failLanguage(lang, METADATA_INVALID) : { kind: 'continue' };
  }

  /**
   * Черновик версии и главы (`F05-6`, 6b): версия создаётся один раз, затем глава за шаг по
   * порядку номеров; после последней язык доделан. Исходник после создания версии уже не сверяется
   * на уровне языка - глава сверяет свой отпечаток сама (`SOURCE_CHANGED`, язык идёт дальше).
   */
  async draftStep(
    lang: LanguageRow,
    ctx: LlmTaskContext,
    metadata: MetadataResult,
  ): Promise<LlmTaskStepResult> {
    if (lang.bookVersionId === null) {
      // Черновик создавался, а ссылки нет - его удалили (решение арбитра `F05 | F05-6`).
      if (lang.draftCreatedAt !== null) return this.support.failLanguage(lang, DRAFT_DELETED);
      if (await this.support.isStale(lang.run)) return this.support.pauseStale(lang);
      if (!(await this.drafts.nextToWrite(lang.id))) {
        return this.support.failLanguage(lang, NO_CHAPTERS_WRITTEN);
      }
      await ctx.renewLease();
      const state = metadataStateOf(lang.metadata);
      const created = await this.drafts.createDraft(lang, metadata, state?.sourceHash);
      if (!created) return this.support.pauseStale(lang);
      if (created.kind === 'created') return { kind: 'continue' };
      if (created.kind === 'fields_changed') return this.redoMetadata(lang);
      if (created.kind === 'deleted') return this.support.failLanguage(lang, DRAFT_DELETED);
      // Повтор шага после потерянной аренды: версию создал прошлый исполнитель - она своя.
      if (created.code === CREATE_FROM_RUN_REJECTIONS.VERSION_EXISTS) {
        const own = await this.prisma.translationRunLanguage.findUnique({
          where: { id: lang.id },
          select: { bookVersionId: true },
        });
        if (own?.bookVersionId) return { kind: 'continue' };
      }
      return this.support.failLanguage(lang, created.code, created.text);
    }
    const next = await this.drafts.nextToWrite(lang.id);
    if (!next) return this.support.finishLanguage(lang);
    const written = await this.drafts.writeChapter(
      { ...lang, bookVersionId: lang.bookVersionId },
      next,
      metadata.chapterTitles,
      () => ctx.renewLease(),
    );
    // Черновик удалили посреди записи главы - тот же исход, что и между шагами.
    if (written === 'draft_deleted') return this.support.failLanguage(lang, DRAFT_DELETED);
    return { kind: 'continue' };
  }

  /**
   * Название или описание исходника правили после принятия ответа `metadata` (решение арбитра
   * `F05 | F05-6`, 6c В1): ответ снимается, попытки остаются (принятая в лимит не входит), этап
   * идёт заново с новым входом. Черновик не создан - его транзакция откатилась.
   */
  private async redoMetadata(lang: LanguageRow): Promise<LlmTaskStepResult> {
    const state = metadataStateOf(lang.metadata);
    if (state) {
      await this.prisma.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] }, bookVersionId: null },
        data: {
          metadata: metadataStateJson({ attempts: state.attempts, result: null }),
        },
      });
    }
    return { kind: 'continue' };
  }
}
