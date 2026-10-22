/**
 * Формат досье v1 и его частей (`F05-2`, шаг 6; `tech.md` §2а). Всё - факты по тексту исходника
 * с номерами глав читалки, без толкований; пишется на языке исходника. Форма ответа модели
 * проверяется кодом: не по форме - повтор с замечанием, затем отказ шага.
 */

export const DOSSIER_FORMAT_VERSION = 1;

// Тип досье и глоссария в коде - DTO ответа (`dto/dossier-data.dto.ts`): данные пишутся только
// после `shapeErrors` по формам ниже, читаются тем же типом. Формы и DTO меняются вместе.

// ---------------------------------------------------------------------------
// Проверка формы: описание поля - тип; ошибки - пути, которые уходят модели в замечании.
// ---------------------------------------------------------------------------

type Shape =
  | 'string'
  | 'int'
  | 'boolean'
  | { enum: readonly string[] }
  | { array: Shape }
  | { object: Record<string, Shape> };

const str = 'string' as const;
const int = 'int' as const;
const bool = 'boolean' as const;
const arr = (item: Shape): Shape => ({ array: item });
const obj = (fields: Record<string, Shape>): Shape => ({ object: fields });

const ADDRESS = obj({ to: str, form: str });
const RELATION = obj({ to: str, label: str });
const ENTITY_KIND = { enum: ['place', 'object', 'organization', 'term'] } as const;

export const DOSSIER_SHAPE = obj({
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
});

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
    characters: Array<{ firstChapter: number }>;
    entities: Array<{ firstChapter: number }>;
    chronology: Array<{ chapter: number }>;
    summaryPlan: Array<{ chapters: number[] }>;
    structure: { parts: Array<{ chapters: number[] }> };
    voice: { devices: Array<{ chapter: number }> };
    motifs: Array<{ chapters: number[] }>;
  };
  const known = new Set(existing);
  const errors: string[] = [];
  const listed = new Set(dossier.chapters.map((c) => c.number));
  const missing = required.filter((n) => !listed.has(n));
  if (missing.length > 0) errors.push(`$.chapters: missing reader chapters ${missing.join(', ')}`);
  const check = (path: string, numbers: number[]) => {
    const wrong = numbers.filter((n) => !known.has(n));
    if (wrong.length > 0) errors.push(`${path}: unknown reader chapters ${wrong.join(', ')}`);
  };
  check(
    '$.chapters',
    dossier.chapters.map((c) => c.number),
  );
  check(
    '$.characters[].firstChapter',
    dossier.characters.map((c) => c.firstChapter),
  );
  check(
    '$.entities[].firstChapter',
    dossier.entities.map((e) => e.firstChapter),
  );
  check(
    '$.chronology[].chapter',
    dossier.chronology.map((c) => c.chapter),
  );
  check(
    '$.summaryPlan[].chapters',
    dossier.summaryPlan.flatMap((s) => s.chapters),
  );
  check(
    '$.structure.parts[].chapters',
    dossier.structure.parts.flatMap((p) => p.chapters),
  );
  check(
    '$.voice.devices[].chapter',
    dossier.voice.devices.map((d) => d.chapter),
  );
  check(
    '$.motifs[].chapters',
    dossier.motifs.flatMap((m) => m.chapters),
  );
  return errors;
}
