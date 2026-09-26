import type { Response } from 'express';

/**
 * Значения `Cache-Control`, общие для всех, кто их ставит, и второй рубеж
 * приватного ответа (`Vary: Authorization`).
 *
 * ⚠️ Константы, а не литералы по месту. Приватную строку ставят пять мест:
 * `DefaultCacheControlMiddleware` (умолчание), `PublicCacheInterceptor`
 * (персональная ветка и ветка ошибки), ручная выгрузка в
 * `rights-files.controller.ts`, `docsCacheHeadersMiddleware` (`/docs*`).
 * Второй рубеж ставит `varyAuthorizationIfPrivate` — его зовут
 * `PrivateVaryInterceptor` (успех) и `SentryExceptionFilter` (отказ);
 * `send()` выгрузки ставит `Vary` сам, потому что заголовок у неё свой.
 * Разъехавшись, строки не покраснеют: `isPrivateCacheControl` разбирает
 * заголовок по директиве и примет любую приватную форму.
 */

/** Умолчание и персональная ветка: не хранить вовсе. */
export const PRIVATE_NO_STORE = 'private, no-store';

/** Публичная ветка: пять минут общего кэша и час на фоновое обновление. */
export const PUBLIC_CACHE = 'public, s-maxage=300, stale-while-revalidate=3600';

/**
 * Короткий публичный кэш для ответа, собранного по неполным данным
 * (`LEGACY-305`). Без `stale-while-revalidate`: десять секунд обеднённой
 * разметки — и есть содержание записи.
 */
export const PUBLIC_CACHE_DEGRADED = 'public, s-maxage=10';

/**
 * `LEGACY-108`. Разбор по директиве, а не сравнение строки целиком. Сегодня все
 * приватные заголовки в репозитории — ровно `PRIVATE_NO_STORE`, но точное
 * сравнение сломается молча в день, когда кто-нибудь напишет
 * `private, max-age=0, must-revalidate`: ответ останется приватным, а второй
 * рубеж перестанет на него вставать.
 */
export const isPrivateCacheControl = (value: string | number | string[] | undefined): boolean =>
  (Array.isArray(value) ? value.join(',') : String(value ?? ''))
    .split(',')
    .some((directive) => directive.trim().toLowerCase() === 'private');

/**
 * `LEGACY-101`, `LEGACY-108`. Второй рубеж: приватному ответу — `Vary: Authorization`.
 * Одно место на успех (`PrivateVaryInterceptor`) и отказ (`SentryExceptionFilter`):
 * новое поле `Vary` или новое условие, положенное только в одну из фаз, разъехалось
 * бы молча.
 *
 * `headersSent` бережёт от `ERR_HTTP_HEADERS_SENT`: `@Res()`-выгрузки
 * `rights-files.controller.ts` заканчивают ответ сами, а Nest всё равно
 * выполняет после них интерцепторы.
 *
 * `res.vary()`, а не `setHeader`: в `Vary` уже лежит `Origin` от CORS.
 */
export const varyAuthorizationIfPrivate = (
  response: Pick<Response, 'headersSent' | 'getHeader' | 'vary'>,
): void => {
  if (response.headersSent) return;
  if (isPrivateCacheControl(response.getHeader('Cache-Control'))) {
    response.vary('Authorization');
  }
};
