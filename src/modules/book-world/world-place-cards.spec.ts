import type { Prisma } from '@prisma/client';
import { worldPlaceCards } from './world-place-cards';
import { WORLD_PLACES } from './world-public';
import { worldItemKey } from './world-quote-check';

type Client = Pick<Prisma.TransactionClient, 'bookWorldEntity'>;

/** Места общей страницы (`F08-12a`, решения `F08 | F08-12` Q0, Q4): рубильник и одно условие показа. */
describe('worldPlaceCards', () => {
  const card = (key: string, isVisible: boolean) => ({
    key,
    type: 'place',
    name: key.toUpperCase(),
    short: null,
    aliases: null,
    isListed: false,
    isVisible,
    readAt: null,
    autoTextAt: null,
    blocks: {},
    mentions: null,
    geo: null,
  });
  const client = () => ({
    bookWorldEntity: { findMany: jest.fn().mockResolvedValue([card('a', true), card('b', false)]) },
  });
  afterEach(() => {
    WORLD_PLACES.public = true;
  });

  it('рубильник выключен — пустой список без запроса', async () => {
    WORLD_PLACES.public = false;
    const store = client();
    await expect(worldPlaceCards(store as unknown as Client, 'v-1')).resolves.toEqual([]);
    expect(store.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });

  it('рубильник включён — места этой версии, скрытые отсеяны', async () => {
    WORLD_PLACES.public = true;
    const store = client();
    const cards = await worldPlaceCards(store as unknown as Client, 'v-1');
    expect(cards.map((c) => c.key)).toEqual(['a']);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
    expect(store.bookWorldEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookVersionId: 'v-1', type: 'place' } }),
    );
  });

  // Решение арбитра `F08 | F08-12c` R1: «глава N» сцены на `/wiki` ссылается в читалку без набора
  // глав версии - главу держит пересчёт: сцена удалённой главы уходит в `mentions.stale` и в
  // карточку не попадает.
  it('сцена из mentions.stale (главы больше нет) в карточку не идёт', async () => {
    const gone = { chapter: 9, title: 'Gone', text: 'Chapter removed.' };
    const kept = { chapter: 1, title: 'Kept', text: 'Still here.' };
    const row = {
      ...card('a', true),
      blocks: { scenes: [kept, gone] },
      mentions: { chapters: [1], first: 1, stale: [worldItemKey('scenes', gone)] },
    };
    const store = { bookWorldEntity: { findMany: jest.fn().mockResolvedValue([row]) } };
    const [only] = await worldPlaceCards(store as unknown as Client, 'v-1');
    expect(only.scenes).toEqual([{ title: 'Kept', chapter: 1, paragraph: null }]);
  });
});
