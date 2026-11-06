import { Prisma } from '@prisma/client';
import { uniqueViolationFields } from '../../../shared/prisma/prisma-error.util';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { AUTOSTART_DUPLICATE, AutostartKind } from '../autostart/content-autostart.constants';
import { DRAFT_IN_PROGRESS } from './content-draft.constants';

/** Ход вида с артиклем - в тексте отказа («a summary run», «an analysis run»). */
export const RUN_OF: Record<AutostartKind, string> = {
  summary_write: 'a summary run',
  analysis_write: 'an analysis run',
};

/** «A summary run is already being built» / «An analysis run is already being built». */
export const buildingText = (kind: AutostartKind): string =>
  `${RUN_OF[kind].charAt(0).toUpperCase()}${RUN_OF[kind].slice(1)} is already being built`;

/**
 * Отказ записи при старте хода пересказа или анализа - ручном и автозапуском (`F06/tech.md` §4
 * п.3): один строящийся ход вида на версию - частичным уникальным индексом, а не чтением (L-019). P2002 по индексу автозапуска (язык, вид) -
 * `AUTOSTART_DUPLICATE`, тихий выход; прочее (частичный индекс строящегося, пустой разбор под
 * адаптером) - `DRAFT_IN_PROGRESS`. Не P2002 - как есть.
 */
export function startConflict(error: unknown, autostart: boolean, kind: AutostartKind): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
    return error;
  }
  if (autostart && uniqueViolationFields(error).includes('translationRunLanguageId')) {
    return llmTaskConflict(AUTOSTART_DUPLICATE, 'This language has already started a run');
  }
  return llmTaskConflict(DRAFT_IN_PROGRESS, buildingText(kind));
}
