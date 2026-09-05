import { Book, Prisma, PrismaClient } from '@prisma/client';

/**
 * Единственная точка, где e2e-фикстура заводит `Book` записью в базу, минуя вход через права.
 *
 * Почему шорткат вообще существует (`LEGACY-039`). Продуктового пути «просто создать книгу» нет:
 * `POST /books` отключён и всегда отвечает 400 (`src/modules/book/book.controller.ts:102-116`),
 * а книга рождается только из утверждённого клиренса —
 * `POST /admin/rights/intakes/:id/create-book`. Санкционированный путь целиком — это пять
 * последовательных HTTP-вызовов (intake → status → review-import → materialize → approve)
 * с админским токеном и валидным отчётом на шесть десятков строк; он **уже** покрыт четырьмя
 * e2e-спеками — `rights-lawyer-workflow`, `rights-clearance-to-geo-block`, `rights-actions`,
 * `rights-recheck`. Гонять его ещё и в каждой фикстуре, которой книга нужна лишь как
 * предусловие для SEO, лайков или комментариев, — это дубль покрытия ценой пяти запросов
 * на книгу в наборе, который и так идёт 6-9 минут.
 *
 * Что из этого следует при чтении e2e: **наличие книги в фикстуре ничего не говорит о том,
 * что такой путь существует в продукте.** Запрет держится на контроллере и сервисе, а не на
 * схеме, поэтому запись сюда проходит. Сам запрет посажен отдельно —
 * `test/book-creation-ban.e2e-spec.ts`, там же стоит сторож на единственность этой точки.
 *
 * Книге, которой нужна связка с одобренным клиренсом (правовые поля, `publicationGate`,
 * свежесть заключения), берётся не этот хелпер, а `createBookWithRights` из
 * `test/helpers/book-with-rights.ts`.
 */
export async function createBookFixture(
  prisma: PrismaClient,
  slug: string,
  overrides: Omit<Prisma.BookUncheckedCreateInput, 'slug'> = {},
): Promise<Book> {
  return prisma.book.create({ data: { slug, ...overrides } });
}
