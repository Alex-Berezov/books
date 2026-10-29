import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { demandContext } from '../dossier/context-demand';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { sourceFingerprint } from '../source-fingerprint';
import { CLEAR_STOP, LanguageRow, RunStepSupportService } from './run-step-support.service';
import { DOSSIER_LIMIT_TOO_LOW, RUN_TX_OPTIONS } from './translation-run.constants';

/** Досье запуска и глоссарий языка - первый шаг языка, до глав (Р18, Р20). */
@Injectable()
export class ContextRunStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierDemandService,
    private readonly support: RunStepSupportService,
  ) {}

  /**
   * Досье и глоссарий языка. Досье запуска одно (Р18): первым готовым привязывается с отпечатком
   * исходника, остальные языки берут глоссарий к нему. Устаревшее на привязке - пауза
   * `DOSSIER_STALE` (Р13).
   */
  async awaitContext(lang: LanguageRow): Promise<LlmTaskStepResult> {
    const { run } = lang;
    const bound = run.dossierId
      ? await this.prisma.bookDossier.findUnique({ where: { id: run.dossierId } })
      : null;
    const context = await demandContext(this.dossiers, this.tasks, {
      versionId: run.bookVersionId,
      language: lang.language,
      operationId: run.operationId,
      waitingFor: lang.waitingFor,
      dossier: bound,
      translationRunId: run.id,
      // До привязки не переведено ничего: устаревшее готовое досье строится новым поколением,
      // а не останавливает запуск на `DOSSIER_STALE` без выхода.
      rebuildStale: !run.dossierId,
      // Причина и лимит - той же транзакцией, что пауза операции: опрос не увидит одно без
      // другого, а «продолжить» не может прийти раньше и быть затёрто этой записью.
      onLimit: async (tx, minLimitUsd) => {
        await tx.translationRunLanguage.update({
          where: { id: lang.id },
          data: { ...CLEAR_STOP, reason: DOSSIER_LIMIT_TOO_LOW, reasonUsd: minLimitUsd },
        });
      },
    });
    switch (context.kind) {
      case 'ready': {
        // Исходник по D8 сменился (у книги появилась версия на языке оригинала): досье другой
        // версии к запуску не привязывается - его главы и отпечаток не те, что у запуска, а
        // `NoAction` держит удаление только при досье той же версии (В2).
        if (context.dossier.sourceVersionId !== run.bookVersionId)
          return this.support.pauseStale(lang);
        if (!run.dossierId) {
          // Исходник правили, пока строилось досье: до привязки не переведено ничего - шаг
          // повторится и построит новое поколение (`rebuildStale`), а не встанет без выхода.
          const current = await sourceFingerprint(this.prisma, context.dossier.sourceVersionId);
          if (current !== context.dossier.fingerprint) return { kind: 'continue' };
        }
        // Привязка досье запуска и глоссария языка - одной транзакцией. Досье привязал другой
        // язык (другое поколение) - глоссарий этого языка к нему, следующим шагом.
        await this.prisma.$transaction(async (tx) => {
          if (!run.dossierId) {
            await tx.translationRun.updateMany({
              where: { id: run.id, dossierId: null },
              data: {
                dossierId: context.dossier.id,
                dossierFingerprint: context.dossier.fingerprint,
              },
            });
            const fresh = await tx.translationRun.findUniqueOrThrow({
              where: { id: run.id },
              select: { dossierId: true },
            });
            if (fresh.dossierId !== context.dossier.id) return;
          }
          await tx.translationRunLanguage.update({
            where: { id: lang.id },
            data: { glossaryId: context.glossary.id, waitingFor: null, ...CLEAR_STOP },
          });
        }, RUN_TX_OPTIONS);
        return { kind: 'continue' };
      }
      case 'wait':
        if (lang.waitingFor !== context.waitingFor) {
          await this.prisma.translationRunLanguage.update({
            where: { id: lang.id },
            data: { waitingFor: context.waitingFor },
          });
        }
        return { kind: 'wait', reason: context.reason };
      case 'stopped':
        // Операция запуска уже на паузе (её поставил `DossierDemandService`): причина и операция
        // досье - у языка, для «продолжить досье» (`F05-7`).
        // `LIMIT_REACHED` до трат язык уже записал сам (`onLimit`): не затирать код и лимит.
        if (context.reason !== 'LIMIT_REACHED' || context.blockedBy !== null) {
          await this.prisma.translationRunLanguage.update({
            where: { id: lang.id },
            data: { reason: context.reason, blockedByOperationId: context.blockedBy },
          });
        }
        return { kind: 'continue' };
      // Строку меняли одновременно - «повторить позже», а не отказ.
      case 'retry':
        return { kind: 'wait', reason: context.code };
      case 'failed':
        await this.prisma.translationRunLanguage.update({
          where: { id: lang.id },
          data: { reason: context.code },
        });
        return { kind: 'fail', reason: context.code };
    }
  }
}
