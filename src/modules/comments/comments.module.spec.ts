import { ModeratorRolesModule } from '../../common/roles/moderator-roles.module';
import { describeDiSmoke } from '../../common/testing/di-smoke';
import { CommentsModule } from './comments.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';

// `ModeratorRolesModule` объявлен `@Global()` в приложении — в тестовом
// контейнере глобальность не наследуется, поэтому подаётся явно.
describeDiSmoke('CommentsModule', () => [PrismaModule, ModeratorRolesModule, CommentsModule]);
