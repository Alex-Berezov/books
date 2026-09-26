import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { SentryExceptionFilter } from '../../shared/sentry/sentry.filter';
import { RedirectExceptionFilter } from './redirect-exception.filter';

/**
 * 🔴 Порядок аргументов — условие правильности, а не стиль. Nest разворачивает
 * глобальные фильтры (`router-exception-filters.js`: `filters.reverse()`)
 * и берёт первый подходящий (`selectExceptionFilterMetadata`: `filters.find`).
 * `SentryExceptionFilter` объявлен `@Catch()` без типов и ловит всё, поэтому
 * он обязан стоять **первым** в вызове: тогда после разворота первым окажется
 * `RedirectExceptionFilter`. В обратном порядке `RedirectException` уходил
 * в Sentry-фильтр и отдавался 301 без `Location` (решение арбитра 26.09.2026).
 *
 * Sentry-фильтр регистрируется всегда, а не только при `sentryEnabled`: он
 * единственный глобальный `@Catch()` и ставит `Vary: Authorization` на
 * отказах (`LEGACY-108`); отправка событий внутри решается флагом.
 */
export function registerGlobalFilters(
  app: Pick<INestApplication, 'get' | 'useGlobalFilters'>,
  sentryEnabled: boolean,
): void {
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(
    new SentryExceptionFilter(httpAdapterHost, sentryEnabled),
    new RedirectExceptionFilter(),
  );
}
