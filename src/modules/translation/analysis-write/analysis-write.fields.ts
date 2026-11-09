import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ContentDraft, Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BOOK_ANALYSIS_SELECT,
  EMPTY_BOOK_ANALYSIS,
  readStoredAnalysis,
  StoredBookAnalysis,
} from '../../book-analysis/book-analysis-data';
import { BOOK_ANALYSIS_TX_OPTIONS, lockBookAnalysis } from '../../book-analysis/book-analysis-lock';
import { BookAnalysisService } from '../../book-analysis/book-analysis.service';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import type { UpdateBookAnalysisDto } from '../../book-analysis/dto/update-book-analysis.dto';
import { compactBlock } from '../../author/author-page-data';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { analysisImportErrors } from '../content-draft/content-draft.analysis';
import { codeRemark } from '../draft-quality/text-checks';
import { blockOfPath, coreRemark } from './analysis-checks';
import {
  ANALYSIS_BLOCK_CHANGED,
  ANALYSIS_ITEM_NOT_PROPOSED,
  ANALYSIS_PROPOSAL_CHANGED,
  ANALYSIS_REGEN_IN_PROGRESS,
  CORE_STEP,
  ANALYSIS_WRITE_REFUSED,
} from './analysis-write.constants';
import {
  ANALYSIS_TARGETS,
  analysisDataJson,
  AnalysisItem,
  AnalysisSource,
  AnalysisStepNumber,
  AnalysisTarget,
  AnalysisWriteData,
  blockOfTarget,
  blockPrint,
  factField,
  proposalPrint,
  readAnalysisData,
  stableJson,
  StepFix,
  targetValue,
  THEMES_STEP,
  ThemeLinks,
  withItem,
  mergedLinks,
  withRegenTaken,
  withSources,
  withStepFixes,
} from './analysis-write.data';
import { quotePrint } from './analysis-write.steps';

type Db = Prisma.TransactionClient;

/**
 * Чья запись идёт: ход `building` своей операции, перегенерация блока своей операцией у хода
 * `ready` или решение редактора по ходу `ready` (`F07-1b`). Не совпало - ход отбросили, отменили
 * или он кончился: ничего не пишется (`L-019`). Под замком строка хода берётся `FOR UPDATE`, а
 * данные пишутся условием статуса (и операции хода): отмена со страницы операций
 * (`onCancelled`) ждёт коммита записи шага и не проскакивает между проверкой и записью.
 */
export interface AnalysisGate {
  /** Статус строки, в котором пишутся данные; `building` - ещё и операция хода. */
  status: 'building' | 'ready';
  operationId: string | null;
  allows: (row: ContentDraft, data: AnalysisWriteData) => boolean;
}

export const analysisRunGate = (operationId: string): AnalysisGate => ({
  status: 'building',
  operationId,
  allows: (row) => row.status === 'building' && row.operationId === operationId,
});

/** Перегенерация блока `index` операцией `operationId`: пока отметка на блоке её. */
export const analysisRegenGate = (operationId: string, index: number): AnalysisGate => ({
  status: 'ready',
  operationId,
  allows: (row, data) =>
    row.status === 'ready' && data.items[index]?.regen?.operationId === operationId,
});

/** Решения редактора по блокам хода `ready` (`tech.md` §5). */
export const analysisReadyGate: AnalysisGate = {
  status: 'ready',
  operationId: null,
  allows: (row) => row.status === 'ready',
};

const notProposed = () =>
  llmTaskConflict(ANALYSIS_ITEM_NOT_PROPOSED, 'The block is not a proposal');
const proposalChanged = () =>
  llmTaskConflict(ANALYSIS_PROPOSAL_CHANGED, 'The proposal changed: read it again');
const regenInProgress = () =>
  llmTaskConflict(ANALYSIS_REGEN_IN_PROGRESS, 'This block is being regenerated');

function blockChanged(
  current: unknown,
  message = 'The block was changed after the proposal: reload it',
) {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: ANALYSIS_BLOCK_CHANGED,
    message,
    current: current ?? null,
  });
}

/**
 * Источники блока шага 5 из перегенерации (решение арбитра `F07 | F07-2b`, круг 3, B): что они
 * добавляют к сохранённым по адресу и влезает ли объединение в предел импорта. Проверка по факту -
 * по блокам, прочитанным под замком записи; объединение только добавляет, правки редактора в
 * `sources` не затираются, отпечаток для сохранности не нужен.
 */
function sourcesOf(
  item: AnalysisItem,
  stored: StoredBookAnalysis,
): { adds: boolean; fits: boolean; merged: AnalysisSource[] } {
  const merged = withSources(stored.sources, item.pendingSources ?? []);
  return {
    adds: merged.length > (stored.sources ?? []).length,
    fits: merged.length <= BOOK_ANALYSIS_LIMITS.sources,
    merged,
  };
}

/** «Accept» блока шага 5, источники которого не влезают в сохранённые: 409, тело не пишется. */
function sourcesFull() {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: ANALYSIS_WRITE_REFUSED,
    message: `The list of sources is full (at most ${BOOK_ANALYSIS_LIMITS.sources}): free some room or regenerate the block`,
    errors: [`sources: at most ${BOOK_ANALYSIS_LIMITS.sources} sources`],
  });
}

/**
 * Связи тем, по которым ход вливает ключи в героев и цитаты: у тем из перегенерации - связи хода,
 * слитые со связями ответа (`mergedLinks`, как в `withRegenTaken`), у прочих - связи хода. Одно
 * правило у записи хода, у «Accept» и у предложений связей после них.
 */
function linksOfItem(data: AnalysisWriteData, item: AnalysisItem): ThemeLinks | null {
  return item.pendingLinks ? mergedLinks(data.themeLinks, item.pendingLinks) : data.themeLinks;
}

/** Строка хода больше не принимает запись этой операции: транзакция откатывается. */
class AnalysisRunGone extends Error {
  constructor() {
    super('The analysis run no longer takes this write');
    this.name = 'AnalysisRunGone';
  }
}

