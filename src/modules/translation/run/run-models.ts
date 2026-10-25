import { Prisma } from '@prisma/client';

/** Модели вызова этапа: `model` без `fallbacks` - одна модель без запасных. */
export interface StageModels {
  model?: string;
  fallbacks?: string[];
}

interface SnapshotStage {
  stage: string;
  model: string;
  fallbacks?: unknown;
}

/**
 * Модели этапа для шага запуска (решение арбитра `F05 | F05-4a`, В1): `stageModels` запуска -
 * одна модель без запасных; иначе модель и запасные этапа из снимка операции запуска; этапа
 * в снимке нет - пусто, вызов идёт на живой настройке.
 */
export function runStageModels(
  snapshot: Prisma.JsonValue | null,
  stageModels: Prisma.JsonValue,
  stage: string,
): StageModels {
  const override = (stageModels ?? {}) as Record<string, unknown>;
  if (typeof override[stage] === 'string') return { model: override[stage], fallbacks: [] };
  const stages = ((snapshot ?? {}) as { stages?: unknown }).stages;
  const taken = Array.isArray(stages)
    ? (stages as SnapshotStage[]).find((s) => s?.stage === stage)
    : undefined;
  if (!taken || typeof taken.model !== 'string') return {};
  const fallbacks = Array.isArray(taken.fallbacks)
    ? taken.fallbacks.filter((f): f is string => typeof f === 'string')
    : [];
  return { model: taken.model, fallbacks };
}

/** Модели одного этапа в истории запусков (`F05-8`). */
export interface RunStageModelsRow {
  stage: string;
  model: string;
  fallbacks: string[];
}

/**
 * Какие модели выбраны у запуска (решение арбитра `F05 | F05-8`, В4): по этапам в порядке
 * конвейера, как их возьмёт шаг (`runStageModels`). Выбранные, а не вызванные: включён ли этап,
 * шаг читает из живой настройки в момент вызова (`LlmService.callStage`, `jev-step.ts`), не из
 * снимка, - фактические вызовы и их модели в отчёте запуска. Этапа без модели в снимке нет.
 * Этапы - только те, что шаг зовёт моделями снимка (`RUN_HISTORY_STAGES`).
 */
export function runModelsOf(
  snapshot: Prisma.JsonValue | null,
  stageModels: Prisma.JsonValue,
  stages: readonly string[],
): RunStageModelsRow[] {
  return stages.flatMap((stage) => {
    const { model, fallbacks } = runStageModels(snapshot, stageModels, stage);
    return model ? [{ stage, model, fallbacks: fallbacks ?? [] }] : [];
  });
}
