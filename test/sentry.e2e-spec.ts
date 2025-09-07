/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { HttpAdapterHost } from '@nestjs/core';
import { SentryExceptionFilter } from '../src/shared/sentry/sentry.filter';

// Mock @sentry/node BEFORE importing app modules that use it
jest.mock('@sentry/node', () => {
  const captureException = jest.fn();
  return {
    __esModule: true,
    captureException,
    withScope: (cb: (scope: any) => void) => {
      const scope = {
        setTag: jest.fn(),
        setContext: jest.fn(),
        setUser: jest.fn(),
      };
      cb(scope);
    },
    init: jest.fn(),
  };
});
import * as Sentry from '@sentry/node';

const shouldRun = Boolean(process.env.SENTRY_DSN);

(shouldRun ? describe : describe.skip)('Sentry integration (e2e, conditional)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    let builder: TestingModuleBuilder = Test.createTestingModule({ imports: [AppModule] });
    // Bypass auth/roles for this suite to call admin-only route
    builder = builder
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true });

    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();

    // Match main.ts: global ValidationPipe and Sentry filter
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new SentryExceptionFilter(httpAdapterHost, true));

    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('does not report 4xx validation errors to Sentry', async () => {
    (Sentry as any).captureException.mockClear();

    // Send extra field to trigger 400 via forbidNonWhitelisted
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'e2e_sentry@example.com', password: 'password123', extra: 'oops' })
      .expect(400);

    expect((Sentry as any).captureException).not.toHaveBeenCalled();
  });

  it('reports 5xx from /status/sentry-test to Sentry', async () => {
    (Sentry as any).captureException.mockClear();

    await request(app.getHttpServer()).post('/status/sentry-test').expect(500);

    expect((Sentry as any).captureException).toHaveBeenCalledTimes(1);
    const [arg] = (Sentry as any).captureException.mock.calls[0] ?? [];
    expect(arg).toBeInstanceOf(Error);
  });
});
