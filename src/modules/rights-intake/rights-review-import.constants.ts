import { LATEST_RIGHTS_REPORT_SCHEMA_VERSION } from './rights-review-schema.registry';

export const RIGHTS_REVIEW_IMPORT_SCHEMA_VERSION = LATEST_RIGHTS_REPORT_SCHEMA_VERSION;

/**
 * WP-G.4: синонимы, которые агент присылает вместо канонического значения `finalStatus`.
 * Нормализация обязана применяться и в валидаторе, и в материализации: иначе валидатор
 * пропустит `PUBLIC_DOMAIN`, а в Prisma-enum `TerritoryRightsStatus` уйдёт значение,
 * которого в нём нет, и импорт упадёт уже после `VALIDATED`.
 */
export const TERRITORY_FINAL_STATUS_SYNONYMS: Readonly<Record<string, string>> = {
  PUBLIC_DOMAIN: 'ALLOWED',
};

export const normalizeTerritoryFinalStatus = (value: string): string =>
  TERRITORY_FINAL_STATUS_SYNONYMS[value] ?? value;

/**
 * WP-G.2: `TerritoryDecision.reasonRu` — `NOT NULL`, а разрешающее решение больше не обязано
 * объяснять, почему разрешено. Дефолт заполняет колонку и одновременно честно сообщает,
 * что собственного обоснования у решения нет.
 */
export const TERRITORY_DECISION_DEFAULT_REASON_RU =
  'Агент не привёл обоснования: доступ разрешён без ограничений.';

/** WP-G.5: язык интейка, который агент не оценивал, материализуется этим статусом. */
export const UNASSESSED_LANGUAGE_STATUS = 'NOT_TARGETED';

/**
 * Что видит редактор в уведомлении и в теле 422, когда материализация отказала
 * (`LEGACY-197`).
 *
 * 🔴 Раньше на обоих местах стоял текст исключения Prisma — с именем модели,
 * именем колонки и текстом ограничения. `messageRu` при этом уходит **в базу**
 * (`RightsNotification.messageRu`), то есть переживает перезапуск и попадает
 * в каждую последующую выдачу уведомлений; `reason` уезжал в тело 422.
 *
 * ⚠️ Фразы постоянные и подробностей не несут намеренно: связь с записью
 * в журнале дают `importId` и `rightsIntakeId`, которые в обоих местах уже есть.
 */
/**
 * ⚠️ Наружу **не** экспортируется, и это не забывчивость. Шаблон несёт
 * неподставленный `%title%`; сравнив с ним `messageRu` уведомления, спека
 * зеленела бы на тексте, в котором вместо названия интейка стоит плейсхолдер.
 * Снаружи есть только `materializationFailedMessageRu`.
 */
const MATERIALIZATION_FAILED_MESSAGE_RU =
  'Отчёт по интейку «%title%» импортирован, но профиль прав по нему не построен из-за внутренней ошибки. Подробности — в журнале сервера.';

export const MATERIALIZATION_FAILED_REASON_RU =
  'Внутренняя ошибка при разборе отчёта. Подробности — в журнале сервера.';

/**
 * Подставляет название интейка в постоянную фразу уведомления.
 *
 * 🔴 Замена **функцией**, а не строкой. `String.replace` со строковым вторым
 * аргументом разбирает в нём `$&`, `` $` ``, `$'` и `$$` как шаблоны подстановки,
 * а `candidateTitle` — свободный текст, который вводит человек
 * (`schema.prisma`, `RightsIntake.candidateTitle`). Проверено запуском:
 * название `A $& B` даёт «A %title% B» — плейсхолдер всплывает обратно в текст;
 * `X $' Y` вклеивает в середину хвост самого шаблона. Испорченная фраза уходит
 * **в базу** (`RightsNotification.messageRu`) и показывается в каждой выдаче.
 * Функция-заменитель этих правил не знает и подставляет строку как есть.
 */
export const materializationFailedMessageRu = (title: string): string =>
  MATERIALIZATION_FAILED_MESSAGE_RU.replace('%title%', () => title);
