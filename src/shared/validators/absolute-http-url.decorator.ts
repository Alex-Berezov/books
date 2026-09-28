import { IsUrl, ValidationOptions } from 'class-validator';

// Одна форма URL на всех путях записи SEO-URL: переводы тега и категории, `SeoInputDto`
// и `UpdateSeoDto` (`LEGACY-401`, решения арбитра 27.09.2026 и 28.09.2026).
// `require_tld: false` — адрес `LocalStorage` по умолчанию `http://localhost:5000`.
const ABSOLUTE_HTTP_URL_OPTIONS = Object.freeze({
  require_protocol: true,
  require_tld: false,
  protocols: ['http', 'https'],
});

export function IsAbsoluteHttpUrl(validationOptions?: ValidationOptions): PropertyDecorator {
  return IsUrl({ ...ABSOLUTE_HTTP_URL_OPTIONS }, validationOptions);
}
