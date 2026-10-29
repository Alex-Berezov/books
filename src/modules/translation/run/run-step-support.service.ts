import { Injectable } from '@nestjs/common';
import {
  LlmOperation,
  LlmPauseReason,
  LlmTask,
  Prisma,
  TranslationChunk,
  TranslationRun,
  TranslationRunLanguage,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { DRAFT_DELETED } from '../draft/draft.constants';
import { sourceFingerprint } from '../source-fingerprint';
import { chunkStepContext } from '../translate/chunk-steps';
import { CHECK_SEMANTIC_STAGE, CHECK_NO_COMPLIANT_PROVIDER } from '../check/check.constants';
import {
  FINAL_CHECK_NO_COMPLIANT_PROVIDER,
  FINAL_CHECK_STAGE,
} from '../final-check/final-check.constants';
import { METADATA_NO_COMPLIANT_PROVIDER, METADATA_STAGE } from '../metadata/metadata.constants';
import { runStageModels, StageModels } from './run-models';
import {
  RUN_LANGUAGE_UNFINISHED,
  RUN_LANGUAGES_MAX,
  UNRESUMABLE_REASONS,
} from './translation-run.constants';
import { StaleClosure, staleClosure } from './stale-closure';

export type RunRow = TranslationRun & { operation: Pick<LlmOperation, 'settingsSnapshot'> };
export type LanguageRow = TranslationRunLanguage & { run: RunRow };
/** Кусок без ответа модели: шаги читают главу целиком, ответ нужен одному шагу находок. */
export type ChunkRow = Omit<TranslationChunk, 'rawResponse'>;

/** Сброс остановки языка: «продолжить» и готовый контекст. */
export const CLEAR_STOP = Object.freeze({
  reason: null,
  reasonText: null,
  reasonModels: [],
  reasonUsd: null,
  blockedByOperationId: null,
});

/**
 * Причина языка на паузе `NO_COMPLIANT_PROVIDER` по этапу: выход - ключ этого этапа в `stageModels`,
 * а не `translate`. Стыки моделью - этап `check_semantic` (решение арбитра `F05 | F05-6`, 6c В4).
 */
const NO_PROVIDER_REASONS: Readonly<Record<string, string>> = {
  [CHECK_SEMANTIC_STAGE]: CHECK_NO_COMPLIANT_PROVIDER,
  [METADATA_STAGE]: METADATA_NO_COMPLIANT_PROVIDER,
  [FINAL_CHECK_STAGE]: FINAL_CHECK_NO_COMPLIANT_PROVIDER,
};

/** Код причины паузы `NO_COMPLIANT_PROVIDER` по этапу - один у языка запуска и у попытки повтора. */
export function noProviderReason(stage: string): string {
  return NO_PROVIDER_REASONS[stage] ?? 'LLM_NO_COMPLIANT_PROVIDER';
}

/** Под замком строки операции черновик уже есть: тупик Р13 не ставится, смена причины откатывается. */
export class StaleDecisionChangedError extends Error {}

export function runLanguageIdOf(task: LlmTask): string | null {
  const id = (task.payload as Record<string, unknown> | null)?.runLanguageId;
  return typeof id === 'string' ? id : null;
}

export function stageModelsOf(run: RunRow, stage: string): StageModels {
  return runStageModels(run.operation.settingsSnapshot, run.stageModels, stage);
}

/**
 * Общее для шагов языка запуска: сверка исходника, паузы и итоги языка. Шаги конвейера
 * (`*-run-steps.service.ts`) и обработчик берут это отсюда.
 */
@Injectable()
export class RunStepSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
  ) {}

  /** Досье запуска и глоссарий языка - данные перевода и проверок куска. */
  contextOf(lang: LanguageRow): Promise<{ dossier: unknown; glossary: unknown }> {
    return chunkStepContext(this.prisma, lang.run.dossierId, lang.glossaryId);
  }

  /**
   * Отпечаток исходника не совпал с привязанным к запуску (`tech.md` §2а). Досье запуска -
   * той же версии, что запуск (привязка другой не проходит), поэтому сверка - по версии запуска.
   */
  async isStale(run: TranslationRun, db: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    const current = await sourceFingerprint(db, run.bookVersionId);
    return current !== run.dossierFingerprint;
  }

  /**
   * Исполнение `staleClosure` в транзакции под замком строки операции: устаревшие языки без
   * черновика - `failed` `DOSSIER_STALE` (если у кого-то живой черновик), удалённые черновики -
   * `DRAFT_DELETED`; причины прошлых остановок сбрасываются. Языков у запуска не больше пяти.
   */
  async closeOnStale(tx: Prisma.TransactionClient, runId: string): Promise<StaleClosure> {
    const languages = await tx.translationRunLanguage.findMany({
      where: { runId, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      select: { id: true, bookVersionId: true, draftCreatedAt: true },
      take: RUN_LANGUAGES_MAX,
    });
    const decision = staleClosure(languages);
    const close = async (ids: string[], reason: string) => {
      if (ids.length === 0) return;
      await tx.translationRunLanguage.updateMany({
        where: { id: { in: ids }, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { ...CLEAR_STOP, status: 'failed', reason },
      });
    };
    await close(decision.stale, 'DOSSIER_STALE');
    await close(decision.deleted, DRAFT_DELETED);
    return decision;
  }

  /**
   * Все модели этапа отказали по политике данных (Р7): пауза `NO_COMPLIANT_PROVIDER` ставится
   * самим шагом - он знает, какие модели передал в вызов, и пишет их языку (решение арбитра
   * `F05 | F05-4a`, В4). Выход - «продолжить» со `stageModels`.
   */
  async pauseNoProvider(
    lang: LanguageRow,
    stage: string,
    models: StageModels,
  ): Promise<LlmTaskStepResult> {
    const tried = await this.llm.stageCallModels(stage, models);
    // Причина языка называет этап: из паузы сверки смысла выходят ключом `check_semantic`
    // в `stageModels`, а не `translate`.
    return this.stopRun(lang, 'NO_COMPLIANT_PROVIDER', {
      reason: noProviderReason(stage),
      reasonModels: tried,
    });
  }

  /**
   * Пауза запуска с причиной и записью языка. Операция уже стоит (кнопка «пауза» пришла, пока шёл
   * шаг) - причина всё равно меняется: иначе «продолжить» не узнало бы, что запуск встал по
   * исходнику или провайдерам, и сняло бы причину языка.
   */
  async stopRun(
    lang: LanguageRow,
    reason: LlmPauseReason,
    data: Prisma.TranslationRunLanguageUpdateInput,
  ): Promise<LlmTaskStepResult> {
    // `DOSSIER_STALE` - тупик (Р13): другой причиной его не перекрыть, иначе экран предложил
    // бы «продолжить» запуску, который продолжать нельзя.
    await this.tasks.stopOrRepause(
      lang.run.operationId,
      reason,
      async (tx) => {
        await tx.translationRunLanguage.update({ where: { id: lang.id }, data });
      },
      UNRESUMABLE_REASONS,
    );
    return { kind: 'continue' };
  }

  /**
   * Исходник правили посреди запуска: пауза `DOSSIER_STALE`, выход - отмена или новый запуск (Р13).
   * Пока у другого незавершённого языка есть черновик, пауза операции остановила бы и его - язык
   * закрывается сам (`failed` `DOSSIER_STALE`), черновики дописываются (решение арбитра `F05 | F05-6`).
   */
  async pauseStale(lang: LanguageRow): Promise<LlmTaskStepResult> {
    let isSelfClosed = false;
    await this.tasks.stopOrRepause(
      lang.run.operationId,
      'DOSSIER_STALE',
      async (tx) => {
        // Язык, который решение закрыло, своей причины не меняет.
        await tx.translationRunLanguage.updateMany({
          where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
          data: { reason: 'DOSSIER_STALE' },
        });
      },
      UNRESUMABLE_REASONS,
      // Решение - под замком строки операции: черновик, который сейчас создаётся, его ждёт.
      async (tx) => {
        const decision = await this.closeOnStale(tx, lang.runId);
        isSelfClosed = decision.stale.includes(lang.id) || decision.deleted.includes(lang.id);
        return !decision.hasLiveDraft;
      },
    );
    if (!isSelfClosed) return { kind: 'continue' };
    await this.completeIfFinished(lang.run);
    return { kind: 'done' };
  }

  /**
   * Язык доделан. Недоделанные считаются после записи своего `done`: из двух языков,
   * закончивших одновременно, тот, кто считает позже, видит оба и закрывает операцию.
   */
  async finishLanguage(lang: LanguageRow): Promise<LlmTaskStepResult> {
    await this.prisma.translationRunLanguage.updateMany({
      where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: { status: 'done', reason: null },
    });
    await this.completeIfFinished(lang.run);
    return { kind: 'done' };
  }

  /**
   * Язык не доделать (`F05-6`: `metadata` не прошла повтор, вход не влезает в контекст, черновик
   * не создан - `VERSION_EXISTS`, `CREATE_REJECTED`): `failed`
   * с кодом, прочие языки идут дальше (решение арбитра `F05 | F05-6`, итог языка).
   */
  async failLanguage(
    lang: LanguageRow,
    reason: string,
    reasonText: string | null = null,
  ): Promise<LlmTaskStepResult> {
    await this.prisma.translationRunLanguage.updateMany({
      where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: { status: 'failed', reason, reasonText },
    });
    await this.completeIfFinished(lang.run);
    return { kind: 'done' };
  }

  async completeIfFinished(run: TranslationRun): Promise<void> {
    const open = await this.prisma.translationRunLanguage.count({
      where: { runId: run.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
    });
    if (open === 0) await this.tasks.completeOperation(run.operationId);
  }
}
