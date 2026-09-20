import { Module } from '@nestjs/common';
import { PagesService } from './pages.service';
import { PagesController } from './pages.controller';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';

/**
 * ⚠️ `AdminAuditModule` (`LEGACY-015`, пачка `T21`) импортирован **явно**, хотя список
 * импортов у модуля до этого был пуст: `SlugRedirectModule` виден `PagesService` только
 * потому, что объявлен `@Global()`, а глобальный модуль доступен лишь тому, кто поднят
 * вместе с `AppModule`. `AdminAuditModule` глобальным быть не должен по своему докблоку —
 * писателей журнала видно по импортам, — поэтому здесь он назван.
 */
@Module({
  imports: [AdminAuditModule],
  controllers: [PagesController],
  providers: [PagesService],
  exports: [PagesService],
})
export class PagesModule {}
