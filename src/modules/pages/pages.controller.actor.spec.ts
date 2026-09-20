import { Language, PublicationStatus } from '@prisma/client';
import { PagesController } from './pages.controller';
import { PagesService } from './pages.service';

/**
 * 🔴 `LEGACY-015`, пачка `T21`. Журнал административных действий отвечает на вопрос
 * «кто», и место, где в этот ответ подставляется актёр, ровно одно — проводка
 * аргументов в контроллере. Сервис получает `actorUserId` уже готовым и подмены
 * не увидит ни одной своей спекой.
 *
 * ⚠️ Идентификаторы актёра и цели в фикстурах обязаны различаться (`L-004`):
 * с одинаковыми подмена `req.user.userId` на `id` из адреса осталась бы зелёной.
 *
 * ⚠️ У `publish`/`unpublish` проверяется ещё и **статус**: обе ручки зовут один и тот
 * же `setStatus`, и перепутанные местами `'published'`/`'draft'` — это ровно то, чего
 * ни одна спека сервиса увидеть не может. По журналу страница тогда публиковалась бы
 * кнопкой «снять с публикации».
 */
describe('PagesController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const PAGE_ID = 'page-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      remove: jest.fn().mockResolvedValue({ success: true }),
      setStatus: jest.fn().mockResolvedValue({ id: PAGE_ID }),
      update: jest.fn().mockResolvedValue({ id: PAGE_ID }),
    };

    const controller = new PagesController(service as unknown as PagesService);

    return { controller, service };
  };

  /**
   * 🔴 Третий вход в смену видимости — общая форма редактирования. Он появился здесь
   * позже остальных и ровно поэтому нуждается в посадке не меньше: подмена
   * `this.service.update(id, dto, id)` компилируется, оставляет зелёными **все**
   * спеки сервиса (актёр приходит туда уже готовым) и пишет `PAGE_PUBLISHED`
   * с `actorUserId`, равным идентификатору самой страницы — журнал приписал бы
   * публикацию странице.
   */
  it('update: актёр берётся из токена, цель и тело — из запроса', async () => {
    const { controller, service } = makeController();
    const dto = { status: 'published' } as unknown as import('./dto/update-page.dto').UpdatePageDto;

    await controller.update(Language.en, PAGE_ID, dto, request);

    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledWith(PAGE_ID, dto, ACTOR_ID);
  });

  it('remove: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.remove(Language.en, PAGE_ID, request);

    expect(service.remove).toHaveBeenCalledTimes(1);
    expect(service.remove).toHaveBeenCalledWith(PAGE_ID, ACTOR_ID);
  });

  it('publish: актёр из токена, цель из адреса, статус — published', async () => {
    const { controller, service } = makeController();

    await controller.publish(Language.en, PAGE_ID, request);

    expect(service.setStatus).toHaveBeenCalledTimes(1);
    expect(service.setStatus).toHaveBeenCalledWith(PAGE_ID, PublicationStatus.published, ACTOR_ID);
  });

  it('unpublish: актёр из токена, цель из адреса, статус — draft', async () => {
    const { controller, service } = makeController();

    await controller.unpublish(Language.en, PAGE_ID, request);

    expect(service.setStatus).toHaveBeenCalledTimes(1);
    expect(service.setStatus).toHaveBeenCalledWith(PAGE_ID, PublicationStatus.draft, ACTOR_ID);
  });
});
