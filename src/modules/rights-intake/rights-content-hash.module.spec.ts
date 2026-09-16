import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsContentHashModule } from './rights-content-hash.module';
import { RightsContentHashService } from './rights-content-hash.service';
import { RightsClearanceLockService } from './rights-clearance-lock.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * DI smoke test. Модуль импортируют персоны, участники, главы и гейт публикации — уровни
 * графа, между которыми уже есть зависимости. Новая зависимость здесь либо сломает этот тест,
 * либо вернёт цикл, ради обхода которого лист и создан.
 */
describe('RightsContentHashModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, RightsContentHashModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsContentHashService)).toBeDefined();
    // LEGACY-368: главы и версии получают замок группы через реэкспорт этого листа.
    expect(moduleRef.get(RightsClearanceLockService)).toBeInstanceOf(RightsClearanceLockService);

    await moduleRef.close();
  });
});
