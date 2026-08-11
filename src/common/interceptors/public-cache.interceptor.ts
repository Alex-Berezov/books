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
 * `@NoPublicCache()` и получает `private, no-store` и `Vary: Authorization`.
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

    // Второй рубеж, и он нужен именно потому, что первый однажды снимут.
    // `no-store` и `Vary` отвечают на разные вопросы: первый говорит «не храни»,
    // второй — «если хранишь, различай». Пока метка на месте, `Vary` избыточен;
    // в день, когда её уберут ради скорости или по недосмотру, он остаётся
    // единственным, что мешает общему кэшу выдать прогресс чтения первого
    // зашедшего всем остальным (`LEGACY-088`, `LEGACY-101`).
    //
    // `res.vary()`, а не `setHeader`: `Vary` — единый заголовок, в котором уже
    // лежит `Origin` от CORS, и запись затёрла бы его молча. Express дописывает
    // поле к существующему значению, сверяет без учёта регистра и не трогает
    // `Vary: *`. Своя реализация всего этого здесь была — 15 строк, повторявших
    // пакет `vary`, который и так стоит в зависимостях.
    if (isPersonal) response.vary('Authorization');

    return next.handle();
  }
}
