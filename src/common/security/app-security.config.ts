import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import express from 'express';
import { getCorsConfig, getCorsConfigInfo } from '../../config/cors.config';
import { defaultCacheControl } from '../middleware/default-cache-control.middleware';

/**
 * Apply security middleware and body limits consistently across the app.
 * - First: default `Cache-Control: private, no-store` on `/api` — must stay above CORS and body parsers
 * - Helmet with safe defaults (CSP disabled in non-prod to not break Swagger)
 * - CORS configured via getCorsConfig() from cors.config.ts
 * - Body parsers: JSON and URL-encoded with 1mb limits by default
 * - Raw body for local direct uploads (110mb)
 * - Static files for local uploads mapped to /static
 */
export function configureSecurity(app: INestApplication): void {
  // `LEGACY-108` остаток (`T64`). `cors` заканчивает preflight сам (`res.end()`
  // без `next()`), а `express.json()` отвечает 413 на превышенном лимите — оба
  // раньше `DefaultCacheControlMiddleware`: тот регистрируется модулем при
  // `app.init()`, который в `main.ts` вызывается неявно, в самом конце
  // `bootstrap()`, то есть позже всех `app.use()` из этой функции. Без
  // директивы общий кэш вправе хранить такой ответ эвристически (RFC 9111
  // §4.2.2). Та же функция, что у middleware (`defaultCacheControl`), —
  // явный `@Header`/`PublicCacheInterceptor` дальше по цепочке всё равно его
  // перезапишет, до маршрутов, отвечающих Express-уровнем (preflight, 413),
  // дело не доходит вовсе.
  // 🔴 Только `/api` — та же зона, что у `DefaultCacheControlMiddleware`.
  // Статика `ServeStaticModule` (`serveRoot: '/'`) ставит свой `public,
  // max-age=0` лишь при пустом `Cache-Control` (`send`), и умолчание на весь
  // трафик лишило бы загрузки ETag-ревалидации и кэша CDN.
  app.use('/api', defaultCacheControl);

  // Helmet: keep CSP off in dev to avoid breaking Swagger UI; allow cross-origin resource policy for static
  const isProd = process.env.NODE_ENV === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // CORS: uses centralized configuration from cors.config.ts
  const corsConfig = getCorsConfig();
  const corsInfo = getCorsConfigInfo();
  console.log('[Security] CORS Configuration:', {
    origins: corsInfo.origins,
    credentials: corsInfo.credentials,
    warning: corsInfo.warning,
  });
  app.enableCors(corsConfig);

  // Body parsers (generic)
  const jsonLimit = process.env.BODY_LIMIT_JSON || '1mb';
  const urlencodedLimit = process.env.BODY_LIMIT_URLENCODED || '1mb';
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ limit: urlencodedLimit, extended: true }));

  // Raw body middleware for direct uploads (local driver)
  const audioLimitMb = Number(process.env.UPLOADS_MAX_AUDIO_MB || 200);
  const rawLimit = `${audioLimitMb + 10}mb`;
  app.use('/api/uploads/direct', express.raw({ type: '*/*', limit: rawLimit }));
}
