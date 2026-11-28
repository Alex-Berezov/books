import type { Prisma } from '@prisma/client';
import { WORLD_EVENT_CARD_SELECT, WORLD_OBJECT_CARD_SELECT } from './book-world-data';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import { WORLD_OBJECTS } from './world-public';
import { worldObjectCards } from './world-object-cards';
import { CHAPTER_NUMBERS_LIMIT } from '../../shared/chapters/chapter-numbers';

type Client = Pick<Prisma.TransactionClient, 'bookWorldEntity' | 'chapter'>;

/**
 * Карточки общей страницы (`F08-13a`; решения `F08 | F08-13` Q6, Q7 и `F08 | F08-13c` Q2, Q3):
 * рубильник, запросы, раскладка по типам, порядок.
 */
describe('worldObjectCards', () => {
  const card = (key: string, type: string, mentionFirst: number | null, isVisible = true) => ({
    key,
    type,
    name: key.toUpperCase(),
    short: `${key}.`,
    mentionFirst,
    isListed: false,
    isVisible,
    readAt: null,
    autoTextAt: null,
  });
  const event = (key: string, chapters: number[], isVisible = true) => ({
    ...card(key, 'event', 1, isVisible),
    blocks: { scenes: chapters.map((chapter) => ({ title: key, text: key, chapter })) },
    mentions: null,
  });
  const client = (versionChapters = [1, 2, 4, 6]) => ({
    chapter: {
      findMany: jest.fn().mockResolvedValue(versionChapters.map((number) => ({ number }))),
    },
    bookWorldEntity: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { type: unknown } }) =>
          Promise.resolve(
            where.type === 'event'
              ? [event('duel', [6, 4]), event('ball', [2]), event('hidden', [1], false)]
              : [
                  card('b', 'term', null),
                  card('c', 'term', 3),
                  card('a', 'term', 3),
                  card('h', 'term', 1, false),
                  card('ring', 'object', 5),
                  card('cane', 'object', 2),
                ],
          ),
        ),
    },
  });
  afterEach(() => {
    WORLD_OBJECTS.public = true;
  });

  it('рубильник выключен — пустые списки без запроса', async () => {
    WORLD_OBJECTS.public = false;
    const store = client();
    await expect(worldObjectCards(store as unknown as Client, 'v-1')).resolves.toEqual({
      objects: [],
      terms: [],
      events: [],
    });
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('рубильник включён — два запроса, раскладка по типам, скрытые отсеяны, по первой главе', async () => {
    const store = client();
    const cards = await worldObjectCards(store as unknown as Client, 'v-1');
    expect(cards.terms.map((c) => c.key)).toEqual(['a', 'c', 'b']);
    expect(cards.objects.map((c) => c.key)).toEqual(['cane', 'ring']);
    // Глава события — первая глава сцен (Q2): duel — 4, а не mentionFirst 1.
    expect(cards.events.map((c) => [c.key, c.chapter])).toEqual([
      ['ball', 2],
      ['duel', 4],
    ]);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledTimes(2);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v-1', type: { in: ['object', 'term'] } },
      select: WORLD_OBJECT_CARD_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v-1', type: 'event' },
      select: WORLD_EVENT_CARD_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
  });

  it('глава события вне версии - не глава карточки (F08-13b-3)', async () => {
    const store = client([2, 6]);
    const cards = await worldObjectCards(store as unknown as Client, 'v-1');
    // duel: сцены 4 и 6, главы 4 в версии нет - карточке глава 6.
    expect(cards.events.map((c) => [c.key, c.chapter])).toEqual([
      ['ball', 2],
      ['duel', 6],
    ]);
    expect(store.chapter.findMany).toHaveBeenCalledTimes(1);
    expect(store.chapter.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v-1' },
      select: { number: true },
      orderBy: { number: 'asc' },
      take: CHAPTER_NUMBERS_LIMIT,
    });
  });

  it('все сцены события вне версии - глава null; событий без сцен - глав не читает', async () => {
    const none = await worldObjectCards(client([]) as unknown as Client, 'v-1');
    expect(none.events.map((c) => [c.key, c.chapter])).toEqual([
      ['ball', null],
      ['duel', null],
    ]);
    const store = client();
    store.bookWorldEntity.findMany.mockImplementation(({ where }: { where: { type: unknown } }) =>
      Promise.resolve(where.type === 'event' ? [event('quiet', [])] : []),
    );
    const cards = await worldObjectCards(store as unknown as Client, 'v-1');
    expect(cards.events.map((c) => c.chapter)).toEqual([null]);
    expect(store.chapter.findMany).not.toHaveBeenCalled();
  });

  it('карточка — белым списком, без сцен и полей строки', async () => {
    const cards = await worldObjectCards(client() as unknown as Client, 'v-1');
    for (const c of [...cards.objects, ...cards.terms, ...cards.events]) {
      expect(Object.keys(c).sort()).toEqual(['chapter', 'hasPage', 'key', 'name', 'short']);
    }
  });
});
