/**
 * Формат досье v1 и его частей (`F05-2`, шаг 6; `tech.md` §2а). Всё - факты по тексту исходника
 * с номерами глав читалки, без толкований; пишется на языке исходника. Форма ответа модели
 * проверяется кодом: не по форме - повтор с замечанием, затем отказ шага.
 */

import { DossierChapterDto, DossierSummarySectionDto } from '../dto/dossier-data.dto';

export const DOSSIER_FORMAT_VERSION = 1;

// Тип досье и глоссария в коде - DTO ответа (`dto/dossier-data.dto.ts`): данные пишутся только
// после `shapeErrors` по формам ниже, читаются тем же типом. Формы и DTO меняются вместе.

// ---------------------------------------------------------------------------
// Проверка формы: описание поля - тип; ошибки - пути, которые уходят модели в замечании.
// ---------------------------------------------------------------------------

export type Shape =
  | 'string'
  | 'int'
  | 'boolean'
  | { enum: readonly string[] }
  | { array: Shape }
  | { object: Record<string, Shape> }
  /**
   * Схема уходит модели как есть (`response_format` строгий: поле обязательно), а код ответ по
   * ней не проверяет: часть, которую вызывающий не хранит, не стоит платных повторов.
   */
  | { unchecked: Shape };

const str = 'string' as const;
const int = 'int' as const;
const bool = 'boolean' as const;
const arr = (item: Shape): Shape => ({ array: item });
const obj = (fields: Record<string, Shape>): Shape => ({ object: fields });

const ADDRESS = obj({ to: str, form: str });
const RELATION = obj({ to: str, label: str });
const ENTITY_KIND = { enum: ['place', 'object', 'organization', 'term'] } as const;

const DOSSIER_FIELDS: Record<string, Shape> = {
  characters: arr(
    obj({
      key: str,
      name: str,
      variants: arr(str),
      gender: str,
      whoIs: str,
      address: arr(ADDRESS),
      relations: arr(RELATION),
      firstChapter: int,
      fate: str,
      role: { enum: ['main', 'secondary', 'episodic'] },
    }),
  ),
  entities: arr(obj({ key: str, name: str, kind: ENTITY_KIND, whatIs: str, firstChapter: int })),
  narration: obj({ person: str, form: str, notes: str }),
  setting: obj({ place: str, time: str }),
  structure: obj({ parts: arr(obj({ title: str, chapters: arr(int) })), notes: str }),
  chronology: arr(obj({ event: str, chapter: int, orderNote: str })),
  chapters: arr(obj({ number: int, title: str, summary: str })),
  summaryPlan: arr(obj({ number: int, title: str, chapters: arr(int), why: str })),
  voice: obj({
    pace: str,
    sentenceLength: str,
    lexicon: str,
    irony: str,
    devices: arr(obj({ name: str, howShown: str, example: str, chapter: int })),
  }),
  motifs: arr(obj({ image: str, chapters: arr(int) })),
};

export const DOSSIER_SHAPE = obj(DOSSIER_FIELDS);

/**
 * Поля досье, которые пишет только группа уровня 0 (или единственная сводка): выше уровня 0 и в
 * итоге их склеивает код (`assembleDossier`), иначе ответ рос бы с числом глав книги и обрезался
 * в `maxTokens` после оплаты всех групп (решение арбитра `F05 | F05-12`).
 */
const CODE_ASSEMBLED_FIELDS = ['chapters', 'summaryPlan'] as const;

/** Ответ сводки выше уровня 0 и итога по группам: досье без `CODE_ASSEMBLED_FIELDS`. */
export const DOSSIER_MERGE_SHAPE = obj(
  withoutAssembledFields(DOSSIER_FIELDS) as Record<string, Shape>,
);

export const DOSSIER_PART_SHAPE = obj({
  summary: str,
  characters: arr(
    obj({
      name: str,
      variants: arr(str),
      gender: str,
      whoIs: str,
      address: arr(ADDRESS),
      relations: arr(RELATION),
    }),
  ),
  entities: arr(obj({ name: str, kind: ENTITY_KIND, whatIs: str })),
  events: arr(obj({ event: str, orderNote: str })),
  voice: obj({ notes: str, devices: arr(obj({ name: str, howShown: str, example: str })) }),
  motifs: arr(str),
});

