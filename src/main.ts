import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Application as ExpressApp } from 'express';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApiDocument } from './config/openapi.config';
import { configureSecurity } from './common/security/app-security.config';
import * as Sentry from '@sentry/node';
import { SENTRY_MAX_VALUE_LENGTH, sentryBeforeSend } from './shared/sentry/before-send';
import { registerGlobalFilters } from './common/filters/register-global-filters';
import { robotsHeaderMiddleware } from './common/middleware/robots-header.middleware';
import { docsCacheHeadersMiddleware } from './common/middleware/docs-cache-headers.middleware';
import { assertJwtSecrets } from './common/config/jwt-secrets';
import { assertPublicSiteUrl, resolvePublicSiteUrl } from './modules/seo/utils/publicSiteUrl';

async function bootstrap() {
  // Fail fast: a PUBLIC_SITE_URL pointing at a service host would leak
  // api./media. subdomains into canonical, hreflang, og:url and JSON-LD.
  assertPublicSiteUrl();

  // Fail fast: an unset JWT secret used to fall back to a string published in
  // this repository, which would let anyone forge an admin token.
  assertJwtSecrets();

  const app = await NestFactory.create(AppModule);

  // Respect reverse proxy headers when running behind a proxy (e.g., ingress)
  if ((process.env.TRUST_PROXY ?? '0') === '1') {
    const httpAdapter = app.getHttpAdapter();
    const getInstance = (httpAdapter as { getInstance?: () => unknown }).getInstance;
    if (typeof getInstance === 'function') {
      const instance = getInstance.call(httpAdapter) as ExpressApp;
      instance.set('trust proxy', 1);
    }
  }

  // Security (Helmet, CORS, body limits, static, direct upload raw)
  configureSecurity(app);

  // Never let the API subdomain be indexed (see robots-header.middleware.ts)
  app.use(robotsHeaderMiddleware);

  // Sentry init (optional, controlled by env SENTRY_DSN). Disabled in dev unless explicitly enabled.
  const dsn = process.env.SENTRY_DSN;
  const sentryEnabled = Boolean(dsn) && (process.env.SENTRY_ENABLED ?? '1') !== '0';
  if (sentryEnabled) {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? 0),
      integrations: [],
      // disable autoSessionTracking — the API does not use browser sessions
      autoSessionTracking: false,
      // LEGACY-336: the only client hook every event passes through. The filter
      // calls captureException with the raw error, and a Prisma validation
      // message is the rendered call together with the whole `data` object.
      beforeSend: sentryBeforeSend,
      // LEGACY-336: raised well above our own 512-char cap so the SDK never
      // truncates mid-email before beforeSend runs. See before-send.ts.
      maxValueLength: SENTRY_MAX_VALUE_LENGTH,
    });
  }
  // Порядок фильтров и безусловная регистрация — см. register-global-filters.ts.
  registerGlobalFilters(app, sentryEnabled);

  // Set up global ValidationPipe:
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // remove all properties not defined in DTOs
      forbidNonWhitelisted: true, // return 400 if extra properties are present
      transform: true, // automatically transform incoming data to the required types
    }),
  );

  // Set up Swagger documentation - ALWAYS ENABLED
  console.log('Setting up Swagger documentation...');
  // LEGACY-108: до setGlobalPrefix('api'), поэтому DefaultCacheControlMiddleware
  // (матчится только на /api) сюда не достаёт — заголовок ставим отдельно,
  // и регистрировать нужно до SwaggerModule.setup, иначе его маршруты уже
  // отдадут ответ раньше, чем наш middleware успеет выполниться.
  app.use(docsCacheHeadersMiddleware);
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
  console.log('✅ Swagger documentation available at /docs');

  // Add "api" prefix to all routes
  app.setGlobalPrefix('api');

  const PORT = Number(process.env.PORT) || 5000;
  const HOST = process.env.HOST || '0.0.0.0';
  await app.listen(PORT, HOST);
  const displayedUrl = `http://localhost:${PORT}`;
  console.log(`Application is running on: ${displayedUrl}`);
  console.log(`[SEO] Public site origin: ${resolvePublicSiteUrl()}`);
}

void bootstrap();
