import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, map, throwError, type Observable } from 'rxjs';
import type { Response } from 'express';
import { NO_PUBLIC_CACHE } from '../decorators/no-public-cache.decorator';
import { takeDegradedMark } from './degraded-response';
import { PRIVATE_NO_STORE, PUBLIC_CACHE, PUBLIC_CACHE_DEGRADED } from './cache-control';

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

    response.setHeader('Cache-Control', isPersonal ? PRIVATE_NO_STORE : PUBLIC_CACHE);

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
    // 🔴 `LEGACY-107`. Публичный ответ тоже зависит от заголовка — от
    // `Accept-Language`. `GET /seo/resolve` выбирает язык из него, когда нет
    // `?lang=` (`language.util.ts:55-62`), и отдаёт в чужом языке `title`,
    // `description`, `canonical` и OG-разметку. Маршруты под `/:lang/` от него
    // не свободны: `resolveRequestedLanguage` отбрасывает язык пути, если книга
    // на нём не издана (`available`), и снова уходит к заголовку —
    // `GET /:lang/books/:slug/overview` через `book.service.ts:324-328`.
    //
    // Поле дописывается всей публичной ветке, а не списку маршрутов: список
    // пришлось бы пополнять при каждом новом чтении заголовка, а забывчивость
    // здесь даёт не медленный кэш, а перемешанные языки. Цена — ключ кэша
    // расщепляется по значению заголовка; это сужение кэша, не расширение.
    //
    // `Authorization` публичная ветка по-прежнему не объявляет: от токена она
    // не зависит, и приписка расщепила бы общий кэш надвое без причины
    // (`LEGACY-101`).
    else response.vary('Accept-Language');

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
          response.setHeader('Cache-Control', PUBLIC_CACHE_DEGRADED);
        }
        return value;
      }),
      catchError((error: unknown) => {
        // 🔴 Отказ публичного маршрута публичным кэшем не объявляется.
        // Заголовок ставится в фазе «до», то есть раньше пайпов и обработчика,
        // и на исключении он уезжает вместе с ответом: `GET /sitemap-de.xml`
        // с языком вне перечисления отвечал бы 404 и `public, s-maxage=300`,
        // а общий кэш держал бы этот 404 пять минут плюс час
        // `stale-while-revalidate`. То же с 500 при секундном отказе базы:
        // база поднимется через секунду, а ошибка будет раздаваться час.
        //
        // Снимается именно здесь, а не в фильтре исключений: фильтр — третье
        // место одной политики, а тут решение о публичности уже принято
        // и видно целиком.
        response.setHeader('Cache-Control', PRIVATE_NO_STORE);
        return throwError(() => error);
      }),
    );
  }
}
