import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import * as express from 'express';
import { join } from 'node:path';

/**
 * Apply security middleware and body limits consistently across the app.
 * - Helmet with safe defaults (CSP disabled in non-prod to not break Swagger)
 * - CORS with origin from env (CORS_ORIGIN, default "*") and common headers
 * - Body parsers: JSON and URL-encoded with 1mb limits by default
 * - Raw body for local direct uploads (110mb)
 * - Static files for local uploads mapped to /static
 */
export function configureSecurity(app: INestApplication): void {
  // Helmet: keep CSP off in dev to avoid breaking Swagger UI; allow cross-origin resource policy for static
  const isProd = process.env.NODE_ENV === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // CORS
  const originEnv = process.env.CORS_ORIGIN || '*';
  const corsOrigin = originEnv === '*' ? '*' : originEnv;
  app.enableCors({
    origin: corsOrigin,
    credentials: false,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Admin-Language',
      'Accept-Language',
      'Accept',
      'Origin',
      'User-Agent',
    ],
    exposedHeaders: ['Content-Length'],
    optionsSuccessStatus: 204,
  });

  // Body parsers (generic)
  const jsonLimit = process.env.BODY_LIMIT_JSON || '1mb';
  const urlencodedLimit = process.env.BODY_LIMIT_URLENCODED || '1mb';
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ limit: urlencodedLimit, extended: true }));

  // Raw body middleware for direct uploads (local driver)
  app.use('/api/uploads/direct', express.raw({ type: '*/*', limit: '110mb' }));

  // Ensure static serving for local uploads (in addition to ServeStaticModule)
  const uploadsRoot = process.env.LOCAL_UPLOADS_DIR
    ? join(process.cwd(), process.env.LOCAL_UPLOADS_DIR)
    : join(process.cwd(), 'var', 'uploads');
  app.use('/static', express.static(uploadsRoot));
}
