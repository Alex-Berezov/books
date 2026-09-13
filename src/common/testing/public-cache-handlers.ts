/**
 * Обработчики, которым публичный кэш разрешён — обоими способами сразу:
 * под `PublicCacheInterceptor` без `@NoPublicCache()` либо с ручным
 * `@Header('Cache-Control', 'public, …')`. Формат — `<файл> → <метод>`.
 *
 * 🔴 Список зафиксирован **явно**, а не выведен из наличия интерцептора.
 * Выведенный список рос бы вместе с ним: навесил `PublicCacheInterceptor`
 * на новый контроллер — обработчики сами попали в «ожидаемое» — сторож
 * зелёный. Образец и причина — `PUBLIC_ROUTES` в
 * `test/closed-routes-unauthorized.e2e-spec.ts` (`LEGACY-234`).
 *
 * ⚠️ Лежит отдельным модулем, а не константой внутри спеки, потому что
 * сторожей на нём теперь два: `cache-headers-wiring.spec.ts` (кому кэш
 * разрешён) и `public-cache-no-language-header.spec.ts` (никто из них
 * не читает `Accept-Language`, `LEGACY-104`). Вторая рукописная копия
 * списка разошлась бы с первой молча, и один из двух сторожей отвечал бы
 * про другой набор маршрутов (`LEGACY-290`).
 */
export const PUBLIC_CACHE_HANDLERS: readonly string[] = [
  'modules/public/public.controller.ts → authorBookCards',
  'modules/public/public.controller.ts → authorBySlug',
  'modules/public/public.controller.ts → authorLetters',
  'modules/public/public.controller.ts → authorsList',
  'modules/public/public.controller.ts → bookCards',
  'modules/public/public.controller.ts → categoriesBySlug',
  'modules/public/public.controller.ts → categoriesList',
  'modules/public/public.controller.ts → categoryBookCards',
  'modules/public/public.controller.ts → findAll',
  'modules/public/public.controller.ts → getPage',
  'modules/public/public.controller.ts → getPageByKey',
  'modules/public/public.controller.ts → overview',
  'modules/public/public.controller.ts → related',
  'modules/public/public.controller.ts → slugRedirect',
  'modules/public/public.controller.ts → tagBookCards',
  'modules/public/public.controller.ts → tagsBySlug',
  'modules/public/public.controller.ts → tagsList',
  // Второй способ: ручной `@Header('Cache-Control', 'public, max-age=3600')`.
  // Обе схемы отчёта агента публичны по смыслу — это статические JSON Schema,
  // одинаковые для всех, — и от заголовков запроса не зависят.
  'modules/rights-agent/rights-agent.controller.ts → getLatestSchema',
  'modules/rights-agent/rights-agent.controller.ts → getSchemaByVersion',
  'modules/seo/seo.controller.ts → resolve',
  'modules/seo/seo.controller.ts → resolveWithLang',
];
