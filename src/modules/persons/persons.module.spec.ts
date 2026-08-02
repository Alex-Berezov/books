import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { PersonResolverService } from './person-resolver.service';
import { PersonsModule } from './persons.module';
import { PersonsService } from './persons.service';

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
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PersonsModule],
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
