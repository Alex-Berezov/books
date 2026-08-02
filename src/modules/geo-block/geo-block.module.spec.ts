import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockRuleService } from './geo-block-rule.service';
import { GeoBlockModule } from './geo-block.module';
import { GeoIpCountryService } from './geo-ip-country.service';

/**
 * DI smoke test для фазы 12 (R0-04).
 *
 * Ветка runtime enforcement стоит выше ядра: она импортирует претензии и резолвер действующего
 * клиренса, но ни ядро, ни его потребители не имеют права импортировать её обратно. Убрать
 * `RightsClearanceModule` из `imports` — и первый кейс краснеет, потому что генерация правил
 * перестаёт резолвить резолвер; добавить сюда `RightsIntakeModule` — краснеет второй (ADR-003).
 */
describe('GeoBlockModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), GeoBlockModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(GeoBlockRuleService)).toBeDefined();
    expect(moduleRef.get(GeoIpCountryService)).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic and never reaches back into the rights core', () => {
    const reachable = collectTransitiveImports(GeoBlockModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(GeoBlockModule);
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
