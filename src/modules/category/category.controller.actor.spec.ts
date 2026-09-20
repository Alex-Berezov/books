import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { Language } from '@prisma/client';

/**
 * 🔴 `LEGACY-015`, пачка `T20`. Журнал административных действий отвечает на вопрос
 * «кто», и место, где в этот ответ подставляется актёр, ровно одно — проводка
 * аргументов в контроллере.
 *
 * ⚠️ Посадка нужна именно здесь: сервис получает `actorUserId` уже готовым и подмены
 * не увидит ни одной своей спекой. Подмена при этом дешёвая и правдоподобная — взять
 * `id` категории из адреса вместо `req.user.userId`: код собирается, все сервисные
 * тесты остаются зелёными, а удаление категории оказывается приписано самой категории.
 *
 * ⚠️ Поэтому идентификаторы актёра и цели в фикстурах обязаны различаться (`L-004`).
 *
 * Тот же приём и та же причина, что у `chapter.controller.actor.spec.ts` из пачки `T19`.
 */
describe('CategoryController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const CATEGORY_ID = 'category-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      remove: jest.fn().mockResolvedValue({ id: CATEGORY_ID }),
      deleteTranslation: jest.fn().mockResolvedValue({ success: true }),
    };

    const controller = new CategoryController(service as unknown as CategoryService);

    return { controller, service };
  };

  it('remove: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.remove(CATEGORY_ID, request);

    expect(service.remove).toHaveBeenCalledTimes(1);
    expect(service.remove).toHaveBeenCalledWith(CATEGORY_ID, ACTOR_ID);
  });

  it('deleteTranslation: актёр берётся из токена, цель и язык — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.deleteTranslation(CATEGORY_ID, Language.ru, request);

    expect(service.deleteTranslation).toHaveBeenCalledTimes(1);
    expect(service.deleteTranslation).toHaveBeenCalledWith(CATEGORY_ID, Language.ru, ACTOR_ID);
  });
});
