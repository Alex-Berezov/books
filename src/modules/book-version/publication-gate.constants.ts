/**
 * WP-H: стадия гейта. Один и тот же набор проверок отвечает на два разных вопроса.
 *
 * `PUBLICATION` — прежний вопрос «можно ли выпустить версию наружу»; отвечает на него полный
 * список блокеров, и он не ослаблен ни на один код (ADR-008).
 *
 * `PREPARATION` — «можно ли готовить материал внутри админки, пока клиренс не закрыт до конца».
 * Наружу при подготовке ничего не уходит, поэтому здесь запрещают только те причины, при которых
 * работать с произведением нельзя вообще: прямой запрет по результатам проверки, отказ человека
 * или юриста и живая претензия правообладателя.
 */
export const PUBLICATION_GATE_STAGES = ['PUBLICATION', 'PREPARATION'] as const;

export type PublicationGateStage = (typeof PUBLICATION_GATE_STAGES)[number];

export const DEFAULT_PUBLICATION_GATE_STAGE: PublicationGateStage = 'PUBLICATION';

/**
 * Белый список кодов, запрещающих даже подготовку (ADR-016: перечисляем разрешающее правило,
 * а не исключения). Источники кодов: блоки 6.5, 6.8 и 6.11 гейта, блокеры претензий в
 * `rights-claims.service.ts`, `LAWYER_GATE_CODES.LAWYER_REVIEW_REJECTED`.
 *
 * Новый код гейта в этот список **не попадает автоматически** и подготовку не запрещает — это
 * осознанный компромисс: подготовка ничего не публикует, а публикация по-прежнему требует
 * пустого полного списка блокеров. Добавляя код, при котором нельзя даже готовить материал,
 * впиши его сюда явно.
 */
export const PREPARATION_BLOCKING_GATE_CODES: readonly string[] = [
  // Вердикт проверки прав — прямой запрет.
  'PUBLICATION_GATE_BLOCK',
  // Человек отклонил проверку или профиль.
  'RIGHTS_REVIEW_REJECTED',
  'RIGHTS_PROFILE_REJECTED',
  // Юрист отказал.
  'LAWYER_REVIEW_REJECTED',
  // Претензия правообладателя: работать с произведением нельзя до её разбора.
  'ACTIVE_RIGHTS_CLAIM',
  'CRITICAL_RIGHTS_CLAIM_UNRESOLVED',
  'RIGHTS_CLAIM_DEADLINE_OVERDUE',
  'RIGHTS_CLAIM_REQUIRES_LAWYER_REVIEW',
  'RIGHTS_CLAIM_ACCESS_BLOCK_ACTIVE',
];

export const isPreparationBlockingGateCode = (code: string): boolean =>
  PREPARATION_BLOCKING_GATE_CODES.includes(code);

/**
 * WP-M: коды, которые снимает действующее положительное заключение юриста.
 *
 * До этого решение юриста и вердикт агента жили в разных полях и нигде не встречались:
 * `profile.publicationGate` пишется один раз при материализации отчёта и не пересчитывается
 * никогда, поэтому согласованная юристом спорная книга оставалась заблокированной навсегда. Юрист
 * — высшая инстанция по правовым вопросам (ADR-006), и его решение перекрывает осторожность агента.
 *
 * Список — **белый** (ADR-016): новый код гейта сюда не попадает сам и по умолчанию не снимается.
 * Здесь перечислено то, о чём заключение юриста действительно высказывается: вердикт клиренса,
 * незакрытые территории и действия, лицензии, претензии правообладателей, сроки перепроверки.
 *
 * Осознанно **не** входят и заключением не снимаются:
 * - целостность записи (`MISSING_RIGHTS_PROFILE`, `*_NOT_CURRENT`, `*_SUPERSEDED`, `*_ARCHIVED`,
 *   `*_SNAPSHOT_OUTDATED`) — это не правовое мнение, а «открыта не та запись»; без профиля и
 *   заключение прочитать неоткуда;
 * - content hash (`RIGHTS_CONTENT_HASH_*`, `MISSING_RIGHTS_CONTENT_HASH`) — содержимое изменилось
 *   после того, как юрист его смотрел, и одобрение относилось к другому тексту (ADR-010);
 * - geo-block (`GEO_BLOCK_*`) — это **исполнение** решения самого юриста: снять их значит выпустить
 *   книгу в странах, которые он закрыл;
 * - `VERSION_CONTENT_INCOMPLETE` — к правам отношения не имеет;
 * - собственные коды юридического гейта (`LAWYER_*`) — заключение не отменяет само себя, и
 *   невыполненные блокирующие условия остаются блокирующими.
 */
