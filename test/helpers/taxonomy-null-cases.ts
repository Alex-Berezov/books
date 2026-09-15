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
 * Куда ведёт история слагов для `oldSlug`, или `null`, если записи нет.
 *
 * Лежит здесь, а не копией в каждом наборе про редиректы: язык — параметр, и когда
 * политика начнёт писать записи не на одном языке (`LEGACY-392`), править придётся
 * одно место, а не два одинаковых с прибитым `ru`.
 */
export const readSlugRedirect = async (
  prisma: { slugRedirect: { findFirst: (args: unknown) => Promise<{ newSlug: string } | null> } },
  entityType: string,
  language: string,
  oldSlug: string,
): Promise<string | null> => {
  const row = await prisma.slugRedirect.findFirst({ where: { entityType, language, oldSlug } });
  return row?.newSlug ?? null;
};

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

  /**
   * Слаг перевода можно задать: наборы про историю слагов ищут по нему запись
   * редиректа, и сгенерированный внутри слаг им пришлось бы угадывать. Возвращается
   * тот слаг, который ушёл на сервер, — и заданный, и сгенерированный.
   */
  const addTranslation = async (id: string, language = 'es', slug?: string): Promise<string> => {
    const value = slug ?? uniqueMark(`${route}-tr`);
    await request(http())
      .post(`/${route}/${id}/translations`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ language, name: 'Traduccion', slug: value })
      .expect(201);
    return value;
  };

  /** Сменить слаг перевода — то, чем в истории слагов заводится цепочка. */
  const renameTranslation = async (id: string, language: string, slug: string): Promise<void> => {
    await request(http())
      .patch(`/${route}/${id}/translations/${language}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ slug })
      .expect(200);
  };

  return { create, drop, addTranslation, renameTranslation };
};
