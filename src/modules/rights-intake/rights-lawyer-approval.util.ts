/**
 * WP-M: «юрист высказался положительно, и его заключение в силе».
 *
 * Читается из денормализованного снимка на `RightsProfile`, а не из модуля юриста: ADR-003
 * запрещает `RightsIntakeModule` зависеть от `RightsLawyerModule`, и снимок существует ровно для
 * этого. Функция чистая, поэтому одинаково доступна утверждению интейка и созданию книги — одно
 * условие в одном месте, разойтись они не могут.
 *
 * Три части условия, и все три обязательны:
 * - `lawyerApprovedAt` — заключение вообще есть и оно положительное;
 * - `lawyerReviewBlocking` — у заключения нет невыполненного блокирующего условия («одобряю, если
 *   уберёте иллюстрации» до выполнения не считается одобрением);
 * - `lawyerOpinionValidUntil` — срок не истёк; просроченное заключение перестаёт что-либо снимать
 *   само, без ручного вмешательства.
 */
export const hasEffectiveLawyerApproval = (
  profile: Record<string, unknown>,
  now: number = Date.now(),
): boolean => {
  if (!profile['lawyerApprovedAt']) return false;
  if (profile['lawyerReviewBlocking'] === true) return false;

  const validUntilRaw = profile['lawyerOpinionValidUntil'] as Date | string | null | undefined;
  if (!validUntilRaw) return true;

  return new Date(validUntilRaw).getTime() > now;
};
