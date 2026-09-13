import request from 'supertest';
import type { Server } from 'http';

/**
 * Оснастка для проверки `LEGACY-363` на терминах таксономии.
 *
 * Тег и категория проверяются одним и тем же набором кейсов: у них совпадают поля,
 * совпадают `NOT NULL`-колонки под ними и совпадает рисунок ручек. Третий термин той же
 * формы получил бы третью копию этих же двадцати строк внутри своего `describe`, где
 * её никто не нашёл бы, — поэтому оснастка лежит здесь, рядом с `book-fixture`
 * и `translations` (`STYLE_GUIDE.md` §1).
 */

/** Уникальный хвост слага: партии e2e идут параллельно и делят одну базу. */
export const uniqueMark = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Поля термина над `NOT NULL`-колонками. `null` в каждом обязан давать 400, а не 500:
 * `@IsOptional()` пропустил бы его мимо проверки типа прямо в Prisma.
 */
export const TERM_NULL_CASES = [
  ['indexable', { indexable: null }],
  ['isVisible', { isVisible: null }],
  ['sortOrder', { sortOrder: null }],
  ['name', { name: null }],
  ['slug', { slug: null }],
  ['key', { key: null }],
] as const;

/** То же для перевода: там `NOT NULL` только у имени и слага, остальное nullable. */
export const TRANSLATION_NULL_CASES = [
  ['name', { name: null }],
  ['slug', { slug: null }],
] as const;

/** Создание и удаление термина: адрес и обязательные поля различаются, остальное — нет. */
export const taxonomyFixture = (
  http: () => Server,
  token: () => string,
  route: 'tags' | 'categories',
  required: Record<string, unknown> = {},
) => {
  const create = async (prefix: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const mark = uniqueMark(prefix);
    const created = await request(http())
      .post(`/${route}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ ...required, name: 'Null Case', slug: mark, key: mark, ...extra })
      .expect(201);
    return (created.body as { id: string }).id;
  };

  const drop = async (id: string): Promise<void> => {
    await request(http())
      .delete(`/${route}/${id}`)
      .set('Authorization', `Bearer ${token()}`)
      .expect(204);
  };

  const addTranslation = async (id: string, language = 'es'): Promise<void> => {
    await request(http())
      .post(`/${route}/${id}/translations`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ language, name: 'Traduccion', slug: uniqueMark(`${route}-tr`) })
      .expect(201);
  };

  return { create, drop, addTranslation };
};
