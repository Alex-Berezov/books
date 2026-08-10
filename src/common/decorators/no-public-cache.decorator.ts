import { SetMetadata } from '@nestjs/common';

export const NO_PUBLIC_CACHE = 'noPublicCache';

/**
 * Метка маршрута, ответ которого зависит от того, кто спрашивает.
 *
 * ⚠️ Обязательна везде, где публичный контроллер отдаёт персональную часть:
 * без неё `PublicCacheInterceptor` объявит ответ `public` и общий кэш начнёт
 * раздавать его посторонним. Особенно после того, как персонализация
 * переезжает из query-параметра в токен: URL становится общим для всех, и
 * кэш перестаёт случайно разделять пользователей.
 */
export const NoPublicCache = () => SetMetadata(NO_PUBLIC_CACHE, true);
