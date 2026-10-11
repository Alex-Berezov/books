import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ModeratorRolesModule } from '../../common/roles/moderator-roles.module';
import { CacheModule } from '../../shared/cache/cache.module';
import { CACHE_SERVICE } from '../../shared/cache/cache.interface';
import { INMEMORY_CACHE_MAX_ENTRIES } from '../../shared/cache/inmemory.cache';
import { UploadsModule } from './uploads.module';
import { UploadsService } from './uploads.service';
import { UploadType } from './dto/presign.dto';

/**
 * `LEGACY-460`: общий кэш при упоре в потолок вытесняет старейшие записи. Upload-токены живут
 * в своём экземпляре — поток анонимных ключей в общий кэш (`GET /views/aggregate`) их не уносит.
 */
describe('UploadsModule: upload tokens survive a flood of the shared cache', () => {
  it('a presign token stays live after the shared cache overflows', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        ModeratorRolesModule,
        CacheModule,
        UploadsModule,
      ],
    }).compile();
    const uploads = moduleRef.get(UploadsService);
    // `strict: true` — иначе `get` ищет по всему контейнеру и может вернуть экземпляр `UploadsModule`.
    const shared = moduleRef
      .select(CacheModule)
      .get<{ set: (k: string, v: unknown) => Promise<void> }>(CACHE_SERVICE, { strict: true });
    expect(shared).not.toBe(moduleRef.select(UploadsModule).get(CACHE_SERVICE, { strict: true }));

    const { token } = await uploads.presign(
      { type: UploadType.cover, contentType: 'image/jpeg', size: 1000 },
      'user-1',
    );
    for (let i = 0; i < INMEMORY_CACHE_MAX_ENTRIES * 2; i += 1) {
      await shared.set(`views:agg:${i}`, i);
    }

    await expect(uploads.directUploadBodyLimit(token)).resolves.toBe(1100);
    await moduleRef.close();
  });
});
