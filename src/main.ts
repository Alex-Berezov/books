import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Application as ExpressApp } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CreateBookDto } from './modules/book/dto/create-book.dto';
import { UpdateBookDto } from './modules/book/dto/update-book.dto';
import { CreateBookVersionDto } from './modules/book-version/dto/create-book-version.dto';
import { UpdateBookVersionDto } from './modules/book-version/dto/update-book-version.dto';
import { configureSecurity } from './common/security/app-security.config';
import * as Sentry from '@sentry/node';
import { HttpAdapterHost } from '@nestjs/core';
import { SentryExceptionFilter } from './shared/sentry/sentry.filter';

async function bootstrap() {
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
      // отключаем autoSessionTracking — API не использует браузерные сессии
      autoSessionTracking: false,
    });
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new SentryExceptionFilter(httpAdapterHost, true));
  }

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
  const config = new DocumentBuilder()
    .setTitle('Books App API')
    .setDescription(
      [
        'API for the Books application',
        '',
        'How to publish a book version:',
        '1) POST /api/books/{bookId}/versions — create a version (draft by default).',
        '2) Optionally PATCH /api/versions/{id} — edit fields or SEO.',
        '3) PATCH /api/versions/{id}/publish — publish the version (status=published).',
        '4) To hide again — PATCH /api/versions/{id}/unpublish (status=draft).',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addServer('http://localhost:5000', 'Local')
    .addServer('https://api.bibliaris.com', 'Production')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [CreateBookDto, UpdateBookDto, CreateBookVersionDto, UpdateBookVersionDto],
  });
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
}

void bootstrap();
