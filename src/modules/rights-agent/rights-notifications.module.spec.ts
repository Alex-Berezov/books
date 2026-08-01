import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsModule } from './rights-notifications.module';
import { RightsNotificationsService } from './rights-notifications.service';

/**
 * DI smoke test. Модуль существует ровно затем, чтобы ядро (`RightsIntakeModule`) могло писать
 * уведомления, не импортируя `RightsAgentModule`, который импортирует ядро (WP-6.3, R9-02).
 * Любая новая зависимость здесь либо уронит этот тест, либо вернёт тот самый цикл.
 */
describe('RightsNotificationsModule', () => {
  it('compiles on its own with nothing but Prisma', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RightsNotificationsModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsNotificationsService)).toBeDefined();

    await moduleRef.close();
  });
});
