import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClearanceResolverService } from './rights-clearance-resolver.service';
import { RightsClearanceModule } from './rights-clearance.module';

/**
 * DI smoke test. The module is imported by the publication gate, geo-block and license coverage —
 * three modules on different levels of the graph — so it has to stay resolvable on its own. A new
 * dependency here would either break this test or introduce the cycle the module exists to avoid.
 */
describe('RightsClearanceModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RightsClearanceModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsClearanceResolverService)).toBeDefined();

    await moduleRef.close();
  });
});
