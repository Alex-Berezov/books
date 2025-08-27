import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CreateBookDto } from './modules/book/dto/create-book.dto';
import { UpdateBookDto } from './modules/book/dto/update-book.dto';
import { CreateBookVersionDto } from './modules/book-version/dto/create-book-version.dto';
import { UpdateBookVersionDto } from './modules/book-version/dto/update-book-version.dto';
import * as express from 'express';
import { join } from 'node:path';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Set up global ValidationPipe:
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // remove all properties not defined in DTOs
      forbidNonWhitelisted: true, // return 400 if extra properties are present
      transform: true, // automatically transform incoming data to the required types
    }),
  );

  // Set up Swagger documentation
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
    .addServer('https://api.example.com', 'Prod')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [CreateBookDto, UpdateBookDto, CreateBookVersionDto, UpdateBookVersionDto],
  });
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
  });

  // Add "api" prefix to all routes
  app.setGlobalPrefix('api');

  // Raw body middleware for direct uploads (local driver)
  app.use(
    '/api/uploads/direct',
    express.raw({ type: '*/*', limit: '110mb' }), // 100MB + headroom
  );

  // Ensure static serving for local uploads (in addition to ServeStaticModule)
  const uploadsRoot = process.env.LOCAL_UPLOADS_DIR
    ? join(process.cwd(), process.env.LOCAL_UPLOADS_DIR)
    : join(process.cwd(), 'var', 'uploads');
  app.use('/static', express.static(uploadsRoot));

  const PORT = Number(process.env.PORT) || 5000;
  const HOST = process.env.HOST || '0.0.0.0';
  await app.listen(PORT, HOST);
  const displayedUrl = `http://localhost:${PORT}`;
  console.log(`Application is running on: ${displayedUrl}`);
}

void bootstrap();
