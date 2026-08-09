import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';

/**
 * HTTP-сервер приложения, пригодный для `supertest`, с настоящим типом.
 *
 * `INestApplication.getHttpServer()` объявлен как `any`, поэтому каждый вызов
 * `request(app.getHttpServer())` даёт варнинг `no-unsafe-argument`. В десяти
 * e2e-наборах это глушится `eslint-disable` на весь файл — а вместе с проверкой
 * аргументов там отключается и всё остальное, что это правило ловит.
 *
 * Приведение здесь ровно одно и стоит в одном месте: `any` сужается до `App`,
 * который `supertest` и ожидает. Глушить правило в наборах после этого не нужно.
 */
export const httpServerOf = (app: INestApplication): App => app.getHttpServer() as App;
