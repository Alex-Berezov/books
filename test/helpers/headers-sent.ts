import { Logger } from '@nestjs/common';

/**
 * 🔴 Обработчики, закрывающие ответ сами (`@Res()` без `passthrough`, синхронный
 * `res.send()`/`res.end()`), — особый случай для глобальных интерцепторов. Nest
 * выполняет их и при уже отданном ответе, поэтому `PrivateVaryInterceptor`
 * (`APP_INTERCEPTOR` в `src/app.module.ts`) попадает туда с `headersSent === true`,
 * и `vary()` внутри зовёт `setHeader` — то есть бросает `ERR_HTTP_HEADERS_SENT`.
 *
 * Проверять надо именно лог ошибки, а не код ответа: тело уезжает клиенту до броска,
 * поэтому `expect(200)` зелёный и с дефектом, и без него.
 *
 * Хелпер общий, а не по месту: сторож стережёт глобальный интерцептор, и вторая копия
 * спая в соседней спеке разошлась бы с этой по списку искомых строк. До 13.09.2026 это
 * доказывали маршруты карты сайта в `test/cache-headers.e2e-spec.ts`; они сняты вместе
 * с модулем (`LEGACY-129`), и сторож переехал к выгрузкам системы прав — решение арбитра
 * 13.09.2026 (`decisions-log.md`).
 */
export async function withoutHeadersSentError<T>(body: () => Promise<T>): Promise<T> {
  const logged: string[] = [];
  const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(' '));
  });

  let result: T;
  try {
    result = await body();
  } finally {
    spy.mockRestore();
  }

  expect(logged.join(' | ')).not.toContain('ERR_HTTP_HEADERS_SENT');
  expect(logged.join(' | ')).not.toContain('Cannot set headers');

  return result;
}
