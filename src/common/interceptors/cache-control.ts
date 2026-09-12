/**
 * Значения `Cache-Control`, общие для всех, кто их ставит.
 *
 * ⚠️ Константы, а не литералы по месту. Приватную строку ставят четыре места:
 * `DefaultCacheControlMiddleware` (умолчание), `PublicCacheInterceptor`
 * (персональная ветка), ручная выгрузка в `rights-files.controller.ts`, а
 * `PrivateVaryInterceptor` по ней же решает, кому нужен второй рубеж.
 * Разъехавшись, они не покраснеют: `isPrivate` разбирает заголовок по
 * директиве и примет любую приватную форму.
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
