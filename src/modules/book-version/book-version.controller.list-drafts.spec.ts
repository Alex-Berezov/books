import { Reflector } from '@nestjs/core';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { BookVersionController } from './book-version.controller';
import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { GeoIpCountryService } from '../geo-block/geo-ip-country.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PUBLIC_BOOK_VERSION_SELECT } from '../../common/selects/public-book.select';
import { NO_PUBLIC_CACHE } from '../../common/decorators/no-public-cache.decorator';
import { PublicCacheInterceptor } from '../../common/interceptors/public-cache.interceptor';

/**
 * `GET /books/:bookId/versions?includeDrafts=true` уходил в `service.listAdmin`
 * без единой проверки: гвардов на маршруте нет, глобального auth-гварда в
 * приложении тоже. Анониму уезжали черновики и весь правовой контур версии —
 * `listAdmin` тянет строку через `include`, то есть все 66 полей, из них 29
 * `rights*` (`LEGACY-090`).
 *
 * Здесь проверяются обе ветки: модератор получает админский листинг, все
 * остальные — включая анонима — молча уходят в публичный `list()`. Молча, а не
 * через 401/403: адрес публичный, код ответа существующей ручки менять нельзя.
 */
describe('BookVersionController — includeDrafts видит только модератор', () => {
  const bookId = 'a1111111-b222-4c33-d444-555555555555';

  /** Публичная строка: ровно белый список полей, ничего сверх. */
  const publicRow = Object.fromEntries(
    Object.keys(PUBLIC_BOOK_VERSION_SELECT).map((field) => [field, `${field}-value`]),
  ) as Record<string, unknown>;

  /** Админская строка: черновик со «внутренним» правовым контуром. */
  const adminDraftRow = {
    ...publicRow,
    status: 'draft',
    rightsProfileId: 'rp-1',
    rightsStatusRu: 'на проверке',
    rightsPendingCountryCodes: ['DE', 'FR'],
    rightsContentHashInput: 'полный снимок контента',
    rightsGeoBlockVerifiedByUserId: 'staff-7',
  };

  const makeController = (isModerator: boolean) => {
    const service = {
      list: jest.fn().mockResolvedValue([{ ...publicRow, status: 'published' }]),
      listAdmin: jest.fn().mockResolvedValue([adminDraftRow]),
    };
    const moderatorRoles = { isModerator: jest.fn().mockResolvedValue(isModerator) };

    const controller = new BookVersionController(
      service as unknown as BookVersionService,
      {} as PublicationGateService,
      {} as RightsContentHashService,
      {} as GeoIpCountryService,
      {} as GeoBlockRuleService,
      {} as RightsLicenseCoverageService,
      {} as RightsClaimsService,
      moderatorRoles as unknown as ModeratorRolesService,
    );

    return { controller, service, moderatorRoles };
  };

  it('анониму с includeDrafts=true отдаёт публичный список без черновиков и без правовых полей', async () => {
    const { controller, service } = makeController(false);

    const result = (await controller.list(
      bookId,
      undefined,
      undefined,
      undefined,
      'true',
      'en',
      undefined,
    )) as Record<string, unknown>[];

    expect(service.listAdmin).not.toHaveBeenCalled();
    expect(service.list).toHaveBeenCalledTimes(1);
    expect(service.list).toHaveBeenCalledWith(
      bookId,
      { language: undefined, type: undefined, isFree: undefined },
      'en',
    );

    expect(result.every((item) => item.status === 'published')).toBe(true);
    const leaked = result.flatMap((item) =>
      Object.keys(item).filter((field) => field.toLowerCase().startsWith('rights')),
    );
    expect(leaked).toEqual([]);
  });

  it('пользователю без роли модератора включение черновиков тоже не помогает', async () => {
    const { controller, service, moderatorRoles } = makeController(false);

    await controller.list(bookId, undefined, undefined, undefined, 'true', undefined, {
      user: { userId: 'u-1', email: 'reader@example.com' },
    });

    expect(moderatorRoles.isModerator).toHaveBeenCalledTimes(1);
    expect(moderatorRoles.isModerator).toHaveBeenCalledWith({
      userId: 'u-1',
      email: 'reader@example.com',
    });
    expect(service.listAdmin).not.toHaveBeenCalled();
    expect(service.list).toHaveBeenCalledTimes(1);
  });

  it('модератору с includeDrafts=true отдаёт админский листинг с черновиками', async () => {
    const { controller, service } = makeController(true);

    const result = (await controller.list(bookId, 'en', 'text', 'true', 'true', 'en', {
      user: { userId: 'u-9', email: 'admin@example.com' },
    })) as Record<string, unknown>[];

    expect(service.list).not.toHaveBeenCalled();
    expect(service.listAdmin).toHaveBeenCalledTimes(1);
    expect(service.listAdmin).toHaveBeenCalledWith(bookId, {
      language: 'en',
      type: 'text',
      isFree: true,
    });
    expect(result[0].status).toBe('draft');
    expect(result[0].rightsContentHashInput).toBe('полный снимок контента');
  });

  it('без includeDrafts роль не спрашивается — это обычный публичный запрос', async () => {
    const { controller, service, moderatorRoles } = makeController(true);

    await controller.list(bookId, undefined, undefined, undefined, undefined, 'ru', undefined);

    expect(moderatorRoles.isModerator).not.toHaveBeenCalled();
    expect(service.listAdmin).not.toHaveBeenCalled();
    expect(service.list).toHaveBeenCalled();
  });

  /**
   * Ответ этой ручки зависит от предъявленного токена, а ключ общего кэша —
   * один URL. Пометка персонального ответа делается ровно двумя декораторами:
   * `PublicCacheInterceptor` ставит заголовки, `@NoPublicCache()` говорит ему,
   * какие именно (`private, no-store` + `Vary: Authorization`). Снятие любого
   * из них возвращает `LEGACY-090` через кэш: админский ответ достанется
   * анониму, пришедшему по тому же адресу.
   *
   * Заголовки здесь не проверяются — для них нужен HTTP-стенд; проверяется, что
   * обе метки лежат на обработчике, а не потерялись при правке декораторов.
   */
  describe('пометка персонального ответа', () => {
    // Через дескриптор, а не `prototype.list`: метаданные лежат на самой функции,
    // а прямая ссылка на метод класса — это `unbound-method` в линте.
    const handler = Object.getOwnPropertyDescriptor(BookVersionController.prototype, 'list')
      ?.value as (...args: unknown[]) => unknown;

    it('обработчик помечен @NoPublicCache()', () => {
      expect(new Reflector().get<boolean>(NO_PUBLIC_CACHE, handler)).toBe(true);
    });

    it('на обработчике висит PublicCacheInterceptor, а не на классе', () => {
      const onHandler = Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as
        | unknown[]
        | undefined;
      const onClass = Reflect.getMetadata(INTERCEPTORS_METADATA, BookVersionController) as
        | unknown[]
        | undefined;

      expect(onHandler).toContain(PublicCacheInterceptor);
      expect(onClass ?? []).not.toContain(PublicCacheInterceptor);
    });
  });
});
