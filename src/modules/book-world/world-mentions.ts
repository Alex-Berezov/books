import { continuesWord, foldQuote, paragraphsOf } from '../translation/draft-quality/quote-check';

/**
 * Формы имени и присутствие по главам (`books-app-docs/features/F08-book-wiki/tech.md` §4,
 * `product.md` §9): считает код по тексту глав версии, не модель.
 *
 * Формы — `name` + `aliases` минус `aliasExclusions`, минус формы короче
 * `WORLD_MIN_FORM_LETTERS` букв. В главах из `aliasChapterExclusions` своя форма не ищется
 * (`F08-8a`). Поиск — целым словом (границы слова Unicode), без регистра,
 * `ё` = `е`. Абзац — индекс в `paragraphsOf(htmlToParagraphs(html))`: то же правило абзаца, что
 * у сверки цитат и читалки (`F08-10`).
 */
export const WORLD_MIN_FORM_LETTERS = 3;

const LETTER = /\p{L}/gu;

/**
 * Вид для сравнения форм и текста: вид сверки цитат `foldQuote` (пробелы любого вида — один,
 * NFC, нижний регистр) и `ё` = `е`. Граница слова — общая с цитатами (`continuesWord`).
 */
export function foldMention(text: string): string {
  return foldQuote(text).replace(/ё/g, 'е');
}

/** Форма имени и главы, где она не считается (тёзки, `F08-8a`, решение арбитра `F08 | F08-8a`). */
export interface WorldChapterExclusion {
  form: string;
  chapters: number[];
}

export interface WorldMentionSource {
  key: string;
  name: string | null;
  aliases: readonly string[] | null;
  aliasExclusions: readonly string[] | null;
  /** Исключённые главы у формы; нет поля или `null` — исключений нет. */
  aliasChapterExclusions?: readonly WorldChapterExclusion[] | null;
}

/**
 * Формы, по которым ищется имя: свёрнутый вид → первое написание с таким видом. Одно правило
 * отбора (без исключений, без коротких, без повторов по свёрнутому виду) на подсчёт присутствия
 * и на формы публичного списка (`F08-5`, решение арбитра `F08 | F08-5` Q2).
 */
function formsOf(entity: WorldMentionSource): Map<string, string> {
  const excluded = new Set((entity.aliasExclusions ?? []).map(foldMention));
  const forms = new Map<string, string>();
  for (const raw of [entity.name ?? '', ...(entity.aliases ?? [])]) {
    const form = foldMention(raw);
    if (form === '' || excluded.has(form) || forms.has(form)) continue;
    if ((form.match(LETTER) ?? []).length < WORLD_MIN_FORM_LETTERS) continue;
    forms.set(form, raw.trim());
  }
  return forms;
}

/** Формы для поиска: уникальные, в виде `foldMention`, без исключений и коротких. */
export function mentionForms(entity: WorldMentionSource): string[] {
  return [...formsOf(entity).keys()];
}

/**
 * Те же формы в исходном написании — для перелинковки на сайте (`F08-5`): по свёрнутому виду
 * не найти место в тексте. Исключения наружу не уходят — только то, что прошло отбор.
 */
export function publicMentionForms(entity: WorldMentionSource): string[] {
  return [...formsOf(entity).values()];
}

/**
 * Исключённые главы у формы к записи (решение арбитра `F08 | F08-8a` п.1): повторы формы по
 * `foldMention` слиты в первое написание, главы без повторов по возрастанию; пусто — `null`.
 */
export function normalizeChapterExclusions(
  list: readonly WorldChapterExclusion[] | null,
): WorldChapterExclusion[] | null {
  const byForm = new Map<string, { form: string; chapters: Set<number> }>();
  for (const e of list ?? []) {
    const form = e.form.trim();
    const folded = foldMention(form);
    if (folded === '' || e.chapters.length === 0) continue;
    const entry = byForm.get(folded) ?? { form, chapters: new Set<number>() };
    for (const n of e.chapters) entry.chapters.add(n);
    byForm.set(folded, entry);
  }
  const out = [...byForm.values()].map(({ form, chapters }) => ({
    form,
    chapters: [...chapters].sort((a, b) => a - b),
  }));
  return out.length > 0 ? out : null;
}

/**
 * Действующие исключения глав (решение арбитра `F08 | F08-8a`): то же слияние, что у записи
 * (`normalizeChapterExclusions`), только у форм, по которым идёт поиск (`mentionForms`), форма
 * в виде `foldMention`, записи по форме. Запись о форме, которой нет среди форм, не действует —
 * ни на подсчёт, ни на постановку пересчёта (S7).
 */