/** Итог правки данных хода: `written: false` - `fn` отказался писать (`null`). */
interface MutateResult {
  data: AnalysisWriteData;
  written: boolean;
}

/**
 * Отказ проверки ссылок на итоговой записи (решение арбитра `F07 | F07-1a`, К4): блоки первого
 * сегмента путей ошибок уходят предложением с `IMPORT_INVALID` и путём, остальные пишутся
 * повторной записью.
 */
interface Refusal {
  blocks: ReadonlySet<string>;
  errors: readonly string[];
}

/** Блоки версии под замком: решение «записать или предложить» читает их, а не копию. */
interface BlockState {
  stored: StoredBookAnalysis;
  published: boolean;
}

/** Решение по ждущим блокам шага: что пишется одной записью импорта, что - предложением. */
interface StepPlan {
  dto: UpdateBookAnalysisDto | null;
  /** Индекс элемента → содержимое (у `themeKeys` шага 3 - собранное здесь). */
  values: Map<number, unknown>;
  writes: number[];
  proposals: number[];
  /** Связям тем некуда влиться (героев или цитат нет, совпадений нет): элемент снимается. */
  empty: number[];
  /** Предложения из-за отказа проверки ссылок (К4): индекс → ошибки. */
  refused: Map<number, string[]>;
  /** `themeKeys` сверх предела импорта после слияния - отрезаны (`LIMIT_OUT`). */
  cut: StepFix[];
  /** Блоки героев и цитат, в которые записанные новые темы перегенерации вливают связи (`F07-2b`). */
  linked: LinkBlock[];
}

/**
 * Ход вправе писать блок (`tech.md` §5): право на старте, версия не опубликована, и блок с
 * последней записи хода никто не менял - его отпечаток совпадает с `written`.
 */
export function writable(
  data: AnalysisWriteData,
  target: AnalysisTarget,
  state: BlockState,
): boolean {
  return (
    data.owns[target] === true &&
    !state.published &&
    data.written[target] === blockPrint(targetValue(state.stored, target))
  );
}

/**
 * `themeKeys` шага 3 поверх сохранённого блока (`characters` по ключу, `keyQuotes` по отпечатку
 * текста): только ключи записанных тем, без повторов, в предел импорта - лишнее отрезано
 * (`LIMIT_OUT`). Ничего не изменилось - `null`.
 */
function linkThemes<T extends { themeKeys?: string[] | null }>(
  base: readonly T[],
  idOf: (element: T) => string,
  links: Record<string, string[]>,
  themeKeys: ReadonlySet<string>,
  block: string,
  cut: StepFix[],
): T[] | null {
  const max = BOOK_ANALYSIS_LIMITS.themeKeys;
  let changed = false;
  const out = base.map((element) => {
    const id = idOf(element);
    const keys = (links[id] ?? []).filter((key) => themeKeys.has(key));
    if (keys.length === 0) return element;
    const merged = [...new Set([...(element.themeKeys ?? []), ...keys])];
    if (merged.length > max) {
      cut.push({
        code: 'LIMIT_OUT',
        path: `${block}.${id}.themeKeys`,
        note: `${merged.length - max} of ${merged.length} cut: the import takes at most ${max}`,
      });
    }
    const next = merged.slice(0, max);
    if (stableJson(next) === stableJson(element.themeKeys ?? [])) return element;
    changed = true;
    return { ...element, themeKeys: next };
  });
  return changed ? out : null;
}

/** Блоки, в которые вливаются связи тем шага 3 (`themeKeys`). */
const LINK_BLOCKS = ['characters', 'keyQuotes'] as const;
type LinkBlock = (typeof LINK_BLOCKS)[number];

const isLinkBlock = (target: string): target is LinkBlock =>
  (LINK_BLOCKS as readonly string[]).includes(target);

/**
 * Список героев или цитат со связями тем - одна развилка ключа связи: герой - по `key`, цитата - по
 * отпечатку текста. Ничего не добавилось - `null`.
 */
function linkBlock(
  block: LinkBlock,
  list: readonly unknown[],
  links: ThemeLinks,
  themeKeys: ReadonlySet<string>,
  cut: StepFix[],
): unknown[] | null {
  return block === 'characters'
    ? linkThemes(
        list as Array<{ key: string; themeKeys?: string[] | null }>,
        (c) => c.key,
        links.characters,
        themeKeys,
        block,
        cut,
      )
    : linkThemes(
        list as Array<{ text: string; themeKeys?: string[] | null }>,
        (q) => quotePrint(q.text),
        links.keyQuotes,
        themeKeys,
        block,
        cut,
      );
}

/** Сохранённый блок героев или цитат со связями тем; ничего не добавилось - `null`. */
const relinked = (
  block: LinkBlock,
  stored: StoredBookAnalysis,
  links: ThemeLinks,
  themeKeys: ReadonlySet<string>,
  cut: StepFix[],
): unknown[] | null => linkBlock(block, stored[block] ?? [], links, themeKeys, cut);

/**
 * Герои или цитаты шагов 1-2 с `themeKeys` из связей тем шага 3 хода по ключу героя и отпечатку
 * цитаты (`tech.md` §2; решение арбитра `F07 | F07-1a`, А3): только ключи тем, которые есть в
 * анализе (`themeKeys`), без повторов, в предел импорта. Связей нет - значение как есть.
 */
export function withThemeLinks(
  target: AnalysisTarget,
  value: unknown,
  links: ThemeLinks | null,
  themeKeys: ReadonlySet<string>,
  cut: StepFix[],
): unknown {
  if (!links || !Array.isArray(value) || !isLinkBlock(target)) return value;
  return linkBlock(target, value, links, themeKeys, cut) ?? value;
}

