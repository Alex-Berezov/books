import { ContributorsController } from './contributors.controller';
import { ContributorsService } from './contributors.service';

/**
 * 🔴 `LEGACY-015`, пачка `T21`. Журнал административных действий отвечает на вопрос
 * «кто», и место, где в этот ответ подставляется актёр, ровно одно — проводка
 * аргументов в контроллере.
 *
 * ⚠️ Отдельным файлом, а не кейсом в общей спеке контроллера: посадки актёра по всему
 * репозиторию лежат под маской `*.controller.actor.spec.ts` (их восемь), и следующая
 * пачка журнала будет искать их именно так. Кейс, спрятанный в общей спеке, в эту
 * выборку не попадёт — его примут за отсутствующий и заведут вторую посадку.
 *
 * ⚠️ Путь двухступенчатый: `ContributorsService.remove` — чистый делегат в
 * `PersonsService.remove`, где под замком и пишется `PERSON_DELETED`. Актёр обязан
 * пройти обе ступени, и проверка первой живёт здесь.
 *
 * ⚠️ Идентификаторы актёра и цели различаются намеренно (`L-004`): с одинаковыми
 * подмена `req.user.userId` на `id` из адреса осталась бы зелёной.
 */
describe('ContributorsController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const CONTRIBUTOR_ID = 'contributor-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      remove: jest.fn().mockResolvedValue({ id: CONTRIBUTOR_ID }),
    };

    const controller = new ContributorsController(service as unknown as ContributorsService);

    return { controller, service };
  };

  it('remove: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.remove(CONTRIBUTOR_ID, request);

    expect(service.remove).toHaveBeenCalledTimes(1);
    expect(service.remove).toHaveBeenCalledWith(CONTRIBUTOR_ID, ACTOR_ID);
  });
});
