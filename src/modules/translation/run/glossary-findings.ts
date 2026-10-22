import { GlossaryDataDto, GlossaryEntryDto, GlossaryHistoryItemDto } from '../dto/dossier-data.dto';
import { GlossaryFinding } from '../translate/translate.format';

/** Глоссарий как он лежит в `BookGlossary.data`: форма та же, что отдаёт ручка глоссария. */
type GlossaryData = Partial<GlossaryDataDto>;

/** Ключ записи из находки: у персонажей досье ключи свои, находка - по написанию. */
export function findingKey(source: string): string {
  return `found:${source.trim().toLowerCase()}`;
}

/**
 * Глоссарий после находок куска (`tech.md` §2, «Порядок и параллельность»). Дописываются
 * только новые написания: запись или оборот с тем же исходным написанием (без учёта регистра)
 * уже есть - находка не переписывает его, глоссарий редакции главнее модели. Повтор того же
 * куска (история уже знает `chunkId`) ничего не меняет.
 */
export function mergeFindings(
  data: unknown,
  history: unknown,
  chunkId: string,
  findings: readonly GlossaryFinding[],
  dossier?: unknown,
): { data: GlossaryData; history: GlossaryHistoryItemDto[]; added: GlossaryEntryDto[] } {
  const glossary = (data ?? {}) as GlossaryData;
  const past = (Array.isArray(history) ? history : []) as GlossaryHistoryItemDto[];
  if (past.some((h) => h.chunkId === chunkId)) return { data: glossary, history: past, added: [] };
  // Имена и варианты персонажей досье - уже записи глоссария (`glossaryFor` находит запись
  // персонажа по ним): находка с вариантом имени дала бы второе, спорное написание героя.
  const characters =
    ((dossier ?? {}) as { characters?: Array<{ name: string; variants?: string[] }> }).characters ??
    [];
  const known = new Set(
    [
      ...[...(glossary.entries ?? []), ...(glossary.phrases ?? [])].map((e) => e.source),
      ...characters.flatMap((c) => [c.name, ...(c.variants ?? [])]),
    ].map((s) => s.trim().toLowerCase()),
  );
  const added: GlossaryEntryDto[] = [];
  for (const f of findings) {
    const source = f.source.trim().toLowerCase();
    if (known.has(source)) continue;
    known.add(source);
    added.push({
      key: findingKey(f.source),
      source: f.source,
      target: f.target,
      kind: f.kind,
      keepOriginal: false,
      note: f.note,
    });
  }
  // Кусок без новых записей в историю не пишется: повтор шага держит статус куска.
  return {
    data: { ...glossary, entries: [...(glossary.entries ?? []), ...added] },
    history: added.length > 0 ? [...past, { chunkId, entries: added }] : past,
    added,
  };
}
