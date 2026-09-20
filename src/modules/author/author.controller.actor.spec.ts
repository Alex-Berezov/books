import { AuthorController } from './author.controller';
import { AuthorService } from './author.service';

/**
 * 🔴 `LEGACY-015`, пачка `T21`. Журнал административных действий отвечает на вопрос
 * «кто», и место, где в этот ответ подставляется актёр, ровно одно — проводка
 * аргументов в контроллере.
 *
 * ⚠️ Посадка нужна именно здесь: сервис получает `actorUserId` уже готовым и подмены
 * не увидит ни одной своей спекой. Подмена при этом дешёвая и правдоподобная — взять
 * `id` автора из адреса вместо `req.user.userId`: код собирается, все сервисные тесты
 * остаются зелёными, а удаление автора оказывается приписано самому автору.
 *
 * ⚠️ Поэтому идентификаторы актёра и цели в фикстурах обязаны различаться (`L-004`).
 *
 * Тот же приём и та же причина, что у `category.controller.actor.spec.ts` из пачки `T20`.
 */
describe('AuthorController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const AUTHOR_ID = 'author-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      delete: jest.fn().mockResolvedValue({ id: AUTHOR_ID }),
    };

    const controller = new AuthorController(service as unknown as AuthorService);

    return { controller, service };
  };

  it('delete: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.delete(AUTHOR_ID, request);

    expect(service.delete).toHaveBeenCalledTimes(1);
    expect(service.delete).toHaveBeenCalledWith(AUTHOR_ID, ACTOR_ID);
  });
});
