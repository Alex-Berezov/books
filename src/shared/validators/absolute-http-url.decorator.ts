import { IsUrl, ValidationOptions } from 'class-validator';

// Одна форма URL для колонок `canonicalUrl`/`ogImageUrl` переводов тега и категории (импорт,
// создание и `PATCH`); вложенный `seo` сюда не входит (`LEGACY-401`, решения арбитра 27.09.2026).
// `require_tld: false` — адрес `LocalStorage` по умолчанию `http://localhost:5000`.
const ABSOLUTE_HTTP_URL_OPTIONS = Object.freeze({
  require_protocol: true,
  require_tld: false,
  protocols: ['http', 'https'],
});

export function IsAbsoluteHttpUrl(validationOptions?: ValidationOptions): PropertyDecorator {
  return IsUrl({ ...ABSOLUTE_HTTP_URL_OPTIONS }, validationOptions);
}
