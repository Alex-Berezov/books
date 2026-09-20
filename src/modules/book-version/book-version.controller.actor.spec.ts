import { BookVersionController } from './book-version.controller';
import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { GeoIpCountryService } from '../geo-block/geo-ip-country.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';

/**
 * 🔴 `LEGACY-015`. Журнал административных действий отвечает на вопрос «кто», и место,
 * где в этот ответ подставляется актёр, ровно одно — проводка аргументов в контроллере.
 *
 * ⚠️ Посадка нужна именно здесь: сервис получает `actorUserId` уже готовым и подмены
 * не увидит ни одной своей спекой. Подмена при этом дешёвая и правдоподобная — взять
 * `id` версии из адреса вместо `request.user.userId`: код собирается, все сервисные
 * тесты остаются зелёными, а событие публикации оказывается приписано самой версии.
 *
 * ⚠️ Поэтому идентификаторы актёра и цели в фикстурах обязаны различаться (`L-004`):
 * совпади они — подмена перестала бы ронять эти тесты.
 *
 * Тот же приём и та же причина, что у `users.controller.spec.ts`; здесь закрыта вторая
 * пара путей — публикация и снятие с публикации.
 */
describe('BookVersionController — актёр журнала берётся из токена', () => {
  const ACTOR_ID = 'admin-actor-1';
  const VERSION_ID = 'version-2';

  const request = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  const makeController = () => {
    const service = {
      publish: jest.fn().mockResolvedValue({ id: VERSION_ID, status: 'published' }),
      unpublish: jest.fn().mockResolvedValue({ id: VERSION_ID, status: 'draft' }),
    };

    const controller = new BookVersionController(
      service as unknown as BookVersionService,
      {} as PublicationGateService,
      {} as RightsContentHashService,
      {} as GeoIpCountryService,
      {} as GeoBlockRuleService,
      {} as RightsLicenseCoverageService,
      {} as RightsClaimsService,
      {} as ModeratorRolesService,
    );

    return { controller, service };
  };

  it('publish: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.publish(VERSION_ID, request);

    expect(service.publish).toHaveBeenCalledTimes(1);
    expect(service.publish).toHaveBeenCalledWith(VERSION_ID, ACTOR_ID);
  });

  it('unpublish: актёр берётся из токена, цель — из адреса', async () => {
    const { controller, service } = makeController();

    await controller.unpublish(VERSION_ID, request);

    expect(service.unpublish).toHaveBeenCalledTimes(1);
    expect(service.unpublish).toHaveBeenCalledWith(VERSION_ID, ACTOR_ID);
  });
});
