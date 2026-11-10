import { Language } from '@prisma/client';
import { nameEntriesOf, NameEntry } from '../check/mechanical-check';

/** Досье и глоссарий хода пересказа и анализа - общее для обоих (`T178`). */

/** Досье и глоссарий хода строками для промптов и записи глоссария для `NAME_MISMATCH`. */
export interface PartContext {
  language: Language;
  dossier: unknown;
  glossary: unknown;
}

interface DossierLike {
  characters?: Array<{ name?: unknown; variants?: unknown; whoIs?: unknown; fate?: unknown }>;
  chronology?: unknown;
  setting?: unknown;
  chapters?: Array<{ number?: unknown; title?: unknown; summary?: unknown }>;
}

export const dossierOf = (data: unknown): DossierLike => (data ?? {}) as DossierLike;

/** Записи глоссария языка версии; на языке досье глоссария нет - пусто (В6 `F05-10`). */
export function glossaryNames(glossary: unknown): NameEntry[] {
  const entries = (glossary as { entries?: unknown } | null)?.entries;
  return Array.isArray(entries) ? nameEntriesOf(entries) : [];
}

/** Глоссарий в промпт: «форма оригинала → форма версии»; без глоссария - имена героев досье. */
export function glossaryText(context: PartContext): string {
  const names = glossaryNames(context.glossary);
  if (names.length > 0) return names.map((n) => `${n.source} → ${n.target}`).join('\n');
  const characters = dossierOf(context.dossier).characters ?? [];
  const lines = characters.flatMap((c) =>
    typeof c.name === 'string'
      ? [
          [c.name, ...(Array.isArray(c.variants) ? (c.variants as unknown[]) : [])]
            .filter((v): v is string => typeof v === 'string')
            .join(', '),
        ]
      : [],
  );
  return lines.length > 0 ? lines.join('\n') : 'none';
}
