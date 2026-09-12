import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PRIVATE_NO_STORE } from '../interceptors/cache-control';

/**
 * `LEGACY-108`. Умолчание кэш-заголовка: приватное.
 *
 * До 12.09.2026 `Cache-Control` ставил только `PublicCacheInterceptor`,
 * навешенный на 23 обработчика из 317. Остальные 294 — включая `GET /users/me`,
 * `/users/me/activities`, `/me/bookshelf` — уходили без директив вовсе, а это
 * не нейтральное состояние: по RFC 9111 §4.2.2 общий кэш вправе хранить такой
 * ответ эвристически. Забывчивость давала публичный ответ; теперь — приватный.
 *
 * 🔴 Почему middleware, а не интерцептор. Гвард в Nest отрабатывает **раньше**
 * интерцепторов (`router-execution-context.js`: `fnCanActivate` стоит перед
 * `interceptorsConsumer.intercept`), поэтому 401 `JwtAuthGuard`, 403
 * `RolesGuard` и 429 `GlobalRateLimitGuard` обрывают цепочку до того, как
 * интерцептор успеет что-либо поставить. Живая e2e-проба показала это на
 * `GET /users/me` без токена: `Cache-Control` отсутствовал вовсе.
 * Middleware идёт до гвардов и потому покрывает и эти пути.
 *
 * Заголовок здесь — именно **умолчание**: всё, что идёт позже по цепочке,
 * свободно его перезаписывает. `@Header()` применяется после middleware
 * (`rights-agent.controller.ts` — `public, max-age=3600`), `PublicCacheInterceptor`
 * — ещё позже (`public-cache.interceptor.ts`, безусловный `setHeader`), поэтому
 * поведение 23 публичных обработчиков не меняется.
 *
 * Второй рубеж — `Vary: Authorization` — живёт не здесь, а в фазе «после»
 * `PrivateVaryInterceptor`: решение о публичности маршрута к моменту
 * middleware ещё не принято, и приписка на этом шаге досталась бы и публичным
 * ответам, откатив `LEGACY-101`.
 *
 * Форма правки — решение арбитра 12.09.2026, вариант B (`decisions-log.md`).
 */
@Injectable()
export class DefaultCacheControlMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', PRIVATE_NO_STORE);
    next();
  }
}
