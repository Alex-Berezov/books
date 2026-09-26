import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { Response } from 'express';
import { varyAuthorizationIfPrivate } from './cache-control';

/**
 * `LEGACY-101`, `LEGACY-108`. Второй рубеж приватного ответа: `Vary: Authorization`.
 *
 * Имя говорит ровно то, что класс делает: `Cache-Control` он **не ставит**.
 * Умолчание заголовка ставит `DefaultCacheControlMiddleware` — он идёт до
 * гвардов и потому покрывает отказы (401, 403, 429), до которых интерцепторы
 * не доходят вовсе. Держать установку заголовка в двух местах нельзя: это две
 * копии одной политики, расходящиеся молча.
 *
 * `no-store` и `Vary` отвечают на разные вопросы: первый говорит «не храни»,
 * второй — «если хранишь, различай». Второй нужен именно потому, что первый
 * однажды снимут.
 *
 * ⚠️ **Здесь рубеж стоит только на успешных ответах.** `map` не выполняется,
 * когда цепочку обрывает исключение, поэтому отказы (401, 403, 429, 451, 404)
 * получают `Vary` в глобальном фильтре исключений (`shared/sentry/sentry.filter.ts`),
 * а `@Res()`-выгрузки — прямо в `send()` `rights-files.controller.ts`. Правило
 * одно — `varyAuthorizationIfPrivate` из `cache-control.ts`.
 *
 * Форма правки — решения арбитра 12.09.2026, варианты F и B (`decisions-log.md`).
 */
@Injectable()
export class PrivateVaryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((value: unknown) => {
        // 🔴 Фаза «после» — не деталь, а условие правильности. Глобальный
        // интерцептор в цепочке Nest идёт **перед** контроллерным, то есть
        // в фазе «до» решение `PublicCacheInterceptor` ещё не принято.
        // Припиши `Authorization` там — и все 23 публичных обработчика
        // получили бы его молча, откатив `LEGACY-101`: «публичные ответы
        // `Authorization` в `Vary` не получают, они от токена не зависят,
        // и объявить обратное значило бы расщепить общий кэш надвое
        // без причины».
        //
        // К моменту `map` контроллерный интерцептор уже отработал, и
        // заголовок отражает итоговое решение о маршруте.
        // 🔴 Три обработчика заканчивают ответ сами — `@Res()` без
        // `passthrough`: выгрузки в `rights-files.controller.ts`. Nest
        // выполняет интерцепторы и при уже отданном ответе, поэтому сюда
        // попадаем с `headersSent === true`; хелпер тогда ничего не трогает,
        // иначе `vary()` бросил бы `ERR_HTTP_HEADERS_SENT`.
        varyAuthorizationIfPrivate(response);
        return value;
      }),
    );
  }
}
