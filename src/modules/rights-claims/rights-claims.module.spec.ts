import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { RightsClaimEnforcementService } from './rights-claim-enforcement.service';
import { RightsClaimsModule } from './rights-claims.module';
import { RightsClaimsService } from './rights-claims.service';

/**
 * DI smoke test для фазы 16 (R0-04).
 *
 * Модуль не импортирует ничего: претензии обязаны оставаться листом графа, потому что их
 * импортирует `GeoBlockModule` — ветка runtime enforcement. Добавить сюда `GeoBlockModule`
 * (или что-либо, что до него дотягивается) — и второй кейс краснеет. Первый кейс ловит
 * незарегистрированный провайдер: `RightsClaimsController` тянет `RolesGuard`, а тот —
 * `ConfigService` и `PrismaService` (ADR-003).
 */
describe('RightsClaimsModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), RightsClaimsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsClaimsService)).toBeDefined();
    expect(moduleRef.get(RightsClaimEnforcementService)).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic and never reaches back into geo-block', () => {
    const reachable = collectTransitiveImports(RightsClaimsModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(RightsClaimsModule);
    expect(reachable).not.toContain(GeoBlockModule);
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
