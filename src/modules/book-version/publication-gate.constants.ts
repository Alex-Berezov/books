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
