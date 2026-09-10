import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Заголовки ответа, которые браузер отдаёт коду страницы.
 *
 * 🔴 Список один на обе ветки ниже (`origin: '*'` и явные источники) намеренно.
 * Ветка с подстановочным источником работает в разработке, и заголовок, забытый
 * в ней, даёт отказ, который воспроизводится только локально — или наоборот,
 * только в проде.
 *
 * 🔴 `Date` и `Age` здесь не для красоты: браузер отдаёт коду только
 * safelisted-заголовки, а `Date` в этот список не входит. Фронт снимает по ним
 * расхождение часов клиента и сервера (`books-front/lib/http.ts`,
 * `recordClockSkew`) — без него слияние прогресса чтения сравнивает часы
 * браузера с часами базы напрямую, и телефон с неточным временем выигрывает
 * каждое слияние устаревшей записью (`LEGACY-270`). `Age` идёт парой: ответ из
 * кэша Cloudflare несёт `Date` момента первичного ответа, и без `Age` отличить
 * его от свежего нечем.
 */
export const CORS_EXPOSED_HEADERS = [
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'Date',
  'Age',
];

/**
 * Заголовки запроса, которые браузер вправе прислать.
 *
 * 🔴 Список один на обе ветки ниже по той же причине, что и `CORS_EXPOSED_HEADERS`:
 * заголовок, дописанный в одну ветку из двух, даёт отказ, воспроизводимый только локально
 * или только в проде.
 *
 * 🔴 `X-Upload-Token` обязателен, иначе прямая загрузка не работает вовсе: разовый токен
 * читается только заголовком (`modules/uploads/uploads.controller.ts`, `@Headers('x-upload-token')`),
 * а запрос кросс-доменный (фронт на `bibliaris.com`, API на `api.bibliaris.com`) и с
 * `Content-Type: audio/mpeg`, то есть предзапрос неизбежен. Без заголовка в этом списке
 * браузер тело не отправляет и на сервере не остаётся даже строчки лога (`LEGACY-372`).
 */
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Admin-Language',
  'Accept-Language',
  'X-Upload-Token',
  'Accept',
  'Origin',
  'X-Requested-With',
];

/**
 * CORS Configuration for the API
 *
 * Configures Cross-Origin Resource Sharing for interaction with frontend applications.
 *
 * Environment Variables:
 * - CORS_ORIGIN: Allowed origins (comma-separated). Default: '*'
 * - CORS_CREDENTIALS: Allow cookies/credentials (0 or 1). Default: 0
 *
 * @example
 * # Production
 * CORS_ORIGIN=https://bibliaris.com,https://app.bibliaris.com
 * CORS_CREDENTIALS=1
 *
 * # Development
 * CORS_ORIGIN=http://localhost:3000,http://localhost:3001
 * CORS_CREDENTIALS=1
 */
export function getCorsConfig(): CorsOptions {
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
    : ['*'];

  const allowCredentials = process.env.CORS_CREDENTIALS === '1';

  // If wildcard '*' is present, use simple CORS
  if (allowedOrigins.includes('*')) {
    return {
      origin: '*',
      credentials: false, // credentials do not work with a wildcard origin
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
    };
  }

  // For specific origins use a function-based check
  return {
    origin: (origin, callback) => {
      // Allow requests without Origin (e.g., server-to-server or curl)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Verify Origin is whitelisted
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Blocked request from origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: allowCredentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: 86400, // 24 hours - cache preflight requests
  };
}

/**
 * Inspect current CORS configuration.
 *
 * @returns Information about the current CORS configuration.
 */
export function getCorsConfigInfo() {
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  const corsCredentials = process.env.CORS_CREDENTIALS === '1';

  return {
    origins: corsOrigin === '*' ? ['*'] : corsOrigin.split(',').map((s) => s.trim()),
    credentials: corsCredentials,
    warning:
      corsOrigin === '*' && corsCredentials
        ? 'CORS credentials do not work with wildcard origin (*). Use explicit domains.'
        : null,
  };
}
