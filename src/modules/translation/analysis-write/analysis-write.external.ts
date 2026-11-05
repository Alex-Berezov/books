import type { BookAnalysisFactsDto } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { normalized } from '../check/mechanical-check';
import { codeRemark, DraftRemark } from '../draft-quality/text-checks';
import {
  DroppedSource,
  EXTERNAL_FACTS,
  SourceRefs,
  StepBlocks,
  StepDraft,
  StepFix,
} from './analysis-write.data';

/**
 * Проверка источников внешнего шага (`F07-2a`; `features/F07-analysis-autofill/product.md` §3.3,
 * `tech.md` §4). Страницы открывает фетчер (`SourceFetcherService`), здесь - чистое решение по их
 * итогам: источник, который не открылся или не про эту книгу, выбрасывается с причиной, а
 * утверждения, державшиеся только на нём, - вместе с ним. Источник без утверждений не нужен.
 * Внешний блок без единого проверенного источника не пишется.
 */

/** Итог открытия одного источника: страница и хост (в журнал и данные - только хост). */
export interface PageCheck {
  host: string;
  /** Страница открылась (`200`, разрешённый тип). */
  opened: boolean;
  /** Текст страницы без тегов; пусто, если не открылась. */
  text: string;
  /**
   * Не открылась из-за канала (`NETWORK`, `TIMEOUT`), а не из-за самой страницы: такой отказ
   * ничего не говорит об источнике (`sourcesOffline`).
   */
  transport?: boolean;
}

/**
 * Все источники не открылись по вине канала: у исполнителя нет сети, а не у модели плохие
 * источники. Тогда шаг не решается - иначе живые источники ушли бы как `SOURCE_UNREACHABLE`
 * вместе с оплаченным ответом.
 */
export const sourcesOffline = (checks: readonly PageCheck[]): boolean =>
  checks.length > 0 && checks.every((check) => !check.opened && check.transport === true);

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Страница про эту книгу: в тексте без тегов есть название книги (на языке версии или оригинала)
 * либо фамилия автора - **целым словом**: «Eco» не находится в «economy», «Dune» - в «Dunedin».
 * Сравнение без регистра и диакритики (`normalized`), границы слова - по буквам и цифрам любого
 * письма. Короткие названия (меньше трёх знаков) не считаются. Падеж фамилии («Достоевского») не
 * совпадает: такая страница проходит по названию книги.
 */
