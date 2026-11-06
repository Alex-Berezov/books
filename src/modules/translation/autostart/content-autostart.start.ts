import { Prisma } from '@prisma/client';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { buildingText, RUN_OF } from '../content-draft/start-conflict';
import {
  AUTOSTART_SKIPPED_EXISTING,
  AUTOSTART_SKIPPED_IN_PROGRESS,
  AutostartKind,
} from './content-autostart.constants';

/**
 * Старт автозапуском по `done` языка запуска (`F06-5`, `F07-3b`; `F06/tech.md` §4 п.2-п.4): прежние
 * ходы не отбрасываются, ход и его операция несут ссылки на язык и запуск (решение арбитра
 * `F06 | F06-5`, Р5).
 */
export interface AutostartLink {
  translationRunLanguageId: string;
  translationRunId: string;
}

/**
 * Автозапуск рядом с живым ходом вида не заводится (решение арбитра `F06 | F06-5`, Р9): чтение под
 * замком раздела - ручной старт берёт тот же замок до своей строки.
 */
export async function assertNoLiveRun(
  tx: Prisma.TransactionClient,
  versionId: string,
  kind: AutostartKind,
): Promise<void> {
  const live = await tx.contentDraft.findFirst({
    where: { bookVersionId: versionId, kind, status: { in: ['building', 'ready'] } },
    select: { status: true },
  });
  if (live?.status === 'building') {
    throw llmTaskConflict(AUTOSTART_SKIPPED_IN_PROGRESS, buildingText(kind));
  }
  if (live) {
    throw llmTaskConflict(AUTOSTART_SKIPPED_EXISTING, `The version already has ${RUN_OF[kind]}`);
  }
}
