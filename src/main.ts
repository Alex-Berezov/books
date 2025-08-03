import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Подключаем глобальный ValidationPipe:
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // удалять все поля, не описанные в DTO
      forbidNonWhitelisted: true, // если встречается «лишнее» поле, возвращать 400
      transform: true, // автоматически конвертировать входящие данные в нужные типы
    }),
  );

  // Добавляем префикс "api" ко всем роутам
  app.setGlobalPrefix('api');

  await app.listen(5000);
  console.log(`Application is running on: ${await app.getUrl()}`);
}

void bootstrap();