/**
 * Решение по ждущим блокам шага (`tech.md` §5): блок, который ход вправе писать, - в тело импорта;
 * остальное - предложение. `themeKeys` шага 3 (`tech.md` §2) вливаются в сохранённые `characters`
 * и `keyQuotes` только ключами тем, которые после этой записи есть в анализе: тема ушла в
 * предложение - её ключ не вливается. `facts` собирается целиком: сохранённые подполя и подполя
 * хода (импорт заменяет блок целиком). Блоки `refusal` (К4) - предложения с ошибками.
 */
export function planStep(
  data: AnalysisWriteData,
  step: AnalysisStepNumber,
  state: BlockState,
  language: Language,
  refusal: Refusal | null = null,
  only?: number,
): StepPlan {
  const plan: StepPlan = {
    dto: null,
    values: new Map(),
    writes: [],
    proposals: [],
    empty: [],
    refused: new Map(),
    cut: [],
    linked: [],
  };
  const waiting = data.items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        item.outcome === 'waiting' && (only === undefined ? item.step === step : index === only),
    );
  const refusedBlock = (target: AnalysisTarget): boolean =>
    refusal !== null && refusal.blocks.has(blockOfTarget(target));
  // Перегенерация (`F07-1b`, как у пересказа): записанный блок она меняет только предложением,
  // пустой (прошлый ответ не прошёл импорт) - пишет.
  const canWrite = (target: AnalysisTarget): boolean =>
    writable(data, target, state) &&
    !refusedBlock(target) &&
    (only === undefined || compactBlock(targetValue(state.stored, target)) === null);
  // Блок шага 5 с новыми источниками пишется вместе с `sources` (решение арбитра `F07 | F07-2b`,
  // п.1): `sources` ход тоже должен быть вправе писать, а объединение - влезать в предел (круг 3, B);
  // иначе - предложение. Все источники блока уже сохранены - `sources` не меняется, право на них
  // не нужно.
  const canWriteItem = (item: AnalysisItem): boolean => {
    if (!canWrite(item.target)) return false;
    const own = sourcesOf(item, state.stored);
    return !own.adds || (own.fits && writable(data, 'sources', state) && !refusedBlock('sources'));
  };
  const themesItem = waiting.find(({ item }) => !item.links && item.target === 'themes');
  const themeKeys = new Set(
    (themesItem !== undefined && canWrite('themes')
      ? (themesItem.item.value as Array<{ key: string }>)
      : (state.stored.themes ?? [])
    ).map((theme) => theme.key),
  );
  const links = data.themeLinks ?? { characters: {}, keyQuotes: {} };
  for (const { item, index } of waiting) {
    let value: unknown = item.value;
    // Отрезанные `themeKeys` перегенерации - в шаг тем, и только если итог записан (`F07-2b`,
    // хвост г): у предложения их отрежет и запишет «Accept».
    const cut: StepFix[] = only !== undefined ? [] : plan.cut;
    // Перегенерация героев или цитат (`F07-1b`): связи тем шага 3 вливаются заново по ключам.
    if (only !== undefined && !item.links) {
      value = withThemeLinks(item.target, value, data.themeLinks, themeKeys, cut);
    }
    if (item.links) {
      value = relinked(item.target as LinkBlock, state.stored, links, themeKeys, plan.cut);
      if (value === null) {
        plan.empty.push(index);
        continue;
      }
    }
    plan.values.set(index, value);
    if (canWriteItem(item)) {
      plan.writes.push(index);
      if (cut !== plan.cut) plan.cut.push(...cut);
      continue;
    }
    plan.proposals.push(index);
    // Перегенерация (`F07-1b`, `tech.md` §2): предложение несёт ошибки ссылок слитого объекта -
    // элемент, на который остались ссылки, пропал из нового ответа - `IMPORT_INVALID` с путём поля.
    if (only !== undefined && !(refusal !== null && refusedBlock(item.target))) {
      const errors = analysisImportErrors(
        state.stored,
        importBodyOf(item.target, value, state.stored, language),
      );
      if (errors.length > 0) plan.refused.set(index, errors);
    }
    if (refusal !== null && refusedBlock(item.target)) {
      const block = blockOfTarget(item.target);
      const own = refusal.errors.filter((error) => blockOfPath(error) === block);
      // Перегенерация (`F07-1b`): ссылка повисла в чужом блоке (герой пропал из ответа, а цитаты на
      // него остались) - предложение несёт путь этой ссылки, а не молчит; шаг хода (К4) - прежний.
      plan.refused.set(index, only !== undefined && own.length === 0 ? [...refusal.errors] : own);
    }
  }
  if (plan.writes.length === 0) return plan;
  const body: Record<string, unknown> = { language };
  for (const index of plan.writes) {
    const target = data.items[index].target;
    const field = factField(target);
    if (field) {
      const facts = (body.facts ?? { ...(state.stored.facts ?? {}) }) as Record<string, unknown>;
      facts[field] = plan.values.get(index);
      body.facts = facts;
    } else {
      body[target] = plan.values.get(index);
    }
  }
  for (const index of plan.writes) {
    const item = data.items[index];
    // Несколько записываемых блоков с источниками в одном решении копят их, а не затирают: сейчас
    // перегенерация решает один блок (`only`), правило держит и решение шага целиком.
    if (item.pendingSources?.length && sourcesOf(item, state.stored).adds) {
      body.sources = withSources(
        (body.sources as AnalysisSource[] | undefined) ?? state.stored.sources,
        item.pendingSources,
      );
    }
    // Записанные новые темы перегенерации (`F07-2b`): их связи вливаются в героев и цитаты, которыми
    // ход владеет, той же записью; в прочие - предложениями (`applyPlan`), как у «Accept» темы.
    if (only !== undefined && item.target === 'themes' && !item.links) {
      const themes = plan.values.get(index) as Array<{ key: string }>;
      const links = linksOfItem(data, item);
      if (!links) continue;
      const own = themeLinkWrites(data, links, themes, state, plan.cut, refusedBlock);
      Object.assign(body, own.bodies);
      plan.linked.push(...own.linked);
    }
  }
  plan.dto = body as unknown as UpdateBookAnalysisDto;
  return plan;
}

