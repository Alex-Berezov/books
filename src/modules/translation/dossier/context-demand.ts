import { HttpException } from '@nestjs/common';
import { BookDossier, BookGlossary, Language, Prisma } from '@prisma/client';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { Demand, DossierService } from './dossier.service';

/** Отказы `demandDossier`/`demandGlossary` «изменено одновременно, повторить»: ожидание, не пауза. */
const CONTEXT_RETRY_CODES = new Set(['DOSSIER_BUSY', 'GLOSSARY_BUSY']);

/** Код отказа ручки досье (409/503 с `code` в теле), которым шаг ставит свою операцию на паузу. */
function httpCode(error: HttpException): string {
  const body = error.getResponse();
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null;
  return typeof code === 'string' && code ? code : `HTTP_${error.getStatus()}`;
}

/**
 * Досье и глоссарий языка для шага ждущего (сравнение `F05-3`, запуск `F05-4`; Р20).
 * - `ready` - оба готовы;
 * - `wait` - строятся: шаг пишет `waitingFor` и ждёт;
 * - `stopped` - операция ждущего уже на паузе или в отказе (её поставил `DossierService`),
 *   шаг кончается; `blockedBy` - операция досье на паузе (`DOSSIER_PAUSED`);
 * - `retry` - строку меняли одновременно, шаг ждёт и перепроверит;
 * - `failed` - отказ ручки досье (409/503): операция ждущего уже на паузе `STEP_FAILED`.
 */
export type ContextDemand =
  | { kind: 'ready'; dossier: BookDossier; glossary: BookGlossary }
  | { kind: 'wait'; waitingFor: string; reason: 'DOSSIER_BUILDING' | 'GLOSSARY_BUILDING' }
  | { kind: 'stopped'; reason: string; blockedBy: string | null }
  | { kind: 'retry'; code: string }
  | { kind: 'failed'; code: string };

export async function demandContext(
  dossiers: DossierService,
  tasks: LlmTaskService,
  input: {
    versionId: string;
    language: Language;
    operationId: string;
    waitingFor: string | null;
    /** Досье, к которому шаг уже привязан (запуск): глоссарий - к нему, досье не запрашивается. */
    dossier?: BookDossier | null;
    translationRunId?: string | null;
    /** Готовое устаревшее досье - строить новым поколением, а не отдавать как есть. */
    rebuildStale?: boolean;
    /** Лимита не хватило на досье или глоссарий - до паузы операции ждущего (`F05-7`). */
    onLimit?: (tx: Prisma.TransactionClient, minLimitUsd: Prisma.Decimal) => Promise<void>;
  },
): Promise<ContextDemand> {
  const options = {
    waiter: {
      operationId: input.operationId,
      waitingFor: input.waitingFor,
      translationRunId: input.translationRunId ?? null,
      onLimit: input.onLimit,
    },
  };
  try {
    let dossier = input.dossier ?? null;
    if (!dossier) {
      const demand = await dossiers.demandDossier(input.versionId, {
        ...options,
        rebuildStale: input.rebuildStale,
      });
      if (demand.status !== 'ready') return notReady(demand, 'DOSSIER_BUILDING');
      dossier = demand.row;
    }
    const glossary = await dossiers.demandGlossary(dossier.id, input.language, options);
    if (glossary.status !== 'ready') return notReady(glossary, 'GLOSSARY_BUILDING');
    return { kind: 'ready', dossier, glossary: glossary.row };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const code = httpCode(error);
    if (CONTEXT_RETRY_CODES.has(code)) return { kind: 'retry', code };
    await tasks.pauseOperation(input.operationId, 'STEP_FAILED');
    return { kind: 'failed', code };
  }
}

function notReady<Row extends { id: string }>(
  demand: Exclude<Demand<Row>, { status: 'ready' }>,
  reason: 'DOSSIER_BUILDING' | 'GLOSSARY_BUILDING',
): ContextDemand {
  if (demand.status === 'wait') return { kind: 'wait', waitingFor: demand.row.id, reason };
  if (demand.status === 'paused') {
    return { kind: 'stopped', reason: demand.reason, blockedBy: demand.builderOperationId };
  }
  return { kind: 'stopped', reason: 'STEP_FAILED', blockedBy: null };
}
