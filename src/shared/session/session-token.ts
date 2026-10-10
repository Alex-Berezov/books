import type { SessionState } from './session-state-cache';

/**
 * Поля сессии в обоих токенах — access и refresh (`LEGACY-451`). Подписывает их
 * `AuthService.signTokens`, читают `JwtStrategy` и `AuthService.refresh`/`logout`.
 */
export type SessionTokenClaims = { sub: string; email: string; tv?: number };

/** Отказ погашенной сессии — один текст на стратегию и refresh. */
export const SESSION_REVOKED_MESSAGE = 'Session is no longer valid';

/**
 * Версия сессий, которую несёт токен. У токенов, выданных до `T122`, claim `tv` нет: колонка
 * `User.tokenVersion` заведена с умолчанием 0, и такие токены живут до своего срока, пока
 * версию не поднимут. Снять это допущение — значит снять его здесь, а не в одном из читателей.
 */
export function claimedTokenVersion(claims: Pick<SessionTokenClaims, 'tv'>): number {
  return claims.tv ?? 0;
}

/**
 * Жива ли сессия токена: пользователь есть, не заблокирован, версия токена равна текущей.
 * Единственное место этого правила — его делят `JwtStrategy` (access) и `refresh`.
 */
export function isSessionAlive(
  state: SessionState | null,
  claims: Pick<SessionTokenClaims, 'tv'>,
): boolean {
  return !!state && state.isActive && claimedTokenVersion(claims) === state.tokenVersion;
}

/**
 * `sub` из тела токена **без проверки подписи** — только для ключа корзины лимита выхода
 * (`AuthRateLimitGuard`). Решения о доступе по нему не принимаются: подпись проверяет сервис.
 * Не JWT, битый base64 или `sub` не строкой — пустая строка.
 */
export function unverifiedTokenSubject(token: unknown): string {
  if (typeof token !== 'string') return '';
  const segment = token.split('.')[1];
  if (!segment) return '';
  try {
    const claims: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    const sub = (claims as { sub?: unknown } | null)?.sub;
    return typeof sub === 'string' ? sub.slice(0, 64) : '';
  } catch {
    return '';
  }
}