/**
 * Решение то же: тело записи, разбиение и **значения** - у предложения `themeKeys` значение
 * собрано из блоков версии, и под замком они должны быть те же, что у решения без замка.
 */
function samePlan(a: StepPlan, b: StepPlan): boolean {
  const form = (plan: StepPlan) =>
    stableJson({
      dto: plan.dto,
      values: [...plan.values],
      writes: plan.writes,
      proposals: plan.proposals,
      empty: plan.empty,
      refused: [...plan.refused],
      cut: plan.cut,
      linked: plan.linked,
    });
  return form(a) === form(b);
}

/** Решение «Accept»: тело записи и блоки связей, которые ход пишет вместе с принятой темой. */
interface AcceptPlan {
  dto: UpdateBookAnalysisDto;
  /** Блоки героев и цитат, которыми ход владеет: ключ принятой темы вливается записью (Б). */
  linked: LinkBlock[];
  /** `themeKeys`, отрезанные этой записью по пределу импорта, - `LIMIT_OUT` шага тем (В3). */
  cut: StepFix[];
  /** Запись несёт новые `sources` (блок шага 5 из перегенерации), и ход владеет ими. */
  sourcesOwned: boolean;
}

/**
 * Тело записи принятого предложения: блок или подполе `facts` (остальные подполя - сохранённые:
 * импорт заменяет `facts` целиком). Героям и цитатам - `themeKeys` из связей тем хода по тем
 * темам, что есть в анализе сейчас (А3); блок связей (`links`) уже собран из сохранённого.
 * Принятая тема (решение арбитра `F07 | F07-1b`, Б; `tech.md` §2:35-36) вливает свои ключи в
 * героев и цитаты, которыми ход ещё владеет, той же записью; в прочие - предложениями
 * (`applyAccept`).
 */
function acceptPlan(
  data: AnalysisWriteData,
  item: AnalysisItem,
  state: BlockState,
  language: Language,
): AcceptPlan {
  const cut: StepFix[] = [];
  const value = item.links
    ? item.value
    : withThemeLinks(
        item.target,
        item.value,
        data.themeLinks,
        new Set((state.stored.themes ?? []).map((theme) => theme.key)),
        cut,
      );
  const dto = importBodyOf(item.target, value, state.stored, language) as unknown as Record<
    string,
    unknown
  >;
  // Источники блока шага 5 из перегенерации - той же записью (решение арбитра `F07 | F07-2b`, п.1).
  const own = sourcesOf(item, state.stored);
  if (own.adds) dto.sources = own.merged;
  let linked: LinkBlock[] = [];
  // Темы из перегенерации несут свои связи (`pendingLinks`); темы шага - связи хода.
  const themeLinks = linksOfItem(data, item);
  if (item.target === 'themes' && !item.links && Array.isArray(value) && themeLinks) {
    const own = themeLinkWrites(data, themeLinks, value as Array<{ key: string }>, state, cut);
    Object.assign(dto, own.bodies);
    linked = own.linked;
  }
  return {
    dto: dto as unknown as UpdateBookAnalysisDto,
    linked,
    cut,
    sourcesOwned: own.adds && writable(data, 'sources', state),
  };
}

/**
 * Связи записываемых тем в героев и цитаты, которыми ход вправе писать (решение арбитра
 * `F07 | F07-1b`, Б): тела блоков в ту же запись. Одно правило у записи хода (`planStep`) и у
 * «Accept» (`acceptPlan`); `refused` - блоки, которым анализ отказал (К4), в запись не идут.
 */
function themeLinkWrites(
  data: AnalysisWriteData,
  links: ThemeLinks,
  themes: ReadonlyArray<{ key: string }>,
  state: BlockState,
  cut: StepFix[],
  refused: (block: LinkBlock) => boolean = () => false,
): { bodies: Partial<Record<LinkBlock, unknown[]>>; linked: LinkBlock[] } {
  const keys = new Set(themes.map((theme) => theme.key));
  const bodies: Partial<Record<LinkBlock, unknown[]>> = {};
  const linked: LinkBlock[] = [];
  for (const block of LINK_BLOCKS) {
    if (!writable(data, block, state) || refused(block)) continue;
    const next = relinked(block, state.stored, links, keys, cut);
    if (next !== null) {
      bodies[block] = next;
      linked.push(block);
    }
  }
  return { bodies, linked };
}

/**
 * После записи тем (ходом или «Accept»): блоки связей, записанные вместе с ними, - на записанном
 * содержимом; прочие получают предложение связей (Б). Одно правило у `applyPlan` и `applyAccept`.
 */
function afterThemesWrite(
  data: AnalysisWriteData,
  links: ThemeLinks,
  saved: StoredBookAnalysis,
  linked: readonly LinkBlock[],
  skip: number,
): AnalysisWriteData {
  const keys = new Set((saved.themes ?? []).map((theme) => theme.key));
  let next = data;
  for (const block of LINK_BLOCKS) {
    next = linked.includes(block)
      ? afterOwnWrite(next, block, saved, skip)
      : syncLinks(next, block, saved, links, keys, skip, true);
  }
  return next;
}

/**
 * После записи `sources` ходом или «Accept» блока шага 5: ход владел блоком - он и дальше его
 * (`written`), предложения `sources` - на записанном.
 */
function afterSourcesWrite(
  data: AnalysisWriteData,
  saved: StoredBookAnalysis,
  skip: number,
): AnalysisWriteData {
  return afterOwnWrite(
    { ...data, written: { ...data.written, sources: blockPrint(targetValue(saved, 'sources')) } },
    'sources',
    saved,
    skip,
  );
}

/**
 * Данные хода после записи «Accept» (`saved` - перечитанные блоки): предложение принято; блоки
 * связей, записанные вместе с темой, - в `written`; предложения связей тронутых блоков
 * пересобраны на записанном блоке (`syncLinks`): иначе их хэш, снятый с прежнего блока, отбил бы
 * следующий «Accept» и «Accept all» своим же ходом. Принятая тема рождает предложения связей у
 * блоков, которыми ход не владеет (Б).
 */
