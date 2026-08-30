import type { RedactAllowList } from './redact.util';

/**
 * Белый список имён ключей для маршрутов `admin/rights` (`LEGACY-334`).
 *
 * 🔴 Здесь работает обратное правило по сравнению с остальным контекстом события:
 * наружу уходит **только перечисленное**, всё прочее становится `[Filtered]`.
 * Причина — обязательная проза без потолка длины в правовых DTO
 * (`counterNoticeTextRu`, `descriptionRu`, `originalNoticeText`, `responseTextRu`):
 * встречное уведомление DMCA по своей форме и есть контактный блок отправителя,
 * а маской по имени ключа такое поле не закрывается никогда.
 *
 * ⚠️ **Критерий отбора закрытый:** сюда берутся только перечисления,
 * идентификаторы, даты, булевы и числа. Строка свободной формы не берётся
 * ни при каких обстоятельствах — ни `q`, ни `*Text*`, ни `*Description*`,
 * ни `reason`, ни `title`, ни `fileName`. Решение арбитра от 30.08.2026:
 * ошибка отбора здесь стоит утечки, а не диагностики.
 *
 * ⚠️ Имена даны в нормализованном виде (`normalizeKey`): нижний регистр, слова
 * через подчёркивание. `bookVersionId` пишется здесь как `book_version_id`.
 *
 * ⚠️ Список применяется к `body`, `query` и `params` контекста и к строке запроса
 * в адресе — **одним и тем же набором**. Врозь их пускать нельзя: значение,
 * закрытое в теле и открытое в строке запроса, уезжает вторым каналом — это дефект
 * `LEGACY-189`, о котором предупреждает комментарий у `redactByKey`.
 *
 * 🔴 Ключ, который гасится маской раньше белого списка, вносить сюда **нельзя**:
 * до ветки списка он не доходит, строка мертва, а читается она как разрешение.
 * Так уже вышло с `claimant_type` — слово `claimant` стирает его первым; строка
 * снята 30.08.2026 по ревью. Туда же не идут `claimant_is_authorized`
 * и `claimant_person_id`. Проверять это надо прогоном масок по составу списка,
 * а не глазами.
 *
 * ⚠️ По той же причине сюда не вносится то, чего ни одна ручка не принимает:
 * `claim_number` и `person_id` были внесены по ответному DTO и оказались мертвы —
 * в теле, строке запроса и параметрах маршрута их нет вовсе.
 *
 * ⚠️ Идентификаторы из `req.params` перечислены по `@Param` шести контроллеров:
 * без них адрес заявки в контексте становится `[Filtered]`, и событие перестаёт
 * указывать на конкретную запись. Перечислены **не все**: `tokenId` в список
 * не входит — его гасит секретная маска словом `token`, и это верно, а не досадно.
 * Проверку на такие мёртвые строки держит `rights-allow-list.spec.ts`.
 */
export const RIGHTS_ALLOW_LIST: RedactAllowList = new Set([
  // Идентификаторы записей и связей. Имена из `@Param` перечислены полностью:
  // шесть контроллеров под `admin/rights` дают семнадцать разных.
  'id',
  'version',
  'action_id',
  'attachment_id',
  'block_id',
  'claim_component_id',
  'condition_id',
  'evidence_id',
  'import_id',
  'intake_id',
  'link_id',
  'opinion_id',
  'profile_id',
  'review_id',
  'submission_id',
  'task_id',
  'book_id',
  'book_version_id',
  'rights_profile_id',
  'rights_intake_id',
  'rights_component_id',
  'media_asset_id',
  'parent_claim_id',
  'superseded_by_id',
  'assigned_to_user_id',

  // Перечисления
  'claim_type',
  'severity',
  'channel',
  'response_channel',
  'status',
  'final_status',
  'resolution',
  'scope',
  'component_type',
  'attachment_type',
  'link_type',
  'license_type',
  'territory_scope',
  'media_format',
  'media_formats',
  'source_provider',
  'source_text_type',
  'language',
  'type',

  // Коды территорий и языков
  'country_code',
  'country_codes',
  'affected_country_codes',
  'affected_languages',
  'excluded_country_codes',
  'covers_country_codes',
  'language_codes',
  'jurisdiction_codes',
  'lang',

  // Даты
  'received_at',
  'received_from',
  'received_to',
  'deadline_at',
  'expires_at',
  'response_sent_at',
  'counter_notice_received_at',

  // Булевы
  'blocks_publication',
  'requires_lawyer_review',
  'good_faith_statement',
  'sworn_statement',
  'unpublish_version',
  'lift_active_blocks',
  'open_only',
  'overdue_only',
  'attention_only',
  'has_active_block',
  'include_summary',
  'attach_to_existing_book',
  'is_free',
  'is_perpetual',
  'exclusive',
  'revocable',
  'commercial_use_allowed',
  'modification_allowed',
  'translation_allowed',
  'sublicensing_allowed',
  'attribution_required',

  // Числа
  'page',
  'limit',
  'size_bytes',
  'confidence',
  'deadline_within_days',
  'expiring_in_days',
  'first_published_year',
  'edition_published_year',
  'author_birth_year',
  'author_death_year',
]);
