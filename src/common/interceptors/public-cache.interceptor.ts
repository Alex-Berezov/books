import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { Response } from 'express';
import { NO_PUBLIC_CACHE } from '../decorators/no-public-cache.decorator';
import { takeDegradedMark } from './degraded-response';

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

    return next.handle().pipe(
      map((value: unknown) => {
        // 🔴 `LEGACY-305`. Ответ, собранный по неполным данным, и ответ,
        // собранный по полным, — разные ответы, и кэшировать их одинаково
        // нельзя. Признак деградации рождается в сервисе, то есть уже после
        // того, как заголовок поставлен, — поэтому он ставится дважды:
        // штатное значение до обработчика, короткое поверх него здесь.
        // Express отдаёт заголовки после завершения конвейера, так что
        // перезапись успевает.
        //
        // `s-maxage=10`, а не `no-store`: деградация случается ровно в момент
        // отказа базы, и `no-store` снял бы щит общего кэша именно тогда,
        // когда база уже не тянет. Десять секунд обеднённой разметки против
        // нынешних 300 + 3600 секунд `stale-while-revalidate` — и есть
        // содержание записи. Решение арбитра от 29.08.2026.
        //
        // Персональный ответ короткий кэш не получает: `private, no-store`
        // строже, и понижать его нельзя.
        // ⚠️ Метка снимается **всегда**, а не только на публичном маршруте:
        // она служебная и дальше интерцептора жить не должна. Персональный
        // ответ при этом короткий публичный кэш не получает — `private,
        // no-store` строже, и понижать его нельзя.
        const wasDegraded = takeDegradedMark(value);
        if (wasDegraded && !isPersonal) {
          response.setHeader('Cache-Control', 'public, s-maxage=10');
        }
        return value;
      }),
    );
  }
}
