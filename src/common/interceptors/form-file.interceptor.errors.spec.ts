import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { FormFileInterceptor, MALFORMED_FORM_MESSAGE } from './form-file.interceptor';

// Ошибка, которой ответит подменённый multer. Обрыв запроса (`Request aborted`/`Request closed`)
// живым запросом в supertest не построить — правило проверяется на самой ошибке.
let mockMulterFailure: Error;

jest.mock('@nestjs/platform-express', () => ({
  FileInterceptor: () =>
    class {
      intercept(): Promise<never> {
        throw mockMulterFailure;
      }
    },
}));

/** LEGACY-482. Какие ошибки этапа разбора формы перехватчик отдаёт 400, а какие оставляет как есть. */
describe('FormFileInterceptor error mapping', () => {
  const intercept = (failure: Error) => {
    mockMulterFailure = failure;
    const Interceptor = FormFileInterceptor('file', 16, 0);
    const interceptor: NestInterceptor = new Interceptor();
    return interceptor.intercept({} as ExecutionContext, {} as CallHandler);
  };

  it.each(['Request aborted', 'Request closed', 'Malformed content type'])(
    'answers a fixed 400 to a bare parser error "%s"',
    async (message) => {
      const result = intercept(new Error(message));
      await expect(result).rejects.toBeInstanceOf(BadRequestException);
      await expect(result).rejects.toThrow(MALFORMED_FORM_MESSAGE);
    },
  );

  it('keeps a Node system error (with code) as a server error', async () => {
    const failure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    await expect(intercept(failure)).rejects.toBe(failure);
  });

  it('keeps an Error subclass as a server error', async () => {
    const failure = new TypeError('boom');
    await expect(intercept(failure)).rejects.toBe(failure);
  });

  it('passes an HttpException through untouched', async () => {
    const failure = new PayloadTooLargeException('File too large');
    await expect(intercept(failure)).rejects.toBe(failure);
  });
});