function applyAccept(
  data: AnalysisWriteData,
  index: number,
  plan: AcceptPlan,
  saved: StoredBookAnalysis,
): AnalysisWriteData {
  const item = data.items[index];
  const accepted = withRegenTaken(
    withItem(data, index, { outcome: 'accepted' }),
    index,
    targetValue(saved, item.target),
  );
  const written = { ...accepted.written };
  for (const block of plan.linked) written[block] = blockPrint(targetValue(saved, block));
  let next: AnalysisWriteData = {
    ...accepted,
    written,
    steps: withStepFixes(accepted.steps, THEMES_STEP, plan.cut),
  };
  // `sources` записаны «Accept» блока шага 5 или самого `sources`: соседи сверяют записанное.
  if (plan.sourcesOwned) next = afterSourcesWrite(next, saved, index);
  // Принятые темы перегенерации уже вошли в связи хода (`withRegenTaken`).
  const links = next.themeLinks;
  if (!links) return next;
  if (item.target === 'themes' && !item.links) {
    return afterThemesWrite(next, links, saved, plan.linked, index);
  }
  if (isLinkBlock(item.target) && !plan.linked.includes(item.target)) {
    const themeKeys = new Set((saved.themes ?? []).map((theme) => theme.key));
    next = syncLinks(next, item.target, saved, links, themeKeys, index, false);
  }
  return next;
}

/**
 * Ход записал владеемый блок (тема влила ключи; итог перегенерации - в пустой блок): все
 * предложения этой единицы записи - на записанном содержимом. Обычные получают его хэш (иначе
 * «Accept» отбил бы их 409 навсегда - блок менял сам ход), предложения связей пересобираются
 * (`syncLinks`).
 */
function afterOwnWrite(
  data: AnalysisWriteData,
  target: AnalysisTarget,
  saved: StoredBookAnalysis,
  skip: number,
): AnalysisWriteData {
  const hash = blockPrint(targetValue(saved, target));
  const next = {
    ...data,
    items: data.items.map((other, i) =>
      i !== skip && !other.links && other.target === target && other.outcome === 'proposed'
        ? { ...other, hash }
        : other,
    ),
  };
  if (!data.themeLinks || !isLinkBlock(target)) return next;
  const themeKeys = new Set((saved.themes ?? []).map((theme) => theme.key));
  return syncLinks(next, target, saved, data.themeLinks, themeKeys, skip, false);
}

/**
 * Предложения связей тем блока `block` на записанном блоке: добавлять нечего - предложение
 * снимается (`none`); иначе - новое содержимое и хэш записанного блока.
 * `create` - нет предложения, а ключи есть: новое предложение связей (на месте снятого `none`).
 */
function syncLinks(
  data: AnalysisWriteData,
  block: LinkBlock,
  saved: StoredBookAnalysis,
  links: ThemeLinks,
  themeKeys: ReadonlySet<string>,
  skip: number,
  create: boolean,
): AnalysisWriteData {
  const value = relinked(block, saved, links, themeKeys, []);
  const hash = blockPrint(targetValue(saved, block));
  const items = [...data.items];
  let found = false;
  items.forEach((link, i) => {
    if (i === skip || !link.links || link.target !== block || link.outcome !== 'proposed') return;
    found = true;
    // Добавлять нечего (ключи уже в блоке или темы ещё нет): предложение снимается (`none`); тема,
    // принятая позже, родит его заново на этом месте (`create`).
    items[i] =
      value === null ? { ...link, outcome: 'none', value: null } : { ...link, value, hash };
  });
  if (!found && create && value !== null) {
    const proposal: AnalysisItem = {
      target: block,
      step: THEMES_STEP,
      verdict: 'ok',
      remarks: [],
      review: null,
      outcome: 'proposed',
      hash,
      value,
      failedReason: null,
      links: true,
      regen: null,
      regenFailedReason: null,
    };
    const spare = items.findIndex(
      (link) => link.links && link.target === block && link.outcome === 'none',
    );
    if (spare >= 0) items[spare] = { ...items[spare], ...proposal };
    else items.push(proposal);
  }
  return { ...data, items };
}

/** Тело импорта с одним блоком: подполе `facts` - в сохранённые подполя (импорт заменяет блок целиком). */
function importBodyOf(
  target: AnalysisTarget,
  value: unknown,
  stored: StoredBookAnalysis,
  language: Language,
): UpdateBookAnalysisDto {
  const body: Record<string, unknown> = { language };
  const field = factField(target);
  if (field) body.facts = { ...(stored.facts ?? {}), [field]: value };
  else body[target] = value;
  return body as unknown as UpdateBookAnalysisDto;
}

/** Сколько раз решение пересобирается, если блоки поменялись между чтением и замком. */
export const PLAN_ATTEMPTS = 3;

export type SettleOutcome = 'settled' | 'gone';

/** Ошибки отказа проверки ссылок (`validateMerged`): `<путь>: <сообщение>`. */
function refusalErrors(error: BadRequestException): string[] {
  const body = error.getResponse() as { message?: unknown };
  const message = body.message;
  if (Array.isArray(message)) return message.filter((m): m is string => typeof m === 'string');
  return [typeof message === 'string' ? message : error.message];
}

/**
 * Запись хода анализа в блоки версии (`features/F07-analysis-autofill/tech.md` §5): решение и
 * запись - в одной транзакции под замком анализа, тем же телом, что импорт `F03`
 * (`BookAnalysisService.saveGuarded`, решение арбитра `F07 | F07-1`, В5). Данные хода тоже пишутся
 * только под этим замком и под замком своей строки.
 */
