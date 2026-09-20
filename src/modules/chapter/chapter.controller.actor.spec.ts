import { ChapterController } from './chapter.controller';
import { ChapterService } from './chapter.service';
import { GeoIpCountryService } from '../geo-block/geo-ip-country.service';

/**
 * 🔴 `LEGACY-015`, пачка `T19`. Журнал административных действий отвечает на вопрос
 * «кто», и место, где в этот ответ подставляется актёр, ровно одно — проводка
 * аргументов в контроллере.
 *
 * ⚠️ Посадка нужна именно здесь: сервис получает `actorUserId` уже готовым и подмены
 * не увидит ни одной своей спекой. Подмена при этом дешёвая и правдоподобная — взять
 * `id` главы из адреса вместо `req.user.userId`: код собирается, все сервисные тесты
 * остаются зелёными, а удаление главы оказывается приписано самой главе.
 *
 * ⚠️ Поэтому идентификаторы актёра и цели в фикстурах обязаны различаться (`L-004`).
 *
 * Тот же приём и та же причина, что у `book-version.controller.actor.spec.ts`
 * из пачки `V1`.
 */
describe('ChapterController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const CHAPTER_ID = 'chapter-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      remove: jest.fn().mockResolvedValue({ id: CHAPTER_ID }),
    };

    const controller = new ChapterController(
      service as unknown as ChapterService,
      {} as GeoIpCountryService,
    );

    return { controller, service };
  };

  it('remove: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.remove(CHAPTER_ID, request);

    expect(service.remove).toHaveBeenCalledTimes(1);
    expect(service.remove).toHaveBeenCalledWith(CHAPTER_ID, ACTOR_ID);
  });
});
