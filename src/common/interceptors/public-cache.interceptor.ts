import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import type { Response } from 'express';
import { NO_PUBLIC_CACHE } from '../decorators/no-public-cache.decorator';

/**
 * `Cache-Control: public` разрешает хранить и раздавать ответ **любому** общему
 * кэшу — Cloudflare, CDN, промежуточному прокси, — а ключом служит URL. Поэтому
 * интерцептор вешается на контроллер целиком, и любой персональный ответ внутри
 * него раздаётся чужим людям (`LEGACY-088`).
 *
 * Маршрут, ответ которого зависит от того, кто спрашивает, помечается
 * `@NoPublicCache()` и получает `private, no-store`.
 */
@Injectable()
export class PublicCacheInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    const isPersonal = this.reflector.getAllAndOverride<boolean>(NO_PUBLIC_CACHE, [
      context.getHandler(),
      context.getClass(),
    ]);

    response.setHeader(
      'Cache-Control',
      isPersonal ? 'private, no-store' : 'public, s-maxage=300, stale-while-revalidate=3600',
    );

    return next.handle();
  }
}
