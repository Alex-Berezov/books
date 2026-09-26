import { HttpException, HttpStatus } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { RouterExceptionFilters } from '@nestjs/core/router/router-exception-filters';
import { RedirectException } from '../exceptions/redirect.exception';
import { createResponseStub } from '../testing/response-stub';
import { registerGlobalFilters } from './register-global-filters';

jest.mock('@sentry/node', () => ({
  __esModule: true,
  captureException: jest.fn(),
  withScope: jest.fn(),
  init: jest.fn(),
}));

/**
 * Выбор фильтра идёт через настоящий `RouterExceptionFilters` Nest — тот же
 * `reverse()` и тот же `selectExceptionFilterMetadata`, что на живом запросе.
 * Подмена порядка или выбора моками проверяла бы пересказ, а не продукт
 * (решение арбитра 26.09.2026).
 */
describe('registerGlobalFilters', () => {
  function setup(sentryEnabled: boolean) {
    const config = new ApplicationConfig();
    const httpAdapter = {
      isHeadersSent: jest.fn(() => false),
      reply: jest.fn(),
      end: jest.fn(),
    };
    registerGlobalFilters(
      {
        get: (() => ({ httpAdapter })) as never,
        useGlobalFilters: ((...filters: never[]) => {
          config.useGlobalFilters(...filters);
          return undefined;
        }) as never,
      },
      sentryEnabled,
    );

    const handler = new RouterExceptionFilters(
      { getModules: () => new Map() } as never,
      config,
      httpAdapter as never,
    ).create(new (class Ctrl {})(), () => undefined, 'module');

    const response = Object.assign(createResponseStub({ 'Cache-Control': 'private, no-store' }), {
      redirect: jest.fn(),
    });
    const host = new ExecutionContextHost([{ path: '/api/en/books/x' }, response]);

    return { handler, httpAdapter, response, host };
  }

  it.each([true, false])(
    'RedirectException отдаётся 301 с адресом, а не телом ошибки (sentryEnabled=%s)',
    (sentryEnabled) => {
      const { handler, httpAdapter, response, host } = setup(sentryEnabled);

      handler.next(new RedirectException('/api/en/books/en-slug/overview'), host);

      expect(response.redirect).toHaveBeenCalledTimes(1);
      expect(response.redirect).toHaveBeenCalledWith(301, '/api/en/books/en-slug/overview');
      expect(httpAdapter.reply).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'отказ уходит в глобальный фильтр и получает Vary: Authorization (sentryEnabled=%s)',
    (sentryEnabled) => {
      const { handler, httpAdapter, response, host } = setup(sentryEnabled);

      handler.next(new HttpException('nope', HttpStatus.UNAUTHORIZED), host);

      expect(httpAdapter.reply).toHaveBeenCalledTimes(1);
      expect(httpAdapter.reply.mock.calls[0][2]).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.headers['Vary']).toBe('Authorization');
      expect(response.redirect).not.toHaveBeenCalled();
    },
  );
});
