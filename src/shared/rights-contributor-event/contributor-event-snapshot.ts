/**
 * Снимок связи участника профиля прав на момент события `RightsProfileContributorEvent`
 * (`LEGACY-037`).
 *
 * Связь участника с профилем удаляется **физически** (решение WP-0.4 от 31.07.2026: мягкое
 * удаление потребовало бы фильтрации во всех выборках). Взамен каждая привязка и каждая
 * отвязка пишет неудаляемое событие в той же транзакции, что и сама связь (ADR-009), и часть
 * данных живёт **только** в этом снимке: годы жизни, гражданство и заметку после отвязки
 * взять больше неоткуда.
 *
 * 🔴 **Список полей живёт здесь, а не у писателя и читателя по копии.** Колонка `payload`
 * в схеме объявлена как `Json?`, то есть компилятор между писателем
 * (`modules/contributors/contributors.service.ts`, `recordContributorEvent`) и читателем
 * (`modules/rights-intake/rights-profile.service.ts`, `mapContributorEvent`) не проверяет
 * ничего. Разъехавшиеся копии означают, что писатель кладёт семь полей, а читатель отдаёт
 * шесть: спека писателя проверит запись, спека читателя проверит свои шесть ключей, обе
 * зелёные, а поле не доедет до админки — и заметить это будет некому, потому что строки
 * связи уже нет. Здесь тип один на обоих, и расхождение становится ошибкой компиляции.
 *
 * Полноту списка против `ContributorLinkSnapshot` сторожит
 * `contributor-event-snapshot.spec.ts`.
 */
export interface ContributorEventSnapshot {
  canonicalName: string | null;
  birthYear: number | null;
  deathYear: number | null;
  nationalityCountryCode: string | null;
  notesRu: string | null;
  /** ISO-8601. Момент привязки: у события `UNLINKED` отвечает «сколько связь прожила». */
  linkedAt: string | null;
}

/** Ключи снимка одним списком — для сторожа и для разбора нетипизированной колонки. */
export const CONTRIBUTOR_EVENT_SNAPSHOT_KEYS = [
  'canonicalName',
  'birthYear',
  'deathYear',
  'nationalityCountryCode',
  'notesRu',
  'linkedAt',
] as const satisfies ReadonlyArray<keyof ContributorEventSnapshot>;

/** Поля связи, из которых собирается снимок. Аргумент — строка `RightsProfileContributor`. */
export interface ContributorEventSnapshotSource {
  canonicalName?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
  nationalityCountryCode?: string | null;
  notesRu?: string | null;
  createdAt?: Date | string | null;
}

/** Собирает снимок на запись. Единственное место, где `payload` получает свою форму. */
export function buildContributorEventSnapshot(
  link: ContributorEventSnapshotSource,
): ContributorEventSnapshot {
  return {
    canonicalName: link.canonicalName ?? null,
    birthYear: link.birthYear ?? null,
    deathYear: link.deathYear ?? null,
    nationalityCountryCode: link.nationalityCountryCode ?? null,
    notesRu: link.notesRu ?? null,
    linkedAt: link.createdAt instanceof Date ? link.createdAt.toISOString() : null,
  };
}

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const asNullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Разбирает снимок на чтение.
 *
 * Колонка `payload` нетипизирована, и её содержимое наружу как есть не отдаётся: чужая или
 * битая строка в ней не должна доехать до ответа API. Поля читаются по одному и приводятся
 * к своему типу, посторонние ключи отбрасываются, не-объект даёт `null`.
 */
export function parseContributorEventSnapshot(payload: unknown): ContributorEventSnapshot | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;

  return {
    canonicalName: asNullableString(raw.canonicalName),
    birthYear: asNullableNumber(raw.birthYear),
    deathYear: asNullableNumber(raw.deathYear),
    nationalityCountryCode: asNullableString(raw.nationalityCountryCode),
    notesRu: asNullableString(raw.notesRu),
    linkedAt: asNullableString(raw.linkedAt),
  };
}
