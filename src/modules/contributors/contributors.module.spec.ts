import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { ContributorsModule } from './contributors.module';
import { ContributorsService } from './contributors.service';

/**
 * DI smoke test для участников фазы 14 (R0-04).
 *
 * Участники мутируют состав кредитов, который входит в content hash клиренса, поэтому им нужен
 * `RightsContentHashModule` — но именно как лист графа: ядро (`RightsIntakeModule`) импортирует
 * персон, а участники импортируют персон, и прямая ссылка отсюда на ядро замкнула бы граф
 * (WP-8.1). Убрать `RightsContentHashModule` или `PersonsModule` из `imports` — краснеет первый
 * кейс, добавить `RightsIntakeModule` — второй (ADR-003).
 */
describe('ContributorsModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ContributorsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(ContributorsService)).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic and never reaches back into the rights core', () => {
    const reachable = collectTransitiveImports(ContributorsModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(ContributorsModule);
    expect(reachable).not.toContain(RightsIntakeModule);
  });
});

/**
 * Обход метаданных `imports` вширь. `undefined` в результате оставляет циклический require: при
 * цикле модуль-константа ещё не инициализирована в момент выполнения декоратора, и в массиве
 * `imports` остаётся дыра. Поэтому `undefined` не пропускается, а попадает в множество и
 * проверяется тестом наравне с самой ссылкой на модуль.
 */
function collectTransitiveImports(root: unknown): Set<unknown> {
  const visited = new Set<unknown>();
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    const imports = (Reflect.getMetadata('imports', current as object) as unknown[]) ?? [];
    for (const imported of imports) {
      if (visited.has(imported)) continue;
      visited.add(imported);
      if (imported !== undefined) queue.push(imported);
    }
  }
  return visited;
}
