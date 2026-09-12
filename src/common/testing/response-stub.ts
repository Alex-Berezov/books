import vary from 'vary';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

/**
 * Заглушка HTTP-ответа для спек интерцепторов, работающих с заголовками.
 *
 * 🔴 `vary()` здесь — **настоящий** пакет `vary`, тот же, что стоит за
 * `res.vary()` в Express. Так проверяется решение интерцептора (кому дописывать
 * поле), а не пересказ семантики заголовка: первая версия этой заглушки
 * подменяла `vary` собственной реализацией на 15 строк и проверяла её же —
 * тесты были зелёные и не доказывали ничего о продукте (`LEGACY-101`).
 *
 * Живёт в общем месте, а не копией в каждой спеке: несущая часть — носитель,
 * на котором работает настоящий `vary`, и правка его семантики (регистр имени,
 * массив значений) должна доезжать до всех спек сразу. Две копии разошлись бы
 * молча, и та, что осталась старой, была бы зелёной на поведении, которого
 * в Express уже нет.
 */
export type HeaderValue = string | string[] | number;

export interface ResponseStub {
  headers: Record<string, HeaderValue>;
  headersSent: boolean;
  setHeader: jest.Mock<void, [string, HeaderValue]>;
  getHeader: jest.Mock<HeaderValue | undefined, [string]>;
  vary: jest.Mock<void, [string]>;
}

export const createResponseStub = (
  initial: Record<string, HeaderValue> = {},
  headersSent = false,
): ResponseStub => {
  const headers: Record<string, HeaderValue> = { ...initial };
  const carrier = {
    setHeader: (name: string, value: HeaderValue) => {
      headers[name] = value;
    },
    getHeader: (name: string) => headers[name],
  };

  return {
    headers,
    headersSent,
    setHeader: jest.fn(carrier.setHeader),
    getHeader: jest.fn(carrier.getHeader),
    vary: jest.fn((field: string) => {
      vary(carrier as unknown as Parameters<typeof vary>[0], field);
    }),
  };
};

export const createExecutionContextStub = (response: ResponseStub): ExecutionContext =>
  ({
    switchToHttp: () => ({ getResponse: () => response }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

/** Обработчик, который ничего не делает и отдаёт `null`. */
export const passthroughHandler: CallHandler = { handle: () => of(null) };
