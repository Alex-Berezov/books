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
 *
 * 🔴 Публичная ветка `Vary` не объявляет вовсе (`LEGACY-104`).
 *
 * `Vary: Accept-Language` здесь стоял с 12.09.2026 и снят 13.09.2026 вместе
 * с чтением заголовка на трёх обработчиках, которые его читали
 * (`public.controller.ts → overview`, `seo.controller.ts → resolve`,
 * `resolveWithLang`). Оставить его было нельзя в обе стороны: целевой
 * Cloudflare игнорирует все поля `Vary`, кроме `Accept-Encoding`, без custom
 * cache key (Enterprise, тарифом не покрыт) — то есть поле не защищало; а
 * честный общий кэш (браузер, прокси, не-Cloudflare CDN) расщепил бы по нему
 * ключ на каждую уникальную строку заголовка, различающуюся почти на каждом
 * посетителе, — то есть выключил бы кэш там, где его соблюдают.
 *
 * Требование «тело публичного ответа не зависит от заголовков запроса»
 * держится теперь тестом, а не заголовком:
 * `src/common/testing/public-cache-no-language-header.spec.ts`. ⚠️ Рубеж
 * у́же снятого: `Vary` покрывал всю публичную ветку, сторож смотрит
 * обработчики из `PUBLIC_CACHE_HANDLERS` и только их контроллеры.
 * Решение арбитра 13.09.2026, вариант A.
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

    // Второй рубеж персональной ветки, и он нужен именно потому, что первый
    // однажды снимут. `no-store` и `Vary` отвечают на разные вопросы: первый
    // говорит «не храни», второй — «если хранишь, различай». Пока метка
    // на месте, `Vary` избыточен; в день, когда её уберут ради скорости или
    // по недосмотру, он остаётся единственным, что мешает общему кэшу выдать
    // прогресс чтения первого зашедшего всем остальным (`LEGACY-088`,
    // `LEGACY-101`).
    //
    // `res.vary()`, а не `setHeader`: `Vary` — единый заголовок, в котором уже
    // лежит `Origin` от CORS, и запись затёрла бы его молча. Express дописывает
    // поле к существующему значению, сверяет без учёта регистра и не трогает
    // `Vary: *`. Своя реализация всего этого здесь была — 15 строк, повторявших
    // пакет `vary`, который и так стоит в зависимостях.
    //
    // 🔴 Публичная ветка `Vary` не объявляет вовсе — ни `Authorization`
    // (`LEGACY-101`: от токена она не зависит), ни `Accept-Language`
    // (`LEGACY-104`, подробности в докблоке класса). Поэтому здесь нет `else`:
    // «ничего не дописывать» — это и есть решение, а не пропущенная ветка.
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
          response.setHeader('Cache-Control', PUBLIC_CACHE_DEGRADED);
        }
        return value;
      }),
      catchError((error: unknown) => {
        // 🔴 Отказ публичного маршрута публичным кэшем не объявляется.
        // Заголовок ставится в фазе «до», то есть раньше пайпов и обработчика,
        // и на исключении он уезжает вместе с ответом: `GET /de/books/cards`
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
