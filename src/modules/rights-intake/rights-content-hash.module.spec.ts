import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsContentHashModule } from './rights-content-hash.module';
import { RightsContentHashService } from './rights-content-hash.service';
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

    await moduleRef.close();
  });
});
