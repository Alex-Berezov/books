import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ModeratorRolesModule } from '../../common/roles/moderator-roles.module';
import { describeDiSmoke } from '../../common/testing/di-smoke';
import { UploadsModule } from './uploads.module';

// `PrismaModule` и `ModeratorRolesModule` объявлены `@Global()` в приложении, а
// в тестовом контейнере глобальность не наследуется. Здесь нужны оба:
// `UploadsController` инжектит `ModeratorRolesService` (`LEGACY-111`), а
// `RolesGuard` на его маршрутах (`LEGACY-110`) — `PrismaService`, и своих
// провайдеров с ними `UploadsModule` не объявляет. С 19.08.2026 (`LEGACY-130`)
// это не исключение, а общее правило: собственных `providers` с `PrismaService`
// не осталось ни у одного модуля, и `PrismaModule` подают все спеки, которые
// поднимают свой модуль в отдельном контейнере.
describeDiSmoke('UploadsModule', () => [PrismaModule, ModeratorRolesModule, UploadsModule]);
