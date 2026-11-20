import {
  pairEvidenceOf,
  pairFounded,
  pairKeyTaken,
  WORLD_PAIR_SEPARATOR,
  worldPairKey,
} from '../../book-world/world-refs';
import { hasWorldPairExample } from './examples';
import { WORLD_PAIRS_MAX } from './world-write.constants';
import type {
  WorldCandidate,
  WorldPairCandidate,
  WorldPairsOffReason,
  WorldSkip,
} from './world-write.data';
import { pairFormCharacters, storedCharacterKeys, type WorldContext } from './world-write.steps';

/** Герой-кандидат хода с присутствием шага выбора: главы и общие главы с другими кандидатами. */
export interface WorldPairHero {
  key: string;
  chapters: number[];
  /** Общие главы с другими кандидатами хода (`WorldMentionCounter` с `coPresenceKeys`). */
  coPresence: Record<string, number[]>;
}

export interface WorldPairSelection {
  pairs: WorldPairCandidate[];
  skipped: WorldSkip[];
}

/**
 * Кандидаты пар хода (`F08-8e`, решения арбитра `F08 | F08-8e-1` Q1, Q3, Q4): пары героев-кандидатов
 * этого хода, прошедшие условие заведения `pairFounded` (та же функция, что у записи, `F08 | F08-8c`
 * Q5) по присутствию в памяти, и уже заведённые пары этих героев - без условия (R1). Ключ пары
 * не собрать (`worldPairKey`) - `PAIR_KEY_INVALID`; ключ занят сущностью другого типа - `PAIR_KEY_TAKEN`;
 * сверх `WORLD_PAIRS_MAX` - `PAIRS_MAX`. Порядок: связанные в анализе, затем по убыванию общих глав,
 * при равенстве - по ключу. Отсеянными считаются только пары, которые иначе вошли бы в ход.
 */
export function selectWorldPairs(
  heroes: readonly WorldPairHero[],
  analysisCharacters: unknown,
  storedTypes: ReadonlyMap<string, string>,
): WorldPairSelection {
  const evidence = pairEvidenceOf(
    analysisCharacters,
    new Map(heroes.map((h) => [h.key, { chapters: h.chapters, coPresence: h.coPresence }])),
  );
  const taken: WorldPairCandidate[] = [];
  const skipped: WorldSkip[] = [];
  const sorted = [...heroes].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const [a, b] = [sorted[i], sorted[j]];
      const e = evidence(a.key, b.key);
      const key = worldPairKey(a.key, b.key);
      const stored = key === null ? undefined : storedTypes.get(key);
      if (stored !== 'pair' && !pairFounded(e)) continue;
      const chapters = (a.coPresence[b.key] ?? []).slice().sort((x, y) => x - y);
      if (key === null) {
        skipped.push({
          key: `${a.key}${WORLD_PAIR_SEPARATOR}${b.key}`,
          reason: 'PAIR_KEY_INVALID',
          chapters: chapters.length,
        });
      } else if (pairKeyTaken(stored)) {
        skipped.push({ key, reason: 'PAIR_KEY_TAKEN', chapters: chapters.length });
      } else {
        taken.push({ key, a: a.key, b: b.key, linked: e.isLinked, chapters });
      }
    }
  }
  taken.sort(
    (x, y) =>
      Number(y.linked) - Number(x.linked) ||
      y.chapters.length - x.chapters.length ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
  for (const p of taken.slice(WORLD_PAIRS_MAX)) {
    skipped.push({ key: p.key, reason: 'PAIRS_MAX', chapters: p.chapters.length });
  }
  return { pairs: taken.slice(0, WORLD_PAIRS_MAX), skipped };
}

/** Кандидаты шага выбора: прошедшие порог, отсеянные порогом и общие главы между кандидатами. */
export interface ChosenCandidates {
  candidates: WorldCandidate[];
  leftOut: WorldSkip[];
  coPresence: ReadonlyMap<string, Record<string, number[]>>;
}

/**
 * Пары хода и отсеянные шагом выбора (`F08-8e`) - весь отбор пар в одном месте: новые герои с ключом
 * вида пары - `KEY_PAIR_FORM` (Q7), второстепенные ниже порога, отбор пар `selectWorldPairs` среди
 * кандидатов; на языке без эталона пары пар нет (`WORLD_PAIR_LANGUAGE`, Q6).
 */
export function choosePairs(
  context: WorldContext,
  chosen: ChosenCandidates,
): { pairs: WorldPairCandidate[]; leftOut: WorldSkip[]; pairsOff: WorldPairsOffReason | null } {
  const pairForm: WorldSkip[] = pairFormCharacters(
    context.analysis,
    storedCharacterKeys(context.entities),
  ).map((c) => ({ key: c.key, reason: 'KEY_PAIR_FORM', chapters: null }));
  if (!hasWorldPairExample(context.language)) {
    return {
      pairs: [],
      leftOut: [...pairForm, ...chosen.leftOut],
      pairsOff: 'WORLD_PAIR_LANGUAGE',
    };
  }
  const selection = selectWorldPairs(
    chosen.candidates.map((c) => ({
      key: c.key,
      chapters: c.mentions.chapters,
      coPresence: chosen.coPresence.get(c.key) ?? {},
    })),
    context.analysis.characters,
    new Map([...context.entities].map(([key, e]) => [key, e.type] as const)),
  );
  return {
    pairs: selection.pairs,
    leftOut: [...pairForm, ...chosen.leftOut, ...selection.skipped],
    pairsOff: null,
  };
}
