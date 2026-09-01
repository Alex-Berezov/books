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
 * ⚠️ Идентификаторы из `req.params` внесены наравне с полями тела: без них адрес
 * заявки в контексте становится `[Filtered]`, и событие перестаёт указывать
 * на конкретную запись. Внесены **не все**: `tokenId` в список не входит — его
 * гасит секретная маска словом `token`, и это верно, а не досадно.
 *
 * 🔴 **Круг маршрутов задаёт `ALLOW_LIST_PATH_PATTERN` (`sentry.filter.ts:33`),
 * а не счёт контроллеров.** До 01.09.2026 здесь стояло «шесть контроллеров»,
 * и это было неверно: префикс `admin/rights` накрывает тринадцать, а список
 * собирался по шести — поля остальных семи гасились молча (`LEGACY-338`).
 * Числа отсюда убраны намеренно: они устаревают тише, чем читаются.
 *
 * ⚠️ Полноту состава держат **две** спеки, и каждая проверяет свою сторону.
 * `rights-allow-list.spec.ts` — «список -> код»: строка достижима, нормализована,
 * не является прозой. `rights-allow-list.completeness.spec.ts` — «код -> список»:
 * поле, заведённое в DTO под этими маршрутами, обязано быть либо здесь, либо
 * в снимке намеренно погашенного. Руками сверять не надо и не нужно.
 */
/**
 * Маршруты, у которых контекст события собирается **белым списком**, а не чёрным
 * (`LEGACY-334`).
 *
 * 🔴 Зачем он нужен и почему маски по имени ключа тут не хватает — разобрано
 * один раз, у `PERSONAL_FILTERED_KEY_PATTERN` в `redact.util.ts`. Здесь только
 * то, чего там быть не может: как выбирается маршрут.
 *
 * ⚠️ Шаблон лежит **рядом со списком, а не в фильтре** (переехал 01.09.2026,
 * `LEGACY-336`). Потребителей у него стало двое: `sentry.filter.ts` выбирает
 * список по `req.path`, а `before-send.ts` — по `event.request.url`, и второй
 * не вправе импортировать фильтр: он тянет за собой `@nestjs/*` в функцию,
 * которая обязана оставаться чистой. Общий предок у обоих один — этот файл,
 * и он не знает ни про Nest, ни про запрос.
 *
 * ⚠️ Совпадение по `req.path`, а не по `req.route.path`. Первое есть всегда,
 * второе заполняется только после того, как обработчик сопоставлен, и несёт путь
 * без префикса контроллера и без глобального `api` — то есть `/claims`, по которому
 * правовую ручку от чужой не отличить.
 *
 * ⚠️ Якорь на префикс контроллера, а не на перечень ручек: новый маршрут внутри
 * `admin/rights` закрывается сам. Список из пятнадцати путей молча пропустил бы
 * шестнадцатый — это и есть тот тихий возврат к чёрному списку, из-за которого
 * решение сначала было принято против белого списка.
 *
 * 🔴 Флаг `i` обязателен. Маршрутизация Express регистронезависима по умолчанию
 * (`case sensitive routing` выключена, в `main.ts` её никто не включает):
 * `POST /api/Admin/rights/claims` доходит до обработчика и выполняется. Шаблон
 * без `i` по такому пути не срабатывал, белый список не включался, и проза
 * встречного уведомления уезжала дословно — чёрный список её не берёт по
 * определению. Найдено ревью 30.08.2026, проверено запуском.
 */
export const ALLOW_LIST_PATH_PATTERN = /(^|\/)admin\/rights(\/|$)/i;

export const RIGHTS_ALLOW_LIST: RedactAllowList = new Set([
  // Идентификаторы записей и связей. Имена из `@Param` внесены наравне
  // с полями тела: круг маршрутов задаёт `ALLOW_LIST_PATH_PATTERN` выше.
  'id',
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
  'lang',
  'assigned_lawyer_id',
  'lawyer_id',
  'user_id',
  'author_id',
  'primary_category_id',
  'rights_claim_id',
  'rights_review_id',
  'rights_evidence_id',
  'completed_review_id',
  'legal_change_event_id',
  'component_territory_assessment_id',
  'territory_decision_id',
  'source_edition_id',
  'source_evidence_ids',
  'source_external_id',
  'document_media_asset_id',
  'affected_component_ids',
  'code',

  // Перечисления и машинные коды
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
  'change_type',
  'decision',
  'kind',
  'lawyer_type',
  'reason',
  'recheck_policy',
  'risk_level',
  'source',
  'trigger',
  'content_type',
  'mime_type',
  'planned_content_types',
  'planned_components',

  // Коды территорий и языков
  'country_code',
  'country_codes',
  'affected_country_codes',
  'affected_languages',
  'excluded_country_codes',
  'covers_country_codes',
  'language_codes',
  'jurisdiction_codes',
  'jurisdiction_code',
  'language_code',
  'original_language',
  'source_language',
  'target_language',
  'target_languages',
  'target_country_codes',
  'approved_country_codes',
  'blocked_country_codes',

  // Даты
  'received_at',
  'received_from',
  'received_to',
  'deadline_at',
  'expires_at',
  'response_sent_at',
  'counter_notice_received_at',
  'due_at',
  'granted_at',
  'effective_from',
  'issued_at',
  'next_review_at',
  'recheck_paused_until',
  'valid_until',
  'until',

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
  'is_active',
  'is_blocking',
  'mine',
  'applies_to_all_countries',
  'auto_materialize',
  'allow_retry_on_validation_error',
  'blocks_approval',
  'unassigned_only',
  'unread_only',
  'current_only',

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
  'due_within_days',
  'expiring_within_days',
  'max_uses',
  'ttl_hours',
  'recheck_interval_days',
]);
