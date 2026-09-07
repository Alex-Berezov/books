import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CreateBookDto } from '../modules/book/dto/create-book.dto';
import { UpdateBookDto } from '../modules/book/dto/update-book.dto';
import { CreateBookVersionDto } from '../modules/book-version/dto/create-book-version.dto';
import { UpdateBookVersionDto } from '../modules/book-version/dto/update-book-version.dto';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Описание OpenAPI одним местом на два потребителя: `bootstrap` в `main.ts`,
 * который отдаёт схему по `/docs-json`, и сторож снапшота
 * (`common/testing/openapi-snapshot.spec.ts`, `LEGACY-016`).
 *
 * ⚠️ Вынесено сюда, а не оставлено в `main.ts`, потому что импорт `main.ts`
 * поднимает сервер: файл вызывает `bootstrap()` при загрузке. Сторож,
 * собирающий свою копию `DocumentBuilder`, сверял бы снапшот с описанием,
 * которого никто не отдаёт, — второй источник истины ровно того класса, ради
 * которого заведена сама запись.
 */
export const buildOpenApiDocument = (app: INestApplication): OpenAPIObject => {
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

  return SwaggerModule.createDocument(app, config, {
    extraModels: [CreateBookDto, UpdateBookDto, CreateBookVersionDto, UpdateBookVersionDto],
  });
};
