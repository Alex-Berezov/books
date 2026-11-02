import { ContentDraft } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { demandContext, demandDossierContext } from '../dossier/context-demand';
import { DossierDemandService } from '../dossier/dossier-demand.service';

/** Зависимости шага ожидания досье и глоссария строки `ContentDraft`. */
export interface DraftContextDeps {
  db: PrismaService;
  tasks: LlmTaskService;
  dossiers: DossierDemandService;
  languageOf: (versionId: string) => Promise<string | null>;
}

/**
 * Досье и глоссарий языка версии (Р5, Р20 `F05-10`): строка `ContentDraft` - ждущий. Одно правило
 * на заготовки `F05-10` и ход пересказа `F06-2`. На языке досье глоссарий не запрашивается (В6).
 * `paused`/`failed` - операция уже на паузе, шаг кончается.
 */
export async function awaitDraftContext(
  deps: DraftContextDeps,
  row: ContentDraft,
): Promise<LlmTaskStepResult> {
  const { sourceVersionId } = await deps.dossiers.dossierSourceOf(row.bookVersionId);
  const sameLanguage = (await deps.languageOf(sourceVersionId)) === row.language;
  const input = {
    versionId: row.bookVersionId,
    operationId: row.operationId,
    waitingFor: row.waitingFor,
  };
  const context = sameLanguage
    ? await demandDossierContext(deps.dossiers, deps.tasks, input)
    : await demandContext(deps.dossiers, deps.tasks, { ...input, language: row.language });
  switch (context.kind) {
    case 'ready':
      await deps.db.contentDraft.updateMany({
        where: { id: row.id, status: 'building' },
        data: {
          dossierId: context.dossier.id,
          glossaryId: context.glossary?.id ?? null,
          waitingFor: null,
        },
      });
      return { kind: 'continue' };
    case 'wait':
      if (row.waitingFor !== context.waitingFor) {
        await deps.db.contentDraft.updateMany({
          where: { id: row.id, status: 'building' },
          data: { waitingFor: context.waitingFor },
        });
      }
      return { kind: 'wait', reason: context.reason };
    case 'stopped':
      return { kind: 'continue' };
    // Строку меняли одновременно - «повторить позже», а не отказ.
    case 'retry':
      return { kind: 'wait', reason: context.code };
    case 'failed':
      return { kind: 'fail', reason: context.code };
  }
}
