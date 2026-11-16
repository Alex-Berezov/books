import { isFilled } from '../book-analysis/book-analysis-core';
import type { StoredWorldEntity } from './book-world-data';

/** Ошибка ссылки или ключа: путь поля внутри сущности (`relations.0.to`) или тела (`entities.1.key`). */
export interface WorldRefError {
  path: string;
  message: string;
}

export interface WorldRefContext {
  /** Ключи героев анализа этой версии (`BookAnalysis.characters[].key`). */
  analysisKeys: ReadonlySet<string>;
  /** Ключи сущностей версии после записи: сохранённые плюс пришедшие в теле. */
  entityKeys: ReadonlySet<string>;
}

/**
 * Ссылки на **слитой** сущности (как `checkAnalysisRefs`): `relations[].to` и `quotes[].speakerKey` —
 * ключ сущности версии или героя анализа (ключ мира не обязан совпадать с анализом, решение
 * арбитра `F08 | F08-1` R7); связь с собой — отказ. Внешние блоки (`critique`, `prototypes`,
 * `adaptations`) — только при `sources` (`tech.md` §3).
 */
export function checkWorldRefs(entity: StoredWorldEntity, ctx: WorldRefContext): WorldRefError[] {
  const errors: WorldRefError[] = [];
  const known = (key: string) => ctx.entityKeys.has(key) || ctx.analysisKeys.has(key);

  for (const ref of worldEntityRefs(entity)) {
    if (ref.kind === 'relation' && ref.key === entity.key) {
      errors.push({ path: ref.path, message: 'an entity cannot relate to itself' });
    } else if (!known(ref.key)) {
      errors.push({ path: ref.path, message: `unknown entity or character key "${ref.key}"` });
    }
  }

  if ((entity.sources ?? []).length === 0) {
    if (isFilled(entity.critique)) {
      errors.push({ path: 'critique', message: 'critique needs sources' });
    }
    if (isFilled(entity.prototypes)) {
      errors.push({ path: 'prototypes', message: 'prototypes need sources' });
    }
    if ((entity.adaptations ?? []).length > 0) {
      errors.push({ path: 'adaptations', message: 'adaptations need sources' });
    }
  }
  return errors;
}

/**
 * Поля-ссылки сущности на ключи — один перечень на проверку ссылок и на отказ удаления
 * (`WORLD_ENTITY_REFERENCED`): `relations[].to` и `quotes[].speakerKey`.
 */
export function worldEntityRefs(
  entity: Pick<StoredWorldEntity, 'relations' | 'quotes'>,
): { kind: 'relation' | 'speaker'; path: string; key: string }[] {
  const refs: { kind: 'relation' | 'speaker'; path: string; key: string }[] = [];
  (entity.relations ?? []).forEach((r, j) => {
    if (typeof r.to === 'string')
      refs.push({ kind: 'relation', path: `relations.${j}.to`, key: r.to });
  });
  (entity.quotes ?? []).forEach((q, j) => {
    if (typeof q.speakerKey === 'string' && q.speakerKey !== '') {
      refs.push({ kind: 'speaker', path: `quotes.${j}.speakerKey`, key: q.speakerKey });
    }
  });
  return refs;
}

/** Дубль ключа в теле импорта версии: путь второго и следующих (`entities.N.key`). */
export function duplicateWorldKeys(entities: readonly { key: string }[]): WorldRefError[] {
  const seen = new Set<string>();
  const errors: WorldRefError[] = [];
  entities.forEach((e, i) => {
    if (seen.has(e.key)) {
      errors.push({ path: `entities.${i}.key`, message: `duplicate key "${e.key}"` });
    }
    seen.add(e.key);
  });
  return errors;
}