export function activeChapterExclusions(entity: WorldMentionSource): WorldChapterExclusion[] {
  const forms = formsOf(entity);
  return (normalizeChapterExclusions(entity.aliasChapterExclusions ?? null) ?? [])
    .map((e) => ({ form: foldMention(e.form), chapters: e.chapters }))
    .filter((e) => forms.has(e.form))
    .sort((a, b) => (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
}

/**
 * Вхождения форм целыми словами в одном абзаце (в виде `foldMention`). Вхождения разных форм
 * в одном месте («Анна» внутри «Анна Каренина») считаются одним — берётся самое раннее, затем
 * самое длинное.
 */
export function countInParagraph(paragraph: string, forms: readonly string[]): number {
  const hits: [number, number][] = [];
  for (const form of forms) {
    for (let at = paragraph.indexOf(form); at >= 0; at = paragraph.indexOf(form, at + 1)) {
      const end = at + form.length;
      if (!continuesWord(paragraph, at - 1) && !continuesWord(paragraph, end)) hits.push([at, end]);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let count = 0;
  let until = -1;
  for (const [start, end] of hits) {
    if (start < until) continue;
    count++;
    until = end;
  }
  return count;
}

/** Посчитанное присутствие одной сущности — колонка `mentions`. */
export interface WorldMentions {
  /** Главы версии, где есть хотя бы одна форма, по возрастанию. */
  chapters: number[];
  /** Первая такая глава; `null` — нигде. */
  first: number | null;
  /** Число вхождений по главам: ключ — номер главы строкой (ключ JSON). */
  perChapter: Record<string, number>;
  /** Абзацы с вхождением по главам (индекс `paragraphsOf`) — для читалки `F08-10`, наружу не отдаётся. */
  paragraphs: Record<string, number[]>;
  /** Главы, где сущность встречается вместе с другой: ключ — ключ другой сущности. */
  coPresence: Record<string, number[]>;
}

/**
 * Подсчёт по версии: главы подаются по одной (`addChapter`) в любом порядке, тексты не держатся —
 * хранится только счёт. `coPresence` считается между сущностями из `coPresenceKeys`.
 */
export class WorldMentionCounter {
  private readonly forms: {
    key: string;
    forms: string[];
    /** Глава → формы, которые в ней не считаются (`activeChapterExclusions`). */
    excluded: Map<number, Set<string>>;
  }[];
  private readonly found = new Map<string, Map<number, { count: number; paragraphs: number[] }>>();

  constructor(
    entities: readonly WorldMentionSource[],
    private readonly coPresenceKeys: ReadonlySet<string> = new Set(),
  ) {
    this.forms = entities.map((e) => {
      const excluded = new Map<number, Set<string>>();
      for (const { form, chapters } of activeChapterExclusions(e)) {
        for (const n of chapters) excluded.set(n, (excluded.get(n) ?? new Set()).add(form));
      }
      return { key: e.key, forms: mentionForms(e), excluded };
    });
    for (const e of this.forms) this.found.set(e.key, new Map());
  }

  /** Глава разобранным текстом `htmlToParagraphs` — разбор один на подсчёт и сверку цитат. */
  addChapterText(number: number, text: string): void {
    const paragraphs = paragraphsOf(text).map(foldMention);
    for (const entity of this.forms) {
      const off = entity.excluded.get(number);
      const forms = off ? entity.forms.filter((f) => !off.has(f)) : entity.forms;
      if (forms.length === 0) continue;
      let count = 0;
      const at: number[] = [];
      paragraphs.forEach((p, i) => {
        const n = countInParagraph(p, forms);
        if (n > 0) {
          count += n;
          at.push(i);
        }
      });
      if (count > 0) this.found.get(entity.key)!.set(number, { count, paragraphs: at });
    }
  }

  result(): Map<string, WorldMentions> {
    const chaptersOf = new Map<string, number[]>();
    for (const [key, byChapter] of this.found) {
      chaptersOf.set(
        key,
        [...byChapter.keys()].sort((a, b) => a - b),
      );
    }
    const out = new Map<string, WorldMentions>();
    for (const [key, byChapter] of this.found) {
      const chapters = chaptersOf.get(key)!;
      const perChapter: Record<string, number> = {};
      const paragraphs: Record<string, number[]> = {};
      for (const n of chapters) {
        const hit = byChapter.get(n)!;
        perChapter[String(n)] = hit.count;
        paragraphs[String(n)] = hit.paragraphs;
      }
      const coPresence: Record<string, number[]> = {};
      if (this.coPresenceKeys.has(key)) {
        const mine = new Set(chapters);
        for (const other of this.coPresenceKeys) {
          if (other === key) continue;
          const both = (chaptersOf.get(other) ?? []).filter((n) => mine.has(n));
          if (both.length > 0) coPresence[other] = both;
        }
      }
      out.set(key, { chapters, first: chapters[0] ?? null, perChapter, paragraphs, coPresence });
    }
    return out;
  }
}
