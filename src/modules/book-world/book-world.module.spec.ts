import { ModeratorRolesModule } from '../../common/roles/moderator-roles.module';
import { describeDiSmoke } from '../../common/testing/di-smoke';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { BookWorldModule } from './book-world.module';

// `WorldBeaconRateLimitGuard` (F08-3a) берёт `RATE_LIMITER` из `RateLimitModule` в `imports` модуля:
// без этой строки модуль не соберётся, и это должно краснеть юнитом, а не лавиной e2e (`LEGACY-019`).
// `ModeratorRolesModule` в приложении `@Global()`, в тестовом контейнере подаётся явно.
describeDiSmoke('BookWorldModule', () => [PrismaModule, ModeratorRolesModule, BookWorldModule]);
