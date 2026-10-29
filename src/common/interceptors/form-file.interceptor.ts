import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  mixin,
  NestInterceptor,
  Type,
} from '@nestjs/common';
import { FileInterceptor, MulterModuleOptions } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { MulterError } from 'multer';
import type { Observable } from 'rxjs';

/**
 * LEGACY-475. Потолки текстовых полей multipart-формы. Без `fieldArrayIndexLimit` имя поля
 * `x[4294967294]` строит в `req.body` массив в 2^32-1 элемента (append-field зовётся multer
 * на каждое поле, читает контроллер тело или нет) и держит процесс десятки секунд.
 */
export const FORM_FIELD_MAX_BYTES = 256;
export const FORM_FIELD_NAME_MAX_BYTES = 64;

// `fieldArrayIndexLimit` появился в multer 2.5.0; ни `MulterOptions` из Nest, ни `@types/multer`
// его пока не описывают.
type FormLimits = NonNullable<MulterModuleOptions['limits']> & { fieldArrayIndexLimit: number };

function formFileOptions(fileSizeBytes: number, fields: number): MulterModuleOptions {
  const limits: FormLimits = {
    fileSize: fileSizeBytes,
    files: 1,
    fields,
    // Страховка поверх `files` и `fields`: отдельно не срабатывает, пока те на месте.
    parts: fields + 2,
    fieldSize: FORM_FIELD_MAX_BYTES,
    fieldNameSize: FORM_FIELD_NAME_MAX_BYTES,
    fieldArrayIndexLimit: 0,
  };
  return { storage: memoryStorage(), limits };
}

// По имени, а не `instanceof`: multer приходит транзитивно, и вторая копия пакета в дереве
// дала бы другой класс `MulterError` — отказ снова ушёл бы 500.
function isMulterError(error: unknown): error is MulterError {
  return error instanceof Error && error.name === 'MulterError';
}

/** LEGACY-482. Текст отказа на форму, которую не разобрал busboy или multer. */
export const MALFORMED_FORM_MESSAGE = 'Malformed multipart form';

// busboy и multer сообщают о кривой форме голым `Error` без `code` (`Unsupported content type`,
// `Multipart: Boundary not found`, `Unexpected end of form`, `Request aborted` и т.п.) — список
// текстов не закрыт и меняется с версией, поэтому решает форма ошибки, а не текст. Системная
// ошибка Node несёт `code` (`ENOSPC`, `EACCES`), подклассы (`TypeError`, `RangeError`) — ошибка
// кода: те и другие остаются 500. Хранилище здесь только `memoryStorage` (`formFileOptions`):
// дисковое хранилище принесло бы свои голые ошибки, и это правило пришлось бы пересмотреть.
function isFormParseFailure(error: unknown): error is Error {
  return (
    error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && !('code' in error)
  );
}

/**
 * `FileInterceptor` с потолками полей формы и отказом разбора формы в 400.
 *
 * `transformException` из `@nestjs/platform-express` 11.2.7 не знает кодов multer 2.5
 * (`LIMIT_FIELD_ARRAY_INDEX`, `INVALID_FIELD_NAME`, `STREAM_DESTROYED`) и отдаёт `MulterError`
 * как есть — наружу это 500. Перехватчик бросает `BadRequestException`, а не пишет ответ сам:
 * отказ идёт через глобальный `SentryExceptionFilter` (`Vary: Authorization`, Sentry).
 * Текст — как у известных Nest кодов: `<сообщение> - <поле>`. Голый `Error` busboy и multer
 * (кривой `Content-Type`, оборванное тело) — тоже 400, с постоянным текстом
 * `MALFORMED_FORM_MESSAGE`: сообщение busboy несёт заголовок клиента.
 * Ошибки обработчика маршрута сюда не попадают — они в потоке `next.handle()`.
 */
export function FormFileInterceptor(
  fieldName: string,
  fileSizeBytes: number,
  fields: number,
): Type<NestInterceptor> {
  const Multer = FileInterceptor(fieldName, formFileOptions(fileSizeBytes, fields));

  @Injectable()
  class FormFileMixin implements NestInterceptor {
    private readonly multer = new Multer();

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      try {
        return await this.multer.intercept(context, next);
      } catch (error) {
        if (isMulterError(error)) {
          throw new BadRequestException(
            error.field ? `${error.message} - ${error.field}` : error.message,
          );
        }
        if (isFormParseFailure(error)) throw new BadRequestException(MALFORMED_FORM_MESSAGE);
        throw error;
      }
    }
  }

  return mixin(FormFileMixin);
}
