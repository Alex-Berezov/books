import { BookController } from './book.controller';
import { BookService } from './book.service';

/**
 * 🔴 `LEGACY-015`, пачка `T19`. Журнал административных действий отвечает на вопрос
 * «кто», и место, где в этот ответ подставляется актёр, ровно одно — проводка
 * аргументов в контроллере.
 *
 * ⚠️ Посадка нужна именно здесь: сервис получает `actorUserId` уже готовым и подмены
 * не увидит ни одной своей спекой. Подмена при этом дешёвая и правдоподобная — взять
 * `id` книги из адреса вместо `req.user.userId`: код собирается, все сервисные тесты
 * остаются зелёными, а удаление книги оказывается приписано самой книге.
 *
 * ⚠️ Поэтому идентификаторы актёра и цели в фикстурах обязаны различаться (`L-004`):
 * совпади они — подмена перестала бы ронять этот тест.
 *
 * Тот же приём и та же причина, что у `book-version.controller.actor.spec.ts`
 * из пачки `V1`; здесь закрыт путь удаления книги.
 */
describe('BookController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const BOOK_ID = 'book-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      remove: jest.fn().mockResolvedValue({ id: BOOK_ID }),
    };

    const controller = new BookController(service as unknown as BookService);

    return { controller, service };
  };

  it('remove: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.remove(BOOK_ID, request);

    expect(service.remove).toHaveBeenCalledTimes(1);
    expect(service.remove).toHaveBeenCalledWith(BOOK_ID, ACTOR_ID);
  });
});
