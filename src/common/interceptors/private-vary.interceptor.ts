import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { Response } from 'express';

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
 * ⚠️ **Рубеж стоит не на всех приватных ответах, а только на успешных.**
 * `map` не выполняется, когда цепочку обрывает исключение, поэтому 401, 403,
 * 429, 451 и 404 уходят с `private, no-store`, но без `Vary`. Сегодня это
 * безопасно — `no-store` держит один; в день, когда его ослабят до
 * `private, max-age=…`, отказы останутся единственными без второго рубежа.
 * Обещать здесь больше, чем делает код, нельзя: расхождение докблока
 * с поведением дороже самого пробела.
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
        // 🔴 Шесть обработчиков заканчивают ответ сами — `@Res()` без
        // `passthrough` и синхронный `res.send()`/`res.end()`:
        // `sitemap.controller.ts` (`robots.txt`, `sitemap.xml`,
        // `sitemap-:lang.xml`) и три выгрузки в `rights-files.controller.ts`.
        // Nest выполняет интерцепторы и при уже отданном ответе — пустым
        // становится только `fnHandleResponse`, — поэтому сюда мы попадаем
        // с `headersSent === true`, а `vary()` внутри зовёт `setHeader` и
        // бросает `ERR_HTTP_HEADERS_SENT`. Клиент при этом уже получил тело,
        // так что дефект невидим по коду ответа: он виден только потоком
        // событий в Sentry с каждого захода краулера на `robots.txt`.
        if (response.headersSent) return value;

        if (isPrivate(response.getHeader('Cache-Control'))) response.vary('Authorization');
        return value;
      }),
    );
  }
}

/**
 * ⚠️ Разбор по директиве, а не сравнение с `PRIVATE_NO_STORE` целиком.
 * Сегодня все приватные заголовки в репозитории — ровно эта строка
 * (`rights-files.controller.ts:237` ставит её же), то есть точное сравнение
 * работало бы. Но оно сломается молча в тот день, когда кто-нибудь напишет
 * `private, max-age=0, must-revalidate`: ответ останется приватным, а второй
 * рубеж перестанет на него вставать, и ни один тест этого не покажет.
 */
const isPrivate = (value: string | number | string[] | undefined): boolean =>
  (Array.isArray(value) ? value.join(',') : String(value ?? ''))
    .split(',')
    .some((directive) => directive.trim().toLowerCase() === 'private');