@Injectable()
export class AnalysisWriteFields {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analyses: BookAnalysisService,
  ) {}

  /** Блоки версии; `lock` - строка версии `FOR NO KEY UPDATE`: публикация не проскочит до записи. */
  async state(tx: Db, bookVersionId: string, lock = false): Promise<BlockState> {
    if (lock) {
      await tx.$queryRaw`SELECT "id" FROM "BookVersion" WHERE "id" = ${bookVersionId} FOR NO KEY UPDATE`;
    }
    const [version, row] = await Promise.all([
      tx.bookVersion.findUnique({ where: { id: bookVersionId }, select: { status: true } }),
      tx.bookAnalysis.findUnique({ where: { bookVersionId }, select: BOOK_ANALYSIS_SELECT }),
    ]);
    return {
      published: version?.status === 'published',
      stored: row ? readStoredAnalysis(row) : EMPTY_BOOK_ANALYSIS,
    };
  }

  /** Право хода на блоки и отпечатки блоков на старте (`tech.md` §5); `tx` - под замком анализа. */
  async ownership(
    tx: Db,
    bookVersionId: string,
  ): Promise<Pick<AnalysisWriteData, 'owns' | 'written'>> {
    const state = await this.state(tx, bookVersionId);
    const owns: AnalysisWriteData['owns'] = {};
    const written: AnalysisWriteData['written'] = {};
    for (const target of ANALYSIS_TARGETS) {
      const value = targetValue(state.stored, target);
      // Пусто - как у импорта (`mergeAnalysis` пишет через `compactBlock`): нет блока после сжатия.
      owns[target] = !state.published && compactBlock(value) === null;
      written[target] = blockPrint(value);
    }
    return { owns, written };
  }

  /** Данные хода без замка - только для чтения перед решением под замком. */
  async read(row: Pick<ContentDraft, 'id'>, gate: AnalysisGate): Promise<AnalysisWriteData | null> {
    const found = await this.prisma.contentDraft.findUnique({ where: { id: row.id } });
    if (!found || found.kind !== 'analysis_write') return null;
    const data = readAnalysisData(found.data);
    return gate.allows(found, data) ? data : null;
  }

  /**
   * Правка данных хода под замком анализа и строки; `fn` получает `tx` этой транзакции - чтение
   * анализа под тем же замком; `fn` вернул `null` - не писать (`written: false`); не прошёл
   * `gate` - `null`.
   */
  async mutate(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: AnalysisGate,
    fn: (
      data: AnalysisWriteData,
      tx: Db,
    ) => AnalysisWriteData | null | Promise<AnalysisWriteData | null>,
  ): Promise<MutateResult | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockBookAnalysis(tx, row.bookVersionId);
        const current = await this.locked(tx, row.id, gate);
        if (!current) return null;
        const next = await fn(current, tx);
        if (!next) return { data: current, written: false };
        await this.save(tx, row.id, gate, next);
        return { data: next, written: true };
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (error) {
      if (error instanceof AnalysisRunGone) return null;
      throw error;
    }
  }

  /**
   * `CORE_MISSING` после шага 3 (К5): по анализу, прочитанному под замком анализа в той же
   * транзакции, что запись флага (Б3, `L-019`), - флаг шага 3, и для упавшего шага 3 тоже; прежний
   * флаг снимается. Идемпотентно: повтор после обрыва ставит тот же флаг. `null` - ход больше
   * не принимает запись.
   */
  async markCore(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: AnalysisGate,
  ): Promise<true | null> {
    const saved = await this.mutate(row, gate, async (data, tx) => {
      const remark = coreRemark((await this.state(tx, row.bookVersionId)).stored);
      return {
        ...data,
        steps: data.steps.map((s) => {
          if (s.step !== CORE_STEP) return s;
          const remarks = [...s.remarks.filter((r) => r.code !== 'CORE_MISSING')];
          if (remark) remarks.push(remark);
          const verdict = s.outcome === 'failed' ? 'failed' : remark ? 'flags' : s.verdict;
          return { ...s, remarks, verdict };
        }),
      };
    });
    return saved ? true : null;
  }

  /**
   * «Accept» предложения хода `ready` (`tech.md` §5): блок пишется тем же телом, что импорт, если
   * его содержимое с момента предложения никто не менял - сверяется хэш блока (подполя `facts`), а
   * не `updatedAt` анализа: ход пишет другие блоки, и это «Accept» не мешает. Не совпало - 409
   * `ANALYSIS_BLOCK_CHANGED` с текущим содержимым. Героям и цитатам вливаются `themeKeys` из связей
   * тем хода (А3). Ссылки не сошлись на слитом объекте - 409 `ANALYSIS_WRITE_REFUSED`.
   */
  async accept(
    row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
    index: number,
    expectedPrint?: string,
  ): Promise<void> {
    const gate = analysisReadyGate;
    // Предложение уже не то, что видел редактор (`T174`, п.2): `hash` - про блок, а не про него.
    const seen = (candidate: AnalysisItem) =>
      expectedPrint === undefined || proposalPrint(candidate) === expectedPrint;
    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      const data = await this.read(row, gate);
      const item = data?.items[index];
      if (!data || !item || item.outcome !== 'proposed' || item.hash === null) throw notProposed();
      if (item.regen) throw regenInProgress();
      if (!seen(item)) throw proposalChanged();
      const state = await this.state(this.prisma, row.bookVersionId);
      if (blockPrint(targetValue(state.stored, item.target)) !== item.hash) {
        throw blockChanged(targetValue(state.stored, item.target));
      }
      // Предел по факту (решение арбитра `F07 | F07-2b`, круг 3, B): источники изменились до замка -
      // тело (`dto.sources`) разошлось, решение пересобирается и снова приходит сюда.
      if (!sourcesOf(item, state.stored).fits) throw sourcesFull();
      const plan = acceptPlan(data, item, state, row.language);
      const dto = plan.dto;
      const again = { retry: false };
      try {
        const written = await this.analyses.saveGuarded(row.bookVersionId, dto, {
          allow: async (tx, before) => {
            const current = await this.locked(tx, row.id, gate);
            const proposal = current?.items[index];
            if (
              !current ||
              !proposal ||
              proposal.outcome !== 'proposed' ||
              proposal.hash !== item.hash
            ) {
              throw notProposed();
            }
            if (proposal.regen) throw regenInProgress();
            if (!seen(proposal)) throw proposalChanged();
            if (blockPrint(targetValue(before, item.target)) !== item.hash) {
              throw blockChanged(targetValue(before, item.target));
            }
            // Тело зависит от прочих блоков (подполя `facts`, темы, право хода на блоки связей):
            // изменились - пересобрать.
            const published = (await this.state(tx, row.bookVersionId, true)).published;
            const replanned = acceptPlan(
              current,
              proposal,
              { stored: before, published },
              row.language,
            );
            if (stableJson(replanned.dto) !== stableJson(dto)) {
              again.retry = true;
              return false;
            }
            return true;
          },
          done: async (tx, saved) => {
            const current = await this.locked(tx, row.id, gate);
            if (!current) throw notProposed();
            await this.save(tx, row.id, gate, applyAccept(current, index, plan, saved));
          },
        });
        if (written) return;
      } catch (error) {
        if (error instanceof AnalysisRunGone) throw notProposed();
        if (error instanceof BadRequestException) {
          const errors = refusalErrors(error);
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: ANALYSIS_WRITE_REFUSED,
            message: `The analysis refused this block: ${errors.join('; ')}`,
            errors,
          });
        }
        throw error;
      }
      if (!again.retry) break;
    }
    // Тело пересобиралось дольше, чем блоки успокаивались: решение редактора не принято вслепую;
    // в ответе - содержимое блока сейчас.
    const fresh = await this.read(row, gate);
    const target = fresh?.items[index]?.target;
    const now = await this.state(this.prisma, row.bookVersionId);
    throw blockChanged(target ? targetValue(now.stored, target) : null);
  }

  /** «Discard» предложения хода `ready`: блок анализа не трогается. */
  async discardItem(row: Pick<ContentDraft, 'id' | 'bookVersionId'>, index: number): Promise<void> {
    const saved = await this.mutate(row, analysisReadyGate, (data) => {
      const item = data.items[index];
      // Идёт перегенерация - её итог вернул бы предложение после «Discard» (как у «Accept»).
      if (item?.regen) throw regenInProgress();
      if (!item || item.outcome !== 'proposed') return null;
      return withItem(data, index, { outcome: 'discarded' });
    });
    // `written: false` - блок уже не предложение (в том числе уже отброшен): повтор - 409, не успех.
    if (!saved?.written) throw notProposed();
  }

  /**
   * Ждущие блоки шага - в анализ или в предложения (`tech.md` §5). Решение собирается по чтению
   * без замка и под замком сверяется заново вместе со значениями: разошлось - пересборка. Отказ
   * проверки ссылок (К4): блоки путей ошибок - предложения с `IMPORT_INVALID`, остальные -
   * повторная запись в тех же `PLAN_ATTEMPTS`; путь вне записи или второй отказ - всё
   * предложениями. Версию удалили - исключение наружу.
   */
  async settleStep(
    row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
    gate: AnalysisGate,
    step: AnalysisStepNumber,
    only?: number,
  ): Promise<SettleOutcome> {
    let refusal: Refusal | null = null;
    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      const data = await this.read(row, gate);
      if (!data) return 'gone';
      const plan = planStep(
        data,
        step,
        await this.state(this.prisma, row.bookVersionId),
        row.language,
        refusal,
        only,
      );
      if (plan.dto === null) {
        const done = await this.settleWithout(row, gate, step, 'plain', refusal, only);
        if (done !== 'replan') return done;
        continue;
      }
      const dto = plan.dto;
      const attemptRefusal = refusal;
      // Держатель, а не `let`: присваивания в замыканиях сужение типа не видит.
      const result: { outcome: SettleOutcome | 'replan'; existing: StoredBookAnalysis } = {
        outcome: 'replan',
        existing: EMPTY_BOOK_ANALYSIS,
      };
      try {
        await this.analyses.saveGuarded(row.bookVersionId, dto, {
          allow: async (tx, before) => {
            result.existing = before;
            const current = await this.locked(tx, row.id, gate);
            if (!current) {
              result.outcome = 'gone';
              return false;
            }
            const published = (await this.state(tx, row.bookVersionId, true)).published;
            const again = planStep(
              current,
              step,
              { stored: before, published },
              row.language,
              attemptRefusal,
              only,
            );
            return samePlan(plan, again);
          },
          done: async (tx, saved) => {
            const current = await this.locked(tx, row.id, gate);
            if (!current) throw new AnalysisRunGone();
            const next = applyPlan(current, plan, result.existing, saved);
            await this.save(tx, row.id, gate, next);
            result.outcome = 'settled';
          },
        });
      } catch (error) {
        if (error instanceof AnalysisRunGone) return 'gone';
        if (!(error instanceof BadRequestException)) throw error;
        const errors = refusalErrors(error);
        const written = new Set(Object.keys(dto).filter((key) => key !== 'language'));
        const blocks = new Set(errors.map(blockOfPath));
        const outside = [...blocks].some((block) => !written.has(block));
        if (refusal !== null || outside) {
          return this.finalWithout(row, gate, step, { blocks: written, errors }, only);
        }
        refusal = { blocks, errors };
        continue;
      }
      if (result.outcome !== 'replan') return result.outcome;
    }
    // Блоки меняют быстрее, чем ход решает: всё ждущее - предложением, без записи.
    return this.finalWithout(row, gate, step, refusal, only);
  }

  private async finalWithout(
    row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
    gate: AnalysisGate,
    step: AnalysisStepNumber,
    refusal: Refusal | null,
    only?: number,
  ): Promise<SettleOutcome> {
    const done = await this.settleWithout(row, gate, step, 'force', refusal, only);
    return done === 'replan' ? 'settled' : done;
  }

  /**
   * Шаг без записи блоков: только предложения, решение собирается под замком из блоков,
   * прочитанных под ним. `plain` - появилась запись - `replan`; `force` - всё предложением (версия
   * как опубликованная), блоки, которые иначе писались бы, - с ошибками отказа `refusal`.
   */
  private async settleWithout(
    row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
    gate: AnalysisGate,
    step: AnalysisStepNumber,
    kind: 'plain' | 'force',
    refusal: Refusal | null,
    only?: number,
  ): Promise<SettleOutcome | 'replan'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockBookAnalysis(tx, row.bookVersionId);
        const current = await this.locked(tx, row.id, gate);
        if (!current) return 'gone';
        const state = await this.state(tx, row.bookVersionId, true);
        const real = planStep(current, step, state, row.language, refusal, only);
        if (kind === 'plain' && real.dto !== null) return 'replan';
        const all =
          kind === 'force'
            ? planStep(current, step, { ...state, published: true }, row.language, refusal, only)
            : real;
        if (kind === 'force' && refusal !== null) {
          for (const index of real.writes) all.refused.set(index, [...refusal.errors]);
        }
        await this.save(tx, row.id, gate, applyPlan(current, all, state.stored, null));
        return 'settled';
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (error) {
      if (error instanceof AnalysisRunGone) return 'gone';
      throw error;
    }
  }

  /** Строка хода под замком `FOR UPDATE` в транзакции `tx`; не прошла `gate` - `null`. */
  private async locked(tx: Db, id: string, gate: AnalysisGate): Promise<AnalysisWriteData | null> {
    await tx.$queryRaw`SELECT "id" FROM "ContentDraft" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.contentDraft.findUnique({ where: { id } });
    if (!row || row.kind !== 'analysis_write') return null;
    const data = readAnalysisData(row.data);
    return gate.allows(row, data) ? data : null;
  }

  /** Данные хода - условием своей операции и `building`: не совпало - откат транзакции. */
  private async save(tx: Db, id: string, gate: AnalysisGate, data: AnalysisWriteData) {
    const { count } = await tx.contentDraft.updateMany({
      where:
        gate.status === 'building'
          ? { id, status: 'building', operationId: gate.operationId ?? undefined }
          : { id, status: 'ready' },
      data: { data: analysisDataJson(data) },
    });
    if (count !== 1) throw new AnalysisRunGone();
  }
}

/**
 * Итог решения в данных хода: записанные - `written` и отпечаток блока, перечитанного из базы
 * после записи (Л2); предложения - отпечаток блока до записи, прочитанного под замком: «Accept»
 * сверит содержимое (`tech.md` §5); отказ проверки ссылок (К4) - замечание `IMPORT_INVALID`
 * с путём каждой ошибки; отрезанные `themeKeys` - в правки шага (`LIMIT_OUT`).
 */
export function applyPlan(
  data: AnalysisWriteData,
  plan: StepPlan,
  before: StoredBookAnalysis,
  saved: StoredBookAnalysis | null,
): AnalysisWriteData {
  const items = [...data.items];
  const written = { ...data.written };
  const patch = (index: number, change: Partial<AnalysisItem>) => {
    items[index] = { ...items[index], ...change };
  };
  for (const index of plan.writes) {
    const target = items[index].target;
    const value = saved ? targetValue(saved, target) : plan.values.get(index);
    written[target] = blockPrint(value);
    patch(index, { outcome: 'written', hash: null, value: plan.values.get(index) ?? null });
  }
  for (const index of plan.proposals) {
    const item = items[index];
    const errors = plan.refused.get(index);
    // Источники блока не влезают в сохранённые: флаг `LIMIT_OUT` на `sources`, «Accept» - 409.
    const full = !!item.pendingSources?.length && !sourcesOf(item, before).fits;
    const remarks = [
      ...item.remarks,
      ...(errors ?? []).map((error) =>
        codeRemark(
          'IMPORT_INVALID',
          error.split(':', 1)[0],
          `The analysis refused this write: ${error}`,
        ),
      ),
      ...(full
        ? [
            codeRemark(
              'LIMIT_OUT',
              'sources',
              `The list of sources is full (at most ${BOOK_ANALYSIS_LIMITS.sources}): free some room or regenerate the block.`,
            ),
          ]
        : []),
    ];
    patch(index, {
      outcome: 'proposed',
      hash: blockPrint(targetValue(before, item.target)),
      value: plan.values.get(index) ?? null,
      remarks,
      verdict: errors || full ? 'flags' : item.verdict,
    });
  }
  for (const index of plan.empty) patch(index, { outcome: 'none', value: null });
  // Отрезанные `themeKeys` - всегда ключи тем: правка шага тем, а не шага блока (`F07-2b`, хвост г).
  const steps = withStepFixes(data.steps, THEMES_STEP, plan.cut);
  if (saved) {
    for (const block of plan.linked) written[block] = blockPrint(targetValue(saved, block));
  }
  // Записанный итог перегенерации - в `merged` и `droppedQuotes` хода записанным значением
  // (`withRegenTaken`); предложения записанной единицы - на записанном блоке (`afterOwnWrite`).
  return plan.writes.reduce(
    (next, index) => {
      const item = next.items[index];
      const target = item.target;
      const value = saved ? targetValue(saved, target) : plan.values.get(index);
      let taken = withRegenTaken(next, index, value);
      if (!saved) return taken;
      taken = afterOwnWrite(taken, target, saved, index);
      // Источники блока шага 5 записаны вместе с ним: `sources` - запись хода (`F07-2b`).
      if (item.pendingSources?.length && sourcesOf(item, before).adds) {
        taken = afterSourcesWrite(taken, saved, index);
      }
      // Записанные новые темы - как после «Accept» темы.
      const links = taken.themeLinks;
      if (target === 'themes' && !item.links && links) {
        taken = afterThemesWrite(taken, links, saved, plan.linked, index);
      }
      return taken;
    },
    { ...data, steps, items, written } as AnalysisWriteData,
  );
}
