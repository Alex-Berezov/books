import { Global, Module } from '@nestjs/common';
import { BackgroundJobsRegistry } from './background-jobs.registry';

/**
 * Только реестр — без контроллера и без единой зависимости.
 *
 * 🔴 Разделение не косметическое. Механизмы регистрируются из своих модулей, и
 * импортировать ради этого модуль с HTTP-контроллером значило бы тащить за собой
 * `RolesGuard`, а с ним `PrismaService`: модули, которые компилируются в
 * изоляции (`*.module.spec.ts`), переставали собираться. Инвентарь не вправе
 * усложнять сборку тех, за кем наблюдает.
 *
 * `@Global()` — чтобы регистрация не требовала импорта вовсе; импорт в
 * конкретных модулях оставлен ради изолированной компиляции в тестах.
 */
@Global()
@Module({
  providers: [BackgroundJobsRegistry],
  exports: [BackgroundJobsRegistry],
})
export class BackgroundJobsRegistryModule {}
