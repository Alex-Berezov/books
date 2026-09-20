import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { Language } from '@prisma/client';

/**
 * 🔴 `LEGACY-015`, пачка `T20`. Та же посадка, что у `category.controller.actor.spec.ts`
 * и `chapter.controller.actor.spec.ts`: журнал отвечает на вопрос «кто», а подставляется
 * актёр ровно в одном месте — в проводке аргументов контроллера.
 *
 * ⚠️ Идентификаторы актёра и цели различаются намеренно (`L-004`): при совпадении
 * перепутанный аргумент остался бы незамеченным.
 */
describe('TagsController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const TAG_ID = 'tag-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      remove: jest.fn().mockResolvedValue({ id: TAG_ID }),
      deleteTranslation: jest.fn().mockResolvedValue({ success: true }),
    };

    const controller = new TagsController(service as unknown as TagsService);

    return { controller, service };
  };

  it('remove: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.remove(TAG_ID, request);

    expect(service.remove).toHaveBeenCalledTimes(1);
    expect(service.remove).toHaveBeenCalledWith(TAG_ID, ACTOR_ID);
  });

  it('deleteTranslation: актёр берётся из токена, цель и язык — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.deleteTranslation(TAG_ID, Language.en, request);

    expect(service.deleteTranslation).toHaveBeenCalledTimes(1);
    expect(service.deleteTranslation).toHaveBeenCalledWith(TAG_ID, Language.en, ACTOR_ID);
  });
});
