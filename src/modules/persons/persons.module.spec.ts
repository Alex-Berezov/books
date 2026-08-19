import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { collectTransitiveImports } from '../../common/testing/module-graph';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { PersonResolverService } from './person-resolver.service';
import { PersonsModule } from './persons.module';
import { PersonsService } from './persons.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * DI smoke test для персон (R0-04).
 *
 * Персоны — нижний уровень графа прав: их импортирует ядро (`RightsIntakeModule`) и участники.
 * Пометить клиренс устаревшим отсюда можно только через лист `RightsContentHashModule`; попытка
 * дотянуться до ядра напрямую — это тот самый цикл, ради обхода которого лист и выделен (WP-8.1).
 * Убрать `RightsContentHashModule` из `imports` — краснеет первый кейс, добавить `RightsIntakeModule` —
 * второй (ADR-003).
 */
describe('PersonsModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PersonsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(PersonsService)).toBeDefined();
    expect(moduleRef.get(PersonResolverService)).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic and never reaches back into the rights core', () => {
    const reachable = collectTransitiveImports(PersonsModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(PersonsModule);
    expect(reachable).not.toContain(RightsIntakeModule);
  });
});
