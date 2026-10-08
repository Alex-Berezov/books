import { IsUrl, ValidationOptions, isURL, registerDecorator } from 'class-validator';

// Одна форма URL на всех путях записи SEO-URL: переводы тега и категории, `SeoInputDto`
// и `UpdateSeoDto` (`LEGACY-401`, решения арбитра 27.09.2026 и 28.09.2026), `coverImageUrl`/`referralUrl`
// версии и канала клиренса `POST /admin/rights/intakes/:id/create-book` (`T75`, `T88`),
// `sourceUrl` приёма и правового изменения, `avatarUrl` профиля (`T94`); ссылки автора, претензии,
// вложения претензии, лицензии и `url` подтверждения медиа (`T118`, `LEGACY-447`).
// `require_tld: false` — адрес `LocalStorage` по умолчанию `http://localhost:5000`.
// Копия правила на фронте — `books-front/lib/utils/http-url.ts` (`T75`): правка опций здесь
// правится и там, иначе форма пропустит адрес, на который ручка ответит 400.
const ABSOLUTE_HTTP_URL_OPTIONS = Object.freeze({
  require_protocol: true,
  require_tld: false,
  protocols: ['http', 'https'],
});

export function IsAbsoluteHttpUrl(validationOptions?: ValidationOptions): PropertyDecorator {
  return IsUrl({ ...ABSOLUTE_HTTP_URL_OPTIONS }, validationOptions);
}

// Тот же предел, что `max_allowed_length` у `isURL` по умолчанию: одна длина на обе ветки поля.
const MAX_URL_LENGTH = 2084;

/**
 * Путь от корня сайта: `/ru/author/wilde`. Не `//host` (протокол-относительный адрес уводит
 * на чужой хост), без пробелов, управляющих символов и обратной косой черты.
 */
function isRootPath(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= MAX_URL_LENGTH &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    // eslint-disable-next-line no-control-regex -- управляющие символы в пути недопустимы
    !/[\s\\\x00-\x1f\x7f<>]/.test(value)
  );
}

// `BookVersion.authorPageUrl` законно хранит и внешний адрес, и внутренний путь автора
// (форма версии ставит `/<lang>/author/<slug>`), поэтому форма поля — одна из двух
// (`LEGACY-401`, `T94`). Копия правила на фронте — `books-front/lib/utils/http-url.ts`.
export function IsAbsoluteHttpUrlOrRootPath(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) =>
    registerDecorator({
      name: 'isAbsoluteHttpUrlOrRootPath',
      target: object.constructor,
      propertyName: propertyName as string,
      options: {
        message: ({ property }) =>
          `${property} must be an absolute http(s) URL or a path starting with a single "/"`,
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          (isRootPath(value) || isURL(value, { ...ABSOLUTE_HTTP_URL_OPTIONS })),
      },
    });
}