export const LAWYER_OVERRIDABLE_GATE_CODES: readonly string[] = [
  // Вердикт проверки прав и его следствия.
  'PUBLICATION_GATE_BLOCK',
  'RIGHTS_PUBLICATION_BLOCKED',
  'RIGHTS_REVIEW_NOT_APPROVED',
  'RIGHTS_REVIEW_REJECTED',
  'RIGHTS_PROFILE_NOT_APPROVED',
  'RIGHTS_PROFILE_REJECTED',
  'RIGHTS_REVIEW_STALE',
  'RIGHTS_PROFILE_STALE',
  'UNRESOLVED_BLOCKING_RIGHTS_ACTION',
  'PENDING_TERRITORIES',
  'MISSING_LANGUAGE_RIGHTS_ASSESSMENT',
  // Лицензии: их достаточность — предмет юридической оценки.
  'LICENSE_MISSING_FOR_COUNTRY',
  'LICENSE_EXPIRED',
  'LICENSE_REVOKED',
  'LICENSE_NOT_YET_EFFECTIVE',
  'LICENSE_STATUS_NOT_ACTIVE',
  'LICENSE_SCOPE_LANGUAGE_MISMATCH',
  'LICENSE_SCOPE_MEDIA_MISMATCH',
  'LICENSE_TRANSLATION_NOT_ALLOWED',
  'LICENSE_SUBLICENSING_NOT_ALLOWED',
  'LICENSE_TERRITORY_SCOPE_UNKNOWN',
  'LICENSE_ATTRIBUTION_REQUIRED',
  // Претензии правообладателей — ровно то, ради чего юриста и зовут.
  'ACTIVE_RIGHTS_CLAIM',
  'CRITICAL_RIGHTS_CLAIM_UNRESOLVED',
  'RIGHTS_CLAIM_DEADLINE_OVERDUE',
  'RIGHTS_CLAIM_ACCESS_BLOCK_ACTIVE',
  'RIGHTS_CLAIM_PARTIAL_GEO_BLOCK_ACTIVE',
  'RIGHTS_CLAIM_COUNTER_NOTICE_PENDING',
  'RIGHTS_CLAIM_REQUIRES_LAWYER_REVIEW',
  // Сроки перепроверки: заключение свежее задачи на перепроверку.
  'RIGHTS_RECHECK_REQUIRED',
  'RIGHTS_RECHECK_OVERDUE',
  'RIGHTS_RECHECK_TASK_OPEN',
];

export const isLawyerOverridableGateCode = (code: string): boolean =>
  LAWYER_OVERRIDABLE_GATE_CODES.includes(code);

/** Код-маркер: в ответе гейта видно, что блокеры сняты заключением, а не исчезли сами. */
export const LAWYER_OVERRIDE_APPLIED_CODE = 'LAWYER_OVERRIDE_APPLIED';

/**
 * Наполненность версии: одно определение на все места, где спрашивают, есть ли у карточки
 * содержимое. Блок 6.22 гейта решает по нему, выпускать ли версию наружу, а
 * `BookVersionService.update` — не опустошает ли правка уже опубликованную карточку. Двух копий
 * этого правила быть не должно: разъехавшись, они дадут «гейт запрещает публикацию, а правка
 * проходит» (ADR-008 отвергает отдельную точку проверки именно по этой причине).
 */
export const VERSION_CONTENT_FIELDS = ['description', 'coverImageUrl'] as const;

export type VersionContentField = (typeof VERSION_CONTENT_FIELDS)[number];

/**
 * Заполнено — значит в значении есть текст. Описание приходит из визуального редактора и почти
 * всегда обёрнуто в разметку, поэтому `<p></p>` и `<p>&nbsp;</p>` — это пустое описание, хотя
 * строка непустая: читателю такая карточка покажется без описания. Проверка по сырой строке
 * пропускала бы их и в публикацию, и в стирание уже опубликованного описания.
 *
 * Парная проверка на фронте — `isFilled` в
 * `books-front/components/admin/books/BookForm/bookVersionSchema.ts`; правится вместе с этой,
 * иначе форма и сервер разойдутся в ответе на один и тот же ввод.
 */
export const isVersionContentFieldFilled = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;

  return (
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
      .trim() !== ''
  );
};

/**
 * Список незаполненных полей версии в порядке `VERSION_CONTENT_FIELDS`.
 *
 * Оба поля обязательны намеренно: если бы они были необязательными, сужение `select` у гейта
 * (потеря `coverImageUrl` в выборке) компилировалось бы и превращало любую заполненную версию
 * в «не наполнена».
 */
export const collectMissingVersionContentFields = (version: {
  description: string | null;
  coverImageUrl: string | null;
}): VersionContentField[] =>
  VERSION_CONTENT_FIELDS.filter((field) => !isVersionContentFieldFilled(version[field]));
