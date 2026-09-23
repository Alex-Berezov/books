import { createHash } from 'crypto';

/**
 * Версия алгоритма хеша. Меняется, когда меняется **состав** входа, а не содержимое книги.
 *
 * V2 (WP-7): права издания вошли в хеш записью на каждый язык (`editionRights` стал массивом),
 * а у компонента появился `languageCode`. Хеши, снятые под V1, сравнивать с V2 бессмысленно —
 * это делает `checkVersionStaleness`, переснимая baseline вместо пометки stale.
 *
 * V3 (WP-8): в хеш вошли участники версии и профиля прав (год смерти переводчика определяет
 * public domain) и контрольная сумма файла обложки. Пересъёмка baseline работает так же.
 *
 * V4 (WP-9 / WP-8.3): в хеш вошла контрольная сумма файла исходного издания
 * (`SourceEdition.sourceFileSha256`) — до неё подмена файла источника была невидима, как
 * подмена обложки до V3. Путь к файлу, имя, MIME и размер в хеш **не** входят, равно как и
 * файлы отчёта и архивные копии доказательств: это сопровождение и обоснование, а не
 * содержимое произведения (решение записано в ADR-010).
 *
 * V5 (LEGACY-033): из записи прав издания на язык убрано `legalBasisRu`. Своего правового
 * основания у языковой редакции нет — основание привязано к стране (решение владельца
 * 21.09.2026, подтверждено 23.09.2026); писателя поля в коде нет, значения мог принести только
 * перенос `20260801100000_edition_rights_per_language`.
 */
export const RIGHTS_CONTENT_HASH_ALGORITHM_VERSION = 'RIGHTS_CONTENT_HASH_V5';

/**
 * LEGACY-033: мост V4 → V5. База V4 не переснимается вслепую — иначе правка, записанная до
 * проверки свежести, ушла бы в новую базу без stale. Она сверяется со своим сохранённым входом
 * (`rightsContentHashInput`), см. `storedBaselineHolds`. Снимается, когда на проде не останется
 * баз V4, — от колонки она не зависит, `DROP COLUMN` её не ломает.
 */
export const RIGHTS_CONTENT_HASH_V4 = 'RIGHTS_CONTENT_HASH_V4';

export function stableCanonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(stableCanonicalize);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const val = obj[key];
      if (val !== undefined) {
        result[key] = stableCanonicalize(val);
      }
    }
    return result;
  }

  return value;
}

export function stableStringify(value: unknown): string {
  const canonical = stableCanonicalize(value);
  return JSON.stringify(canonical, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = obj[key];
    }
    return result;
  }
  return value;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * LEGACY-033, ADR-010 п. 4: базы каких версий при смене алгоритма сверяются со своим сохранённым
 * входом. Одно место на сервис свежести и гейт публикации: следующий подъём версии добавляет
 * свою предыдущую версию сюда, а не в каждого потребителя.
 */
export function isReconciledByStoredInput(algorithmVersion: string | null): boolean {
  return algorithmVersion === RIGHTS_CONTENT_HASH_V4;
}

function withoutEditionLegalBasis(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row: unknown) =>
    isRecord(row)
      ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'legalBasisRu'))
      : row,
  );
}

/**
 * LEGACY-033: держится ли база V4 при текущем содержимом. Сохранённый вход обязан давать
 * сохранённый хеш (иначе вход порчен); затем из записей прав на язык снимается `legalBasisRu`,
 * версия алгоритма меняется на текущую, и результат сравнивается с текущим хешем. Любой сбой —
 * `false`, то есть stale: ошибка идёт в закрытую сторону.
 */
export function storedBaselineHolds(
  baselineHash: string | null,
  storedInput: unknown,
  currentHash: string,
): boolean {
  if (!baselineHash || !isRecord(storedInput)) return false;
  if (sha256Hex(stableStringify(storedInput)) !== baselineHash) return false;
  if (storedInput['algorithmVersion'] !== RIGHTS_CONTENT_HASH_V4) return false;

  const projected: Record<string, unknown> = {
    ...storedInput,
    algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
  };
  const profile = storedInput['rightsProfile'];
  if (isRecord(profile) && isRecord(profile['sourceEdition'])) {
    const sourceEdition = profile['sourceEdition'];
    projected['rightsProfile'] = {
      ...profile,
      sourceEdition: {
        ...sourceEdition,
        editionRights: withoutEditionLegalBasis(sourceEdition['editionRights']),
      },
    };
  }
  return sha256Hex(stableStringify(projected)) === currentHash;
}

/**
 * Совпадает ли база версии с текущим хешем. База, сверяемая по сохранённому входу
 * (`isReconciledByStoredInput`), проверяется `storedBaselineHolds`, остальные — прямым
 * сравнением, как до LEGACY-033.
 */
export function baselineMatchesCurrent(
  baseline: { hash: string | null; algorithmVersion: string | null; input: unknown },
  currentHash: string,
): boolean {
  if (isReconciledByStoredInput(baseline.algorithmVersion)) {
    return storedBaselineHolds(baseline.hash, baseline.input, currentHash);
  }
  return baseline.hash === currentHash;
}
