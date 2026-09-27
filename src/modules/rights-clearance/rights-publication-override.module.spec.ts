import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { RightsPublicationOverrideController } from './rights-publication-override.controller';
import { RightsPublicationOverrideModule } from './rights-publication-override.module';

/**
 * DI smoke test. `ConfigModule` stands in for the app's global one: the controller's `RolesGuard`
 * reads it, as every guarded controller does.
 */
describe('RightsPublicationOverrideModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({ isGlobal: true }),
        RightsPublicationOverrideModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsPublicationOverrideController)).toBeDefined();

    await moduleRef.close();
  });
});
