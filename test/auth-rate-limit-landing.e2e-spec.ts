import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Посадка 5 из `tasks/auth-social/CR.md`: любой маршрут под `/auth`, для которого нет
 * отдельной ветки, обязан считаться лимитером. До сих пор она была закрыта только
 * юнит-тестом гварда с замоканным лимитером — он проверял, что гвард зовёт `consume`
 * с нужными аргументами, а не что запрос действительно отвергается.
 *
 * 🔴 `RATE_LIMIT_AUTH_ENABLED` выставляется здесь явно: в `.env.test` он равен `0`,
 * то есть по умолчанию **весь гвард выключен**, и проба без этой строки была бы
 * зелёной при любом коде — включая код, где лимита нет вовсе. Ровно на это и
 * напоролась живая проверка 08.08.2026: 11 × 200 на проде дал контейнер со старым
 * окружением, а не дефект.
 */
describe('Auth rate limit landing (e2e)', () => {
  let app: INestApplication;
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const previousEnabled = process.env.RATE_LIMIT_AUTH_ENABLED;

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_ENABLED = '1';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // CI гоняет e2e через `--runInBand`, то есть все наборы живут в одном процессе.
    // Оставленный `RATE_LIMIT_AUTH_ENABLED=1` включил бы лимитер и для наборов,
    // которые поднимаются после этого, — и их `register`/`login` начали бы ловить
    // 429 плавающим образом, в зависимости от порядка файлов.
    if (previousEnabled === undefined) delete process.env.RATE_LIMIT_AUTH_ENABLED;
    else process.env.RATE_LIMIT_AUTH_ENABLED = previousEnabled;
  });

  it('counts POST /auth/logout and refuses the 11th', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await request(http()).post('/auth/logout').send({});
      codes.push(res.status);
    }

    expect(codes.slice(0, 10)).not.toContain(429);
    expect(codes[10]).toBe(429);
  });
});
