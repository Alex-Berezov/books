import { AdminAuditAction, AdminAuditTargetType } from '@prisma/client';
import { AdminAuditService } from './admin-audit.service';
import type { Prisma } from '@prisma/client';

/**
 * Посадка общего писателя журнала (`LEGACY-180`, решение арбитра 12.09.2026).
 *
 * Сторож перечня писателей (`src/common/testing/admin-audit-writers.spec.ts`) держит,
 * что записи идут через `tx`, разбором исходника. Здесь проверяется само поведение:
 * писатель пишет ровно тем клиентом, который ему передали, и не имеет второго пути
 * записи на случай, если клиента забыли (`LEGACY-036`).
 */
describe('AdminAuditService', () => {
  const service = new AdminAuditService();

  const txWith = (create: jest.Mock) =>
    ({ adminAuditEvent: { create } }) as unknown as Prisma.TransactionClient;

  it('пишет событие переданным клиентом транзакции', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'audit-1' });

    await service.record(txWith(create), {
      action: AdminAuditAction.VERSION_UNPUBLISHED,
      targetType: AdminAuditTargetType.BOOK_VERSION,
      targetId: 'v1',
      actorUserId: 'admin-7',
      payload: { rightsLicenseIds: ['lic-A'] },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        actorUserId: 'admin-7',
        action: AdminAuditAction.VERSION_UNPUBLISHED,
        targetType: AdminAuditTargetType.BOOK_VERSION,
        targetId: 'v1',
        payload: { rightsLicenseIds: ['lic-A'] },
      },
    });
  });

  /**
   * Событие без актёра пишется, но это не «по умолчанию никто»: `actorUserId`
   * обязателен в типе и `null` в него кладётся осознанно — для путей без запроса
   * (сид, фоновая задача). Поле остаётся в `data`, чтобы выборка «чьи действия»
   * не отличала «не было актёра» от «ключ не писали».
   */
  it('кладёт actorUserId даже когда он null', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'audit-2' });

    await service.record(txWith(create), {
      action: AdminAuditAction.VERSION_UNPUBLISHED,
      targetType: AdminAuditTargetType.BOOK_VERSION,
      targetId: 'v2',
      actorUserId: null,
    });

    const data = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('actorUserId', null);
    // Ключа `payload` при отсутствии снимка в запросе быть не должно вовсе: `undefined`
    // в Json-колонке Prisma отвергает, а `JsonNull` означал бы записанный пустой снимок.
    expect(data).not.toHaveProperty('payload');
  });

  it('пробрасывает отказ записи наружу, а не глушит его', async () => {
    const dbDown = new Error('db down');
    const create = jest.fn().mockRejectedValue(dbDown);

    await expect(
      service.record(txWith(create), {
        action: AdminAuditAction.VERSION_UNPUBLISHED,
        targetType: AdminAuditTargetType.BOOK_VERSION,
        targetId: 'v3',
        actorUserId: 'admin-7',
      }),
    ).rejects.toBe(dbDown);
  });
});
