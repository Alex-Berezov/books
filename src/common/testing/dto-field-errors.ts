import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

/**
 * Имена полей, которые отбил бы боевой `ValidationPipe` (`main.ts`): те же `whitelist` и
 * `forbidNonWhitelisted`, без неявного приведения типов. `plainToInstance` прогоняет `@Type()`,
 * как пайп с `transform: true`, поэтому вложенные классы проверяются так же, как на живом запросе.
 */
export const dtoFieldErrors = <T extends object>(
  dto: new () => T,
  payload: Record<string, unknown>,
): string[] => {
  const instance = plainToInstance(dto, payload, { enableImplicitConversion: false });
  return validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((error) => error.property);
};
