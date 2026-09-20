import { Prisma } from '@prisma/client';

/**
 * Лицензионный снимок версии книги — то, на что опиралась её публикация. Снимают версию
 * с публикации **два** пути: админский `unpublish` и блокировка по претензии
 * правообладателя. Оба гасят снимок **одним и тем же набором значений** и оба уносят
 * прежние значения в неудаляемое событие той же транзакции (`LEGACY-180`, решение
 * владельца 12.09.2026: гасить).
 *
 * ⚠️ Тождественными пути при этом не являются, и это осознанно: они по-разному решают,
 * **к какой строке** применяться. Админский `unpublish` берёт и версию, оставшуюся
 * черновиком с непустой датой публикации, — он умеет починить такое состояние.
 * Блокировка по претензии берёт только по-настоящему опубликованную: черновик наружу
 * и так не выдаётся, а событие `VERSION_UNPUBLISHED` на нём утверждало бы снятие,
 * которого не было. Чинит такие строки админский путь, а не блокировка.
 *
 * Список колонок живёт здесь, а не в каждом из путей: разошедшиеся копии означают,
 * что одна ручка гасит четыре поля, а другая пять, и разницу не видит ни один тест.
 * Полноту списка против схемы сторожит `rights-license-snapshot.spec.ts`: новая колонка
 * `rightsLicense*` в `schema.prisma` красит его, пока её не отнесли к гасимым или
 * к сохраняемым явно.
 *
 * ⚠️ Колонки затираются **физически**, `git revert` их не вернёт. Поэтому снимок обязан уйти
 * в неудаляемое событие той же транзакции (ADR-009), и у обоих путей это одно и то же
 * событие — `AdminAuditEvent.VERSION_UNPUBLISHED`. У `AdminAuditEvent` намеренно нет внешних
 * ключей: запись переживает удаление объекта. `RightsClaimEvent` для снимка не годится —
 * он висит на претензии, а та каскадом от `BookVersion` и `Book`, поэтому `DELETE /versions/:id`
 * снёс бы единственную копию затёртого снимка. В историю претензии идёт только строка о том,
 * что версия снята, без снимка.
 */
export type RightsLicenseSnapshot = {
  /**
   * Статус на момент замка. В сам снимок он не входит и в `payload` не уходит: он нужен,
   * чтобы путь снятия перепроверил под замком то, что прочитал до него. Между чтением
   * и замком проходит чужое снятие — и без этой перепроверки событие утверждало бы,
   * что версию сняли, хотя снял её кто-то другой, а снимок уже был пуст.
   */
  status: string;
  publishedAt: Date | null;
  rightsLicenseIds: Prisma.JsonValue | null;
  rightsLicenseCoverageStatus: string | null;
  rightsLicenseCheckedAt: Date | null;
  rightsLicenseUncoveredCountryCodes: Prisma.JsonValue | null;
};

/**
 * Колонки `rightsLicense*`, которые снятие с публикации **не** трогает, и почему.
 *
 * `rightsLicenseAttributionTextRu` публикации не принадлежит: её заполняет создание книги
 * из утверждённого интейка (`rights-book-creation.service.ts`), а `publish` непустое
 * значение **сохраняет**, а не перезаписывает. Погасить её означало бы потерять текст,
 * который публикация не создавала: при повторной публикации он не вернётся — расчёт
 * покрытия отдаёт атрибуцию только там, где лицензия требуется, а на общественном
 * достоянии список пуст.
 *
 * `rightsLicenseRequiredCountryCodes` — вывод клиренса, а не публикации: где лицензия
 * вообще требуется. Его читает резолвер клиренса (`rights-clearance-resolver.service.ts`)
 * и наследует новая языковая версия от соседней (`book-version.service.ts`). Снятие
 * с публикации ничего в этом выводе не меняет, а погашенный он вернул бы гейт публикации
 * к решению «лицензия не нужна нигде».
 */
export const PRESERVED_LICENSE_COLUMNS = [
  'rightsLicenseAttributionTextRu',
  'rightsLicenseRequiredCountryCodes',
] as const;

/**
 * Читает снимок **под замком строки** и внутри транзакции вызывающего.
 *
 * Замок здесь не перестраховка: между обычным чтением и записью проходит чужой `publish`
 * и перезаписывает те же колонки. Событие тогда назвало бы лицензии, на которых публикация
 * не стояла, а настоящие были бы уже стёрты — вернуть их неоткуда.
 *
 * ⚠️ Вызывающих три, и снимают с публикации только двое. Третий — `publish`
 * (`LEGACY-015`, 20.09.2026): он читает под этим замком **прежнее** состояние, чтобы решить,
 * менялось ли оно, и встать в ту же очередь к строке, в которой стоят оба пути снятия.
 *
 * ⚠️ `Prisma.TransactionClient` — это `Omit<PrismaClient, ITXClientDenyList>`, и корневой
 * `PrismaService` ему структурно подходит: вызов вне транзакции компилируется, а `FOR UPDATE`
 * в autocommit отпускает строку сразу после чтения, то есть замок пропадает молча. От этого
 * держит не тип, а сторож первого аргумента в `rights-license-snapshot.spec.ts`.
 *
 * Возвращает `null`, если строки нет: версию удалили между чтением вызывающего и замком.
 */
export async function lockLicenseSnapshot(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
): Promise<RightsLicenseSnapshot | null> {
  const rows = await tx.$queryRaw<RightsLicenseSnapshot[]>`
    SELECT "status",
           "publishedAt",
           "rightsLicenseIds",
           "rightsLicenseCoverageStatus",
           "rightsLicenseCheckedAt",
           "rightsLicenseUncoveredCountryCodes"
      FROM "BookVersion"
     WHERE "id" = ${bookVersionId}
       FOR UPDATE
  `;
  return rows.length === 0 ? null : rows[0];
}

