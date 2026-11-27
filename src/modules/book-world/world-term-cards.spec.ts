import type { Prisma } from '@prisma/client';
import { WORLD_TERM_CARD_SELECT } from './book-world-data';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import { WORLD_OBJECTS } from './world-public';
import { worldTermCards } from './world-term-cards';

type Client = Pick<Prisma.TransactionClient, 'bookWorldEntity'>;

/** Глоссарий общей страницы (`F08-13a`, решения `F08 | F08-13` Q6, Q7): рубильник, запрос, порядок. */
describe('worldTermCards', () => {
  const card = (key: string, mentionFirst: number | null, isVisible = true) => ({
    key,
    type: 'term',
    name: key.toUpperCase(),
    short: `${key}.`,
    mentionFirst,
    isListed: false,
    isVisible,
    readAt: null,
    autoTextAt: null,
  });
  const client = () => ({
    bookWorldEntity: {
      findMany: jest
        .fn()
        .mockResolvedValue([card('b', null), card('c', 3), card('a', 3), card('h', 1, false)]),
    },
  });
  afterEach(() => {
    WORLD_OBJECTS.public = false;
  });

  it('рубильник выключен — пустой список без запроса', async () => {
    const store = client();
    await expect(worldTermCards(store as unknown as Client, 'v-1')).resolves.toEqual([]);
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('рубильник включён — понятия версии одним запросом, скрытые отсеяны, по первой главе', async () => {
    WORLD_OBJECTS.public = true;
    const store = client();
    const cards = await worldTermCards(store as unknown as Client, 'v-1');
    expect(cards.map((c) => c.key)).toEqual(['a', 'c', 'b']);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v-1', type: 'term' },
      select: WORLD_TERM_CARD_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
  });
});
