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