export const GLOSSARY_SHAPE = obj({
  entries: arr(
    obj({ key: str, source: str, target: str, kind: str, keepOriginal: bool, note: str }),
  ),
  address: arr(obj({ from: str, to: str, form: str })),
  phrases: arr(obj({ source: str, target: str })),
});

/** Ошибки формы значения: пустой список - значение по форме. Лишние поля не ошибка. */
export function shapeErrors(value: unknown, shape: Shape, path = '$'): string[] {
  if (shape === 'string') return typeof value === 'string' ? [] : [`${path}: expected string`];
  if (shape === 'int') {
    return Number.isInteger(value) && (value as number) >= 0
      ? []
      : [`${path}: expected non-negative integer`];
  }
  if (shape === 'boolean') return typeof value === 'boolean' ? [] : [`${path}: expected boolean`];
  if ('unchecked' in shape) return [];
  if ('enum' in shape) {
    return typeof value === 'string' && shape.enum.includes(value)
      ? []
      : [`${path}: expected one of ${shape.enum.join(', ')}`];
  }
  if ('array' in shape) {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    return value.flatMap((item, i) => shapeErrors(item, shape.array, `${path}[${i}]`));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${path}: expected object`];
  }
  const record = value as Record<string, unknown>;
  return Object.entries(shape.object).flatMap(([key, field]) =>
    shapeErrors(record[key], field, `${path}.${key}`),
  );
}

/** JSON Schema формы для `response_format`: модель, которая её принимает, отвечает по ней. */
export function jsonSchemaOf(shape: Shape): Record<string, unknown> {
  if (shape === 'string') return { type: 'string' };
  if (shape === 'int') return { type: 'integer', minimum: 0 };
  if (shape === 'boolean') return { type: 'boolean' };
  if ('unchecked' in shape) return jsonSchemaOf(shape.unchecked);
  if ('enum' in shape) return { type: 'string', enum: [...shape.enum] };
  if ('array' in shape) return { type: 'array', items: jsonSchemaOf(shape.array) };
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(shape.object).map(([key, field]) => [key, jsonSchemaOf(field)]),
    ),
    required: Object.keys(shape.object),
    additionalProperties: false,
  };
}

/**
 * Сводка досье против плана: в `chapters` - все главы исходника с текстом (`required`), номера
 * глав во всех частях - только существующие главы (`existing`) (D1: краткое содержание каждой главы, `product.md` §7
 * п.13: верные номера глав читалки). Ошибки уходят модели тем же замечанием, что и форма.
 */
export function dossierChapterErrors(
  value: unknown,
  required: readonly number[],
  existing: readonly number[],
): string[] {
  const dossier = value as {
    chapters: Array<{ number: number }>;
    summaryPlan: Array<{ chapters: number[] }>;
  };
  const known = new Set(existing);
  const errors: string[] = [];
  const listed = new Set(dossier.chapters.map((c) => c.number));
  const missing = required.filter((n) => !listed.has(n));
  if (missing.length > 0) errors.push(`$.chapters: missing reader chapters ${missing.join(', ')}`);
  errors.push(
    ...unknownChapters(
      '$.chapters',
      dossier.chapters.map((c) => c.number),
      known,
    ),
    ...dossierMergeErrors(value, existing),
    ...unknownChapters(
      '$.summaryPlan[].chapters',
      dossier.summaryPlan.flatMap((s) => s.chapters),
      known,
    ),
  );
  return errors;
}

/**
 * Номера глав сводки без `CODE_ASSEMBLED_FIELDS` (выше уровня 0 и итог по группам, `F05-12`):
 * только существующие главы.
 */
export function dossierMergeErrors(value: unknown, existing: readonly number[]): string[] {
  const dossier = value as {
    characters: Array<{ firstChapter: number }>;
    entities: Array<{ firstChapter: number }>;
    chronology: Array<{ chapter: number }>;
    structure: { parts: Array<{ chapters: number[] }> };
    voice: { devices: Array<{ chapter: number }> };
    motifs: Array<{ chapters: number[] }>;
  };
  const known = new Set(existing);
  return [
    ...unknownChapters(
      '$.characters[].firstChapter',
      dossier.characters.map((c) => c.firstChapter),
      known,
    ),
    ...unknownChapters(
      '$.entities[].firstChapter',
      dossier.entities.map((e) => e.firstChapter),
      known,
    ),
    ...unknownChapters(
      '$.chronology[].chapter',
      dossier.chronology.map((c) => c.chapter),
      known,
    ),
    ...unknownChapters(
      '$.structure.parts[].chapters',
      dossier.structure.parts.flatMap((p) => p.chapters),
      known,
    ),
    ...unknownChapters(
      '$.voice.devices[].chapter',
      dossier.voice.devices.map((d) => d.chapter),
      known,
    ),
    ...unknownChapters(
      '$.motifs[].chapters',
      dossier.motifs.flatMap((m) => m.chapters),
      known,
    ),
  ];
}

function unknownChapters(path: string, numbers: number[], known: ReadonlySet<number>): string[] {
  const wrong = numbers.filter((n) => !known.has(n));
  return wrong.length > 0 ? [`${path}: unknown reader chapters ${wrong.join(', ')}`] : [];
}

/** Значение без `CODE_ASSEMBLED_FIELDS`: так результат группы уходит на уровень выше. */
export function withoutAssembledFields(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !(CODE_ASSEMBLED_FIELDS as readonly string[]).includes(key),
    ),
  );
}

// Записи списков - типы DTO досье: форма и DTO меняются вместе (`dossier.format.spec.ts`).
type ChapterEntry = Pick<DossierChapterDto, 'number' | 'title' | 'summary'>;
type PlanSection = Pick<DossierSummarySectionDto, 'number' | 'title' | 'chapters' | 'why'>;

/** Списки, которые пишет группа уровня 0 и склеивает код (`CODE_ASSEMBLED_FIELDS`). */
export interface GroupLists {
  chapters: ChapterEntry[];
  summaryPlan: PlanSection[];
}

/** Главы плана, которых нет ни в одном списке групп уровня 0: дыра между их диапазонами. */
export function missingChapters(
  groups: readonly GroupLists[],
  planned: readonly number[],
): number[] {
  const listed = new Set(groups.flatMap((g) => g.chapters.map((c) => c.number)));
  return planned.filter((n) => !listed.has(n));
}

/**
 * Досье из ответа итога по группам и ответов групп уровня 0 в порядке книги (`F05-12`):
 * `chapters` - по номеру; глава, чьи куски попали в две группы, - одна запись с первым непустым
 * названием и пересказами по порядку; `summaryPlan` - разделы групп подряд (`joinPlans`), номера
 * заново с 1. Поля - в порядке `DOSSIER_SHAPE`.
 */
export function assembleDossier(
  merged: object,
  groups: readonly GroupLists[],
): Record<string, unknown> {
  const byNumber = new Map<number, ChapterEntry>();
  for (const chapter of groups.flatMap((g) => g.chapters)) {
    const seen = byNumber.get(chapter.number);
    byNumber.set(
      chapter.number,
      seen
        ? {
            number: seen.number,
            title: seen.title || chapter.title,
            summary: [seen.summary, chapter.summary].filter(Boolean).join(' '),
          }
        : { number: chapter.number, title: chapter.title, summary: chapter.summary },
    );
  }
  const assembled: Record<string, unknown> = {
    ...withoutAssembledFields(merged),
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
    summaryPlan: joinPlans(groups.map((g) => g.summaryPlan)),
  };
  return Object.fromEntries(Object.keys(DOSSIER_FIELDS).map((key) => [key, assembled[key]]));
}

/**
 * Планы групп подряд. Глава, чьи куски попали в две группы, есть в разделе на стыке у обеих:
 * первый раздел следующей группы, задевший главы последнего взятого, вливается в него (главы -
 * объединением), иначе заготовка пересказа получила бы эту главу дважды.
 */
function joinPlans(plans: ReadonlyArray<readonly PlanSection[]>): PlanSection[] {
  const joined: PlanSection[] = [];
  for (const plan of plans) {
    plan.forEach((section, i) => {
      const last = joined[joined.length - 1];
      if (i === 0 && last && section.chapters.some((n) => last.chapters.includes(n))) {
        last.chapters = [...new Set([...last.chapters, ...section.chapters])].sort((a, b) => a - b);
        return;
      }
      joined.push({ ...section, chapters: [...section.chapters] });
    });
  }
  return joined.map((section, i) => ({ ...section, number: i + 1 }));
}