export function pageIsAbout(
  text: string,
  titles: readonly string[],
  authors: readonly string[],
): boolean {
  const page = normalized(text).replace(/\s+/g, ' ');
  const needles = [...titles, ...authors.map(surname)]
    .map((n) => normalized(n).trim().replace(/\s+/g, ' '))
    .filter((n) => n.length >= 3);
  return needles.some((needle) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escaped(needle)}(?![\\p{L}\\p{N}])`, 'u').test(page),
  );
}

/** Фамилия - последнее слово имени автора («Фёдор Достоевский» → «Достоевский»). */
export function surname(author: string): string {
  const words = author.trim().split(/\s+/);
  return words[words.length - 1] ?? '';
}

/** Хост адреса для журнала и данных; не адрес - пустая строка. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface ExternalVerdict {
  draft: StepDraft;
  droppedSources: DroppedSource[];
  /** Причины снятия источников и утверждений: в запись шага (`dropped`). */
  fixes: StepFix[];
  /** Единицы записи (`facts.genre`, `context`…), которые ответ дал, а проверка сняла целиком. */
  unverified: string[];
}

const keep = <T>(list: readonly T[], refs: number[][], alive: (refs: number[]) => boolean): T[] =>
  list.filter((_, i) => alive(refs[i] ?? []));

/**
 * Решение по итогам открытия: `checks[i]` - источник `i` ответа. Ссылки на несуществующий источник
 * и на выброшенный не считаются; утверждение без живой ссылки снимается, источник без живых
 * утверждений тоже. Абзац `context`/`reception` без источника снимается (по абзацам).
 */
export function verifyExternal(
  draft: StepDraft,
  checks: readonly PageCheck[],
  titles: readonly string[],
  authors: readonly string[],
): ExternalVerdict {
  const sources = draft.blocks.sources ?? [];
  const refs: SourceRefs = draft.refs ?? {
    facts: {},
    context: [],
    reception: [],
    timeline: [],
    adaptations: [],
  };
  const fixes: StepFix[] = [];
  const droppedSources: DroppedSource[] = [];
  const good = new Set<number>();
  sources.forEach((source, i) => {
    const check = checks[i];
    const host = check?.host ?? '';
    if (!check?.opened) {
      droppedSources.push({ title: source.title, host, reason: 'SOURCE_UNREACHABLE' });
      fixes.push({
        code: 'SOURCE_UNREACHABLE',
        path: `sources.${i}`,
        note: `${host || 'the address'} did not open: the source is dropped`,
      });
    } else if (!pageIsAbout(check.text, titles, authors)) {
      droppedSources.push({ title: source.title, host, reason: 'SOURCE_UNRELATED' });
      fixes.push({
        code: 'SOURCE_UNRELATED',
        path: `sources.${i}`,
        note: `${host} does not mention the book or the author: the source is dropped`,
      });
    } else {
      good.add(i);
    }
  });
  const alive = (own: number[]): boolean => own.some((n) => good.has(n));
  const used = new Set<number>();
  const mark = (own: number[]) => own.filter((n) => good.has(n)).forEach((n) => used.add(n));
  const gone = (path: string) =>
    fixes.push({
      code: 'SOURCE_UNVERIFIED',
      path,
      note: 'no verified source stands behind it: the statement is dropped',
    });

  const blocks: StepBlocks = {};
  const facts: BookAnalysisFactsDto = {};
  for (const field of EXTERNAL_FACTS) {
    const text = draft.blocks.facts?.[field];
    if (!text) continue;
    const own = refs.facts[field] ?? [];
    if (alive(own)) {
      facts[field] = text;
      mark(own);
    } else gone(`facts.${field}`);
  }
  if (Object.keys(facts).length > 0) blocks.facts = facts;

  for (const key of ['context', 'reception'] as const) {
    const text = draft.blocks[key];
    if (!text) continue;
    const paragraphs = text.split('\n\n');
    const own = refs[key];
    const kept = paragraphs.filter((_, i) => {
      const ok = alive(own[i] ?? []);
      if (ok) mark(own[i] ?? []);
      else gone(`${key}.${i}`);
      return ok;
    });
    if (kept.length > 0) blocks[key] = kept.join('\n\n');
  }
  for (const key of ['timeline', 'adaptations'] as const) {
    const list: readonly unknown[] = draft.blocks[key] ?? [];
    list.forEach((_, i) => {
      if (!alive(refs[key][i] ?? [])) gone(`${key}.${i}`);
      else mark(refs[key][i] ?? []);
    });
    const kept = keep(list, refs[key], alive);
    if (kept.length > 0) (blocks as Record<string, unknown>)[key] = kept;
  }
  const usedSources = sources.filter((_, i) => used.has(i));
  if (usedSources.length > 0 && Object.keys(blocks).length > 0) blocks.sources = usedSources;
  // Внешний блок без проверенного источника не пишется: утверждения без источников уже сняты, а
  // источник без утверждений не нужен - `sources` один не остаётся.
  const final = blocks.sources ? blocks : {};
  const unverified = presentTargets(draft.blocks).filter(
    (target) => !presentTargets(final).includes(target),
  );
  return { draft: { ...draft, blocks: final }, droppedSources, fixes, unverified };
}

/** Единицы записи, которые есть в блоках: подполя `facts` по одному, прочие блоки по имени. */
function presentTargets(blocks: StepBlocks): string[] {
  return Object.entries(blocks).flatMap(([key, value]) =>
    key === 'facts' ? Object.keys(value as object).map((f) => `facts.${f}`) : [key],
  );
}

/**
 * Источники, не прошедшие DTO импорта (`IMPORT_INVALID` по пути `sources.<i>…`: адрес не `https`,
 * слишком длинное название), выбрасываются **по одному**, со сдвигом ссылок (`product.md` §3.3):
 * общее снятие блока по пути (`withoutInvalid`) убрало бы все источники шага, и все внешние
 * утверждения ушли бы без проверки. Замечания этих источников уходят из флагов - причина в
 * `dropped`.
 */
export function withoutInvalidSources(
  draft: StepDraft,
  remarks: readonly DraftRemark[],
): { draft: StepDraft; remarks: DraftRemark[]; fixes: StepFix[] } {
  const pathOf = (r: DraftRemark) => r.where.split(/[:\s]/, 1)[0];
  const bad = new Set<number>();
  const rest = remarks.filter((r) => {
    const match = r.code === 'IMPORT_INVALID' ? /^sources\.(\d+)(?:\.|$)/.exec(pathOf(r)) : null;
    if (match) bad.add(Number(match[1]));
    return !match;
  });
  if (bad.size === 0) return { draft, remarks: [...remarks], fixes: [] };
  const sources = draft.blocks.sources ?? [];
  const remap = new Map<number, number>();
  const kept = sources.filter((_, i) => {
    if (bad.has(i)) return false;
    remap.set(i, remap.size);
    return true;
  });
  const move = (refs: number[]) =>
    refs.flatMap((n) => (remap.has(n) ? [remap.get(n) as number] : []));
  const refs = draft.refs ?? EMPTY_REFS;
  const blocks: StepBlocks = { ...draft.blocks };
  if (kept.length > 0) blocks.sources = kept;
  else delete blocks.sources;
  return {
    draft: {
      ...draft,
      blocks,
      refs: {
        facts: Object.fromEntries(Object.entries(refs.facts).map(([k, v]) => [k, move(v ?? [])])),
        context: refs.context.map(move),
        reception: refs.reception.map(move),
        timeline: refs.timeline.map(move),
        adaptations: refs.adaptations.map(move),
      },
    },
    remarks: rest,
    fixes: [...bad]
      .sort((a, b) => a - b)
      .map((i) => ({
        code: 'IMPORT_INVALID' as const,
        path: `sources.${i}`,
        note: 'the source does not pass the import (address or title): the source is dropped',
      })),
  };
}

const EMPTY_REFS: SourceRefs = {
  facts: {},
  context: [],
  reception: [],
  timeline: [],
  adaptations: [],
};

/** Флаг `EXTERNAL_CHECK` на каждой единице записи внешнего шага, которая есть в итоге. */
export function externalChecks(blocks: StepBlocks): DraftRemark[] {
  return presentTargets(blocks).map((path) =>
    codeRemark(
      'EXTERNAL_CHECK',
      path,
      'The source opens and is about this book, but nobody has checked that it says the same: check dates and names.',
    ),
  );
}

/** Путь утверждения в замечании: блок и номер (`timeline.2`, `context.1`, `facts.genre`). */
function statementOf(where: string): { block: string; index: number | null } {
  const [path] = where.split(/[:\s]/, 1);
  const [block, second] = path.split('.');
  const index = second !== undefined && /^\d+$/.test(second) ? Number(second) : null;
  return { block: block === 'facts' && second ? `facts.${second}` : block, index };
}

/**
 * `EXTERNAL_DOUBT` после переделки (`product.md` §3.4): утверждение, в котором проверяющая
 * сомневается, снимается - не пишется с флагом. Путь без номера снимает блок целиком; ссылки
 * снятых элементов уходят вместе с ними, чтобы не разъехаться с абзацами и элементами.
 */
export function withoutDoubted(
  draft: StepDraft,
  remarks: readonly DraftRemark[],
): { draft: StepDraft; fixes: StepFix[]; applied: DraftRemark[] } {
  const doubted = remarks
    .filter((r) => r.code === 'EXTERNAL_DOUBT')
    .map((r) => statementOf(r.where));
  if (doubted.length === 0) return { draft, fixes: [], applied: [] };
  const blocks: Record<string, unknown> = { ...draft.blocks };
  const refs: SourceRefs = draft.refs ?? {
    facts: {},
    context: [],
    reception: [],
    timeline: [],
    adaptations: [],
  };
  const next: SourceRefs = { ...refs, facts: { ...refs.facts } };
  const fixes: StepFix[] = [];
  const drop = (path: string) =>
    fixes.push({
      code: 'EXTERNAL_DOUBT',
      path,
      note: 'the reviewer doubts it: the statement is dropped',
    });
  const gone = (block: string) =>
    new Set(doubted.filter((d) => d.block === block).map((d) => d.index));
  for (const field of EXTERNAL_FACTS) {
    const facts = blocks.facts as Record<string, string> | undefined;
    if (
      !facts?.[field] ||
      !doubted.some((d) => d.block === `facts.${field}` || d.block === 'facts')
    ) {
      continue;
    }
    const rest = { ...facts };
    delete rest[field];
    if (Object.keys(rest).length > 0) blocks.facts = rest;
    else delete blocks.facts;
    delete next.facts[field];
    drop(`facts.${field}`);
  }
  for (const key of ['context', 'reception'] as const) {
    const indexes = gone(key);
    const text = blocks[key] as string | undefined;
    if (!text || indexes.size === 0) continue;
    const paragraphs = text.split('\n\n');
    const keep = paragraphs.map((_, i) => !indexes.has(null) && !indexes.has(i));
    paragraphs.forEach((_, i) => !keep[i] && drop(`${key}.${i}`));
    const kept = paragraphs.filter((_, i) => keep[i]);
    if (kept.length > 0) blocks[key] = kept.join('\n\n');
    else delete blocks[key];
    next[key] = refs[key].filter((_, i) => keep[i]);
  }
  for (const key of ['timeline', 'adaptations'] as const) {
    const indexes = gone(key);
    const list = blocks[key] as unknown[] | undefined;
    if (!list || indexes.size === 0) continue;
    const keep = list.map((_, i) => !indexes.has(null) && !indexes.has(i));
    list.forEach((_, i) => !keep[i] && drop(`${key}.${i}`));
    const kept = list.filter((_, i) => keep[i]);
    if (kept.length > 0) blocks[key] = kept;
    else delete blocks[key];
    next[key] = refs[key].filter((_, i) => keep[i]);
  }
  // Сомнение снято только то, что дало правку: путь, который разбор не узнал (`sources.1`,
  // `timeline[2]`), остаётся флагом - иначе сомнение пропало бы без следа.
  const applied = remarks.filter((r) => {
    if (r.code !== 'EXTERNAL_DOUBT') return false;
    const { block, index } = statementOf(r.where);
    return fixes.some((f) =>
      index === null
        ? f.path === block || f.path.startsWith(`${block}.`)
        : f.path === `${block}.${index}`,
    );
  });
  return { draft: { ...draft, blocks: blocks as StepBlocks, refs: next }, fixes, applied };
}
