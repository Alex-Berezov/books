import type { PrismaService } from '../../prisma/prisma.service';
import { sessionStateCache, type SessionState } from './session-state-cache';

/**
 * Состояние сессии пользователя (`isActive`, `tokenVersion`) через общий кэш на `ttlMs`
 * (`LEGACY-451`, `452`). Одно чтение на двух потребителей: `JwtStrategy` (доступ к маршруту)
 * и `GlobalRateLimitGuard` (обход лимита для модераторов, `LEGACY-453`) — иначе у погашенного
 * токена был бы маршрут, где он ещё действует.
 *
 * Отсутствие пользователя не кэшируется: запись появится только у живой строки.
 */
export async function readSessionState(
  prisma: PrismaService,
  userId: string,
  ttlMs: number,
): Promise<SessionState | null> {
  const now = Date.now();
  const cached = sessionStateCache.get(userId, now);
  if (cached) return cached;

  const readGeneration = sessionStateCache.beginRead();
  const state = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true, tokenVersion: true },
  });
  if (!state) return null;
  sessionStateCache.set(userId, state, now + ttlMs, now, readGeneration);
  return state;
}
