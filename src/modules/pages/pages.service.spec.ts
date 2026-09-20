import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PagesService } from './pages.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import {
  AdminAuditAction,
  AdminAuditTargetType,
  Language,
  PublicationStatus,
} from '@prisma/client';

type PrismaStub = {
  page: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    groupBy: jest.Mock;
    updateMany: jest.Mock;
  };
  seo: { findUnique: jest.Mock };
  adminAuditEvent: { create: jest.Mock };
  $transaction: jest.Mock;
};

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    page: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      groupBy: jest.fn(),
      updateMany: jest.fn(),
    },
    seo: { findUnique: jest.fn() },
    adminAuditEvent: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  // Транзакция отдаёт тот же стаб как `tx`: запись истории слагов обязана идти
  // внутри неё, и подмена клиента здесь скрыла бы нарушение этого порядка.
  stub.$transaction.mockImplementation(async (callback: unknown) => {
    if (typeof callback === 'function') {
      return (callback as (tx: PrismaStub) => Promise<unknown>)(stub);
    }
    return callback;
  });

  return stub;
};

const createSlugRedirectStub = () => ({
  record: jest.fn().mockResolvedValue(undefined),
  recordBaseSlugChange: jest.fn().mockResolvedValue(undefined),
  resolve: jest.fn().mockResolvedValue(null),
  cleanupDeadRedirects: jest.fn().mockResolvedValue(undefined),
});