/**
 * Значения, которыми снимок гасится. `Prisma.DbNull`, а не `JsonNull`: колонка должна стать
 * тем же SQL NULL, что у никогда не заполнявшихся строк, иначе «не заполняли» и «очистили»
 * разойдутся в фильтрах по Json.
 *
 * Статус сюда не входит: его выставляет сам путь снятия. Дата публикации входит — она часть
 * снимка и гасится вместе с ним, иначе черновик остаётся с датой, которой у него уже нет.
 * Про исключённую атрибуцию — `PRESERVED_LICENSE_COLUMNS` выше.
 */
export const CLEAR_LICENSE_SNAPSHOT = {
  publishedAt: null,
  rightsLicenseIds: Prisma.DbNull,
  rightsLicenseCoverageStatus: null,
  rightsLicenseCheckedAt: null,
  rightsLicenseUncoveredCountryCodes: Prisma.DbNull,
} as const;

/**
 * Снимок в виде, пригодном для `payload` события: даты строками ISO, Json как есть.
 * Ни почты, ни имени — журналы читает кто угодно, включая выгрузку базы.
 *
 * Состав полей один и тот же у обеих сторон истории версии, и это не совпадение,
 * а требование: снятие с публикации кладёт то, что гасит, а публикация (`LEGACY-015`,
 * `VERSION_PUBLISHED`) — то, что записывает тем же оператором. Разойдись эти два состава,
 * и «на чём стояла публикация» против «что при снятии затёрли» пришлось бы читать двумя
 * разными выборками по одному журналу.
 *
 * Сохранённая атрибуция в событие не идёт ни на одной из сторон: она остаётся на самой
 * версии, снятие её не гасит и восстановления она не требует
 * (см. `PRESERVED_LICENSE_COLUMNS`).
 */
export function licenseSnapshotPayload(
  snapshot: Omit<RightsLicenseSnapshot, 'status'>,
): Prisma.InputJsonObject {
  return {
    publishedAt: snapshot.publishedAt ? snapshot.publishedAt.toISOString() : null,
    rightsLicenseIds: (snapshot.rightsLicenseIds ?? null) as Prisma.InputJsonValue,
    rightsLicenseCoverageStatus: snapshot.rightsLicenseCoverageStatus,
    rightsLicenseCheckedAt: snapshot.rightsLicenseCheckedAt
      ? snapshot.rightsLicenseCheckedAt.toISOString()
      : null,
    rightsLicenseUncoveredCountryCodes: (snapshot.rightsLicenseUncoveredCountryCodes ??
      null) as Prisma.InputJsonValue,
  };
}

/**
 * Колонки снимка, которые в сравнении «менялось ли покрытие» **не участвуют**, и почему.
 *
 * `publishedAt` и `rightsLicenseCheckedAt` публикация пишет как `new Date()` на каждый вызов,
 * поэтому сравнение снимка целиком было бы истинным всегда и выродилось бы в «писать событие
 * на каждый запрос» — ровно то, из-за чего повторная публикация кладёт в журнал столько
 * ответов на вопрос «когда опубликовали», сколько раз нажали кнопку.
 *
 * Список объявлен явно, а не выведен из умолчания: новая колонка `rightsLicense*` в схеме
 * красит `rights-license-snapshot.spec.ts`, пока её не отнесли к сравниваемым или сюда.
 */
export const SNAPSHOT_COLUMNS_IGNORED_IN_COMPARISON = [
  'publishedAt',
  'rightsLicenseCheckedAt',
] as const;

/** Json-значение как набор строк: порядок элементов покрытия смыслом не является. */
function normalizeJsonSet(value: Prisma.JsonValue | null): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify([...value].map(String).sort());
  return JSON.stringify(value);
}

/**
 * Менялась ли **содержательная** часть лицензионного снимка версии (`LEGACY-015`,
 * решение арбитра 20.09.2026).
 *
 * Зачем это отдельный вопрос: повторная публикация уже опубликованной версии проходит
 * и перезаписывает снимок физически. Если за это время лицензию отозвали и купили другую,
 * прежние значения исчезают безвозвратно — а `ADR-009` (шапка этого файла) требует, чтобы
 * затираемый снимок уходил в неудаляемое событие той же транзакции. Без этого предиката
 * событие писалось бы только на переходе в опубликованное, и `VERSION_PUBLISHED` называл бы
 * одни лицензии, а `VERSION_UNPUBLISHED` той же версии — другие.
 *
 * Сравниваются три колонки из пяти; две отброшены осознанно
 * (`SNAPSHOT_COLUMNS_IGNORED_IN_COMPARISON`). Массивы сравниваются как множества строк,
 * а `null` и пустой массив различаются: «покрытие не считали» и «посчитали, вышло пусто» —
 * разные состояния.
 */
export function licenseSnapshotChanged(
  before: Omit<RightsLicenseSnapshot, 'status'>,
  after: Omit<RightsLicenseSnapshot, 'status'>,
): boolean {
  return (
    normalizeJsonSet(before.rightsLicenseIds) !== normalizeJsonSet(after.rightsLicenseIds) ||
    before.rightsLicenseCoverageStatus !== after.rightsLicenseCoverageStatus ||
    normalizeJsonSet(before.rightsLicenseUncoveredCountryCodes) !==
      normalizeJsonSet(after.rightsLicenseUncoveredCountryCodes)
  );
}
