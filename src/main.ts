import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

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
    .setDescription('API for the Books application')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Add "api" prefix to all routes
  app.setGlobalPrefix('api');

  await app.listen(5000);
  console.log(`Application is running on: ${await app.getUrl()}`);
}

void bootstrap();