describe('PagesService (unit)', () => {
  let service: PagesService;
  let prisma: PrismaStub;
  let slugRedirects: ReturnType<typeof createSlugRedirectStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    slugRedirects = createSlugRedirectStub();
    // Писатель журнала — **настоящий**, а не мок: он и есть проверяемое поведение
    // (`LEGACY-015`). Мок подтвердил бы только то, что его позвали.
    service = new PagesService(
      prisma as unknown as PrismaService,
      slugRedirects as unknown as SlugRedirectService,
      new AdminAuditService(),
    );
  });

  describe('adminListGrouped (LEGACY-371: search and status filter)', () => {
    const whereOfGroupBy = (call: number): Record<string, unknown> =>
      (prisma.page.groupBy.mock.calls[call][0] as { where: Record<string, unknown> }).where;

    beforeEach(() => {
      prisma.page.groupBy.mockResolvedValue([]);
      prisma.page.findMany.mockResolvedValue([]);
    });

    it('filters nothing but the missing group id when neither field is given', async () => {
      await service.adminListGrouped(1, 20);

      expect(whereOfGroupBy(0)).toEqual({ translationGroupId: { not: null } });
      // страница и её итог обязаны считаться по одному условию, иначе
      // `totalPages` описывает не тот набор, который отдан в `data`
      expect(whereOfGroupBy(1)).toEqual(whereOfGroupBy(0));
    });

    it('escapes LIKE wildcards so that "100%_off" is a term, not a pattern', async () => {
      await service.adminListGrouped(1, 20, '100%_off');

      expect(whereOfGroupBy(0)).toEqual({
        translationGroupId: { not: null },
        OR: [
          { title: { contains: String.raw`100\%\_off`, mode: 'insensitive' } },
          { slug: { contains: String.raw`100\%\_off`, mode: 'insensitive' } },
        ],
      });
    });

    it('drops a search that is only whitespace instead of matching every row', async () => {
      await service.adminListGrouped(1, 20, '   ');

      expect(whereOfGroupBy(0)).toEqual({ translationGroupId: { not: null } });
    });

    it('combines status with search instead of replacing it', async () => {
      await service.adminListGrouped(1, 20, 'about', PublicationStatus.draft);

      expect(whereOfGroupBy(0)).toEqual({
        translationGroupId: { not: null },
        OR: [
          { title: { contains: 'about', mode: 'insensitive' } },
          { slug: { contains: 'about', mode: 'insensitive' } },
        ],
        status: PublicationStatus.draft,
      });
    });

    it('reads the translations of the selected groups without the filter', async () => {
      prisma.page.groupBy.mockResolvedValueOnce([{ translationGroupId: 'g-1' }]);

      await service.adminListGrouped(1, 20, 'about', PublicationStatus.draft);

      // фильтр отбирает строки таблицы, а не языки внутри строки: значки
      // переводов должны остаться полными у уже отобранной группы
      expect(prisma.page.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { translationGroupId: { in: ['g-1'] } } }),
      );
    });
  });

  describe('getPublicBySlug', () => {
    it('returns page by slug and language', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      const res = await service.getPublicBySlug('about', 'en' as Language);
      expect(res).toEqual({ id: 'p1', slug: 'about', language: 'en' });
      expect(prisma.page.findFirst).toHaveBeenCalledWith({
        where: { slug: 'about', language: 'en', status: 'published' },
        include: { seo: true },
      });
    });

    it('throws 404 when not found', async () => {
      prisma.page.findFirst.mockResolvedValueOnce(null);
      await expect(service.getPublicBySlug('about', 'en' as Language)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setStatus (publish/unpublish)', () => {
    // Маркер намеренно не повторяет вход кейса: сверка с консервой, собранной из тех же
    // значений, что и аргументы вызова, не провалилась бы ни при каком поведении (`L-007`).
    // Здесь утверждение проверяемое — вернуться обязана именно прочитанная строка.
    const PAGE_ROW = { id: 'p1', status: 'published', marker: 'from-find-unique' };

    it('updates status when page exists', async () => {
      prisma.page.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.page.findUnique.mockResolvedValueOnce(PAGE_ROW);
      const res = await service.setStatus('p1', 'published' as PublicationStatus, 'admin-1');
      expect(res).toBe(PAGE_ROW);
      // Запись условная: целевое состояние стоит в `where`, а не только в `data`,
      // поэтому «уже опубликована» отличается от «опубликовали» самим `count`.
      expect(prisma.page.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.page.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', status: { not: 'published' } },
        data: { status: 'published' },
      });
    });

    it('throws 404 when page not found', async () => {
      prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.page.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.setStatus('p1', 'published' as PublicationStatus, 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * `LEGACY-015`, пачка `T21`. Состав проверяется `toEqual`, а не `toMatchObject`:
     * лишнее поле в журнале так же неверно, как потерянное. `payload` у этих двух
     * событий нет вовсе — строка жива, её язык и слаг читаются из неё самой.
     */
    it('пишет PAGE_PUBLISHED, когда страница действительно опубликована', async () => {
      prisma.page.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', status: 'published' });

      await service.setStatus('p1', 'published' as PublicationStatus, 'admin-1');

      expect(prisma.adminAuditEvent.create).toHaveBeenCalledTimes(1);
      const [call] = prisma.adminAuditEvent.create.mock.calls as Array<[{ data: unknown }]>;
      expect(call[0].data).toEqual({
        actorUserId: 'admin-1',
        action: AdminAuditAction.PAGE_PUBLISHED,
        targetType: AdminAuditTargetType.PAGE,
        targetId: 'p1',
      });
    });

    it('пишет PAGE_UNPUBLISHED на обратном переходе', async () => {
      prisma.page.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', status: 'draft' });

      await service.setStatus('p1', 'draft' as PublicationStatus, 'admin-1');

      const [call] = prisma.adminAuditEvent.create.mock.calls as Array<[{ data: unknown }]>;
      expect(call[0].data).toEqual({
        actorUserId: 'admin-1',
        action: AdminAuditAction.PAGE_UNPUBLISHED,
        targetType: AdminAuditTargetType.PAGE,
        targetId: 'p1',
      });
    });

    /**
     * Инвариант докблока `AdminAuditEvent`: событие равно изменению состояния.
     * Повторная публикация уже опубликованной страницы ничего не меняет — значит
     * и строки в журнале быть не должно, иначе `PAGE_PUBLISHED` перестаёт означать
     * «страница стала видна» и на вопрос «когда» журнал отдаёт столько ответов,
     * сколько раз нажали кнопку.
     */
    it('не пишет события на повторной публикации: состояние не изменилось', async () => {
      prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.page.findUnique.mockResolvedValueOnce(PAGE_ROW);

      const res = await service.setStatus('p1', 'published' as PublicationStatus, 'admin-1');

      // Контракт ручки при этом прежний: 200 и то же тело, просто без строки в журнале.
      expect(res).toBe(PAGE_ROW);
      expect(prisma.adminAuditEvent.create).not.toHaveBeenCalled();
    });

    it('не пишет события, когда страницы нет вовсе', async () => {
      prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.page.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.setStatus('p1', 'published' as PublicationStatus, 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.adminAuditEvent.create).not.toHaveBeenCalled();
    });

    it('открывает транзакцию с явными границами', async () => {
      prisma.page.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', status: 'published' });

      await service.setStatus('p1', 'published' as PublicationStatus, 'admin-1');

      const [, options] = prisma.$transaction.mock.calls[0] as [unknown, unknown];
      expect(options).toEqual({ timeout: 30_000, maxWait: 10_000 });
    });
  });

  /**
   * 🔴 `LEGACY-015`, пачка `T21`, третий вход. Видимость страницы меняет не только пара
   * выделенных ручек `publish`/`unpublish`, но и общая форма редактирования: у
   * `UpdatePageDto` есть поле `status`. Критерий админского действия называет основанием
   * смену публичной видимости как действие, а не конкретный маршрут (решение арбитра
   * 20.09.2026), поэтому событие обязано писаться и здесь.
   *
   * ⚠️ Признак изменения даёт результат условной записи `updateMany`, а не сравнение
   * прежнего статуса с новым в коде (`L-019`): между чтением и записью замка нет.
   */
  describe('update: смена status формой пишет те же события видимости', () => {
    const dtoWith = (status?: 'draft' | 'published', extra: Record<string, unknown> = {}) =>
      ({
        ...extra,
        ...(status === undefined ? {} : { status }),
      }) as unknown as import('./dto/update-page.dto').UpdatePageDto;

    // Маркер намеренно не совпадает ни с одним входом кейса: сверка с ним показывает,
    // что сервис вернул результат **общего** `update`, а не условной записи статуса
    // и не прочитанный до транзакции `exists`. Сверка с консервой, повторяющей вход,
    // не провалилась бы ни при каком поведении (`L-007`).
    const FORM_RESULT = { id: 'p1', status: 'published', marker: 'from-page-update' };

    const arrangeUpdate = () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      prisma.page.update.mockResolvedValueOnce(FORM_RESULT);
    };

    it('пишет ровно одно PAGE_PUBLISHED, когда форма действительно публикует', async () => {
      arrangeUpdate();
      prisma.page.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.update('p1', dtoWith('published'), 'admin-1');

      expect(prisma.page.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.page.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', status: { not: 'published' } },
        data: { status: 'published' },
      });
      expect(prisma.adminAuditEvent.create).toHaveBeenCalledTimes(1);
      const [call] = prisma.adminAuditEvent.create.mock.calls as Array<[{ data: unknown }]>;
      expect(call[0].data).toEqual({
        actorUserId: 'admin-1',
        action: AdminAuditAction.PAGE_PUBLISHED,
        targetType: AdminAuditTargetType.PAGE,
        targetId: 'p1',
      });
    });

    it('пишет PAGE_UNPUBLISHED на обратном переходе формой', async () => {
      arrangeUpdate();
      prisma.page.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.update('p1', dtoWith('draft'), 'admin-1');

      expect(prisma.adminAuditEvent.create).toHaveBeenCalledTimes(1);
      const [call] = prisma.adminAuditEvent.create.mock.calls as Array<[{ data: unknown }]>;
      expect(call[0].data).toEqual({
        actorUserId: 'admin-1',
        action: AdminAuditAction.PAGE_UNPUBLISHED,
        targetType: AdminAuditTargetType.PAGE,
        targetId: 'p1',
      });
    });

    it('не пишет события, когда форма прислала тот же статус', async () => {
      arrangeUpdate();
      prisma.page.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.update('p1', dtoWith('published'), 'admin-1');

      expect(prisma.adminAuditEvent.create).not.toHaveBeenCalled();
    });

    /**
     * Правка заголовка — не смена видимости. Без этого кейса условие
     * `dto.status !== undefined` можно было бы снять, и любая правка формы писала бы
     * событие публикации: `updateMany` с `status: { not: undefined }` совпал бы
     * с любой строкой.
     */
    it('не трогает статус и не пишет события, когда поля status в форме нет', async () => {
      arrangeUpdate();

      await service.update('p1', dtoWith(undefined, { title: 'Renamed' }), 'admin-1');

      expect(prisma.page.updateMany).not.toHaveBeenCalled();
      expect(prisma.adminAuditEvent.create).not.toHaveBeenCalled();
    });

    /**
     * Контракт ручки не изменился: тело ответа несёт новый статус. Условная запись
     * идёт **до** общего `update`, поэтому он читает строку уже обновлённой.
     */
    it('возвращает результат общего update, и он идёт после условной записи', async () => {
      arrangeUpdate();
      prisma.page.updateMany.mockResolvedValueOnce({ count: 1 });

      const res = await service.update('p1', dtoWith('published'), 'admin-1');

      // Именно `toBe`: вернуться обязан тот самый объект, который отдал `tx.page.update`.
      expect(res).toBe(FORM_RESULT);
      // Порядок — вторая половина утверждения: общий `update` читает строку уже
      // после смены статуса, поэтому тело ответа несёт новый статус. Что оно его
      // действительно несёт, проверяет e2e на живой базе — мок такого не покажет.
      const statusCallOrder = prisma.page.updateMany.mock.invocationCallOrder[0];
      const formCallOrder = prisma.page.update.mock.invocationCallOrder[0];
      expect(statusCallOrder).toBeLessThan(formCallOrder);
    });
  });

  describe('reserved slugs', () => {
    it('refuses to create a page whose slug a frontend route already owns', async () => {
      await expect(
        service.create(
          {
            slug: 'catalog',
            title: 'Catalog',
            type: 'generic',
            content: '',
          } as unknown as import('./dto/create-page.dto').CreatePageDto,
          'en' as Language,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.page.create).not.toHaveBeenCalled();
    });

    it('is case- and whitespace-insensitive', async () => {
      await expect(
        service.create(
          {
            slug: '  CATALOG ',
            title: 'Catalog',
            type: 'generic',
            content: '',
          } as unknown as import('./dto/create-page.dto').CreatePageDto,
          'en' as Language,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.page.create).not.toHaveBeenCalled();
    });

    it('leaves ordinary slugs alone', async () => {
      prisma.page.create.mockResolvedValueOnce({ id: 'p1', slug: 'about-us' });
      await service.create(
        {
          slug: 'about-us',
          title: 'About',
          type: 'generic',
          content: '',
        } as unknown as import('./dto/create-page.dto').CreatePageDto,
        'en' as Language,
      );
      expect(prisma.page.create).toHaveBeenCalled();
    });
  });

  describe('update (negative seoId cases)', () => {
    it('throws BadRequest when seoId points to non-existing SEO (pre-check)', async () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      prisma.seo.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.update(
          'p1',
          {
            seoId: 999,
          } as unknown as import('./dto/update-page.dto').UpdatePageDto,
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects renaming a page into a slug the router owns', async () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      await expect(
        service.update(
          'p1',
          {
            slug: 'catalog',
          } as unknown as import('./dto/update-page.dto').UpdatePageDto,
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Nothing may reach the database: a rejected rename must not leave a
      // SlugRedirect pointing at an address the router will never yield.
      expect(prisma.page.update).not.toHaveBeenCalled();
      expect(slugRedirects.record).not.toHaveBeenCalled();
      expect(slugRedirects.recordBaseSlugChange).not.toHaveBeenCalled();
    });

    it('still lets a page already sitting on a reserved slug be edited', async () => {
      // Such a page predates the rule. Refusing it would brick the only form its
      // owner could use to rename it away.
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'catalog', language: 'en' });
      prisma.page.findFirst.mockResolvedValueOnce(null);
      prisma.page.update.mockResolvedValueOnce({ id: 'p1', slug: 'catalog', title: 'Renamed' });

      await service.update(
        'p1',
        {
          slug: 'catalog',
          title: 'Renamed',
        } as unknown as import('./dto/update-page.dto').UpdatePageDto,
        'admin-1',
      );

      expect(prisma.page.update).toHaveBeenCalled();
    });

    it('refuses to carry a grandfathered reserved slug into another language', async () => {
      // The exemption is "leave the broken page where it is", not "let it
      // travel": moving `catalog` from en to ru mints a second unreachable
      // address in a language that was intact.
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'catalog', language: 'en' });
      await expect(
        service.update(
          'p1',
          {
            language: 'ru',
          } as unknown as import('./dto/update-page.dto').UpdatePageDto,
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.page.update).not.toHaveBeenCalled();
    });

    it('maps Prisma P2003 (Page_seoId_fkey) to BadRequest', async () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      prisma.seo.findUnique.mockResolvedValueOnce({ id: 5 }); // pass pre-check
      const err = Object.assign(new Error('fk error'), {
        code: 'P2003',
        meta: { constraint: 'Page_seoId_fkey' },
      });
      prisma.page.update.mockRejectedValueOnce(err);
      await expect(
        service.update(
          'p1',
          {
            seoId: 5,
          } as unknown as import('./dto/update-page.dto').UpdatePageDto,
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('remove (LEGACY-395)', () => {
    it('deletes the page and cleans up the redirect history on its own (language, slug)', async () => {
      prisma.page.findUnique.mockResolvedValue({
        id: 'p1',
        language: Language.en,
        slug: 'old-terms',
      });
      prisma.page.delete.mockResolvedValue({ id: 'p1' });

      const res = await service.remove('p1', 'admin-1');

      expect(res).toEqual({ success: true });
      expect(prisma.page.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
      expect(slugRedirects.cleanupDeadRedirects).toHaveBeenCalledWith(
        'page',
        [Language.en],
        'old-terms',
        prisma,
      );
    });

    it('throws NotFoundException and touches no redirect when the page does not exist', async () => {
      prisma.page.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.page.delete).not.toHaveBeenCalled();
      expect(slugRedirects.cleanupDeadRedirects).not.toHaveBeenCalled();
      expect(prisma.adminAuditEvent.create).not.toHaveBeenCalled();
    });

    /**
     * `LEGACY-015`, пачка `T21`. Адрес умирает вместе со строкой: у страницы
     * `@@unique([language, slug])` и нет преемника (`LEGACY-395`), поэтому после
     * `delete` ответить, что именно перестало существовать, можно только по `payload`.
     */
    it('пишет PAGE_DELETED с умершим адресом в payload', async () => {
      prisma.page.findUnique.mockResolvedValue({
        id: 'p1',
        language: Language.en,
        slug: 'old-terms',
      });
      prisma.page.delete.mockResolvedValue({ id: 'p1' });

      await service.remove('p1', 'admin-1');

      expect(prisma.adminAuditEvent.create).toHaveBeenCalledTimes(1);
      const [call] = prisma.adminAuditEvent.create.mock.calls as Array<[{ data: unknown }]>;
      expect(call[0].data).toEqual({
        actorUserId: 'admin-1',
        action: AdminAuditAction.PAGE_DELETED,
        targetType: AdminAuditTargetType.PAGE,
        targetId: 'p1',
        payload: { language: Language.en, slug: 'old-terms' },
      });
    });

    /**
     * Посадка на `LEGACY-036`: запись обязана уйти **клиентом транзакции**.
     *
     * ⚠️ Стенд собран отдельно намеренно. Общий `$transaction` этого файла отдаёт
     * колбэку **сам** `stub` (`tx === root`), и сверка первого аргумента там была бы
     * истинна при любом аргументе — та самая тавтология, которую поймало ревью
     * пачки `T20`. Здесь клиенты различимы, и запись мимо `tx` роняет тест.
     */
    it('пишет событие тем же tx, что и удаление, а не корневым клиентом', async () => {
      const tx = {
        page: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'p1', language: Language.en, slug: 'old-terms' }),
          delete: jest.fn().mockResolvedValue({ id: 'p1' }),
        },
        adminAuditEvent: { create: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (callback: unknown) =>
        (callback as (client: unknown) => Promise<unknown>)(tx),
      );

      await service.remove('p1', 'admin-1');

      expect(tx.adminAuditEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.adminAuditEvent.create).not.toHaveBeenCalled();
    });
  });
});
