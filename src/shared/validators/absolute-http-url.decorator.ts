import { IsUrl, ValidationOptions } from 'class-validator';

// Одна форма URL на всех путях записи SEO-URL: переводы тега и категории, `SeoInputDto`
// и `UpdateSeoDto` (`LEGACY-401`, решения арбитра 27.09.2026 и 28.09.2026), `coverImageUrl`/`referralUrl`
// версии и канала клиренса `POST /admin/rights/intakes/:id/create-book` (`T75`, `T88`).
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
