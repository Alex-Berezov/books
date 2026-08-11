import { PrismaModule } from '../../shared/prisma/prisma.module';
import { describeDiSmoke } from '../../common/testing/di-smoke';
import { UploadsModule } from './uploads.module';

// `PrismaModule` объявлен `@Global()` в приложении, а в тестовом контейнере
// глобальность не наследуется. Здесь он **нужен**: `UploadsController` инжектит
// `PrismaService`, а `UploadsModule` своих провайдеров с ним не объявляет —
// без этой строки контейнер не собирается. У `AuthModule` наоборот: он держит
// `PrismaService` в собственных `providers`, и там строка была лишней.
describeDiSmoke('UploadsModule', () => [PrismaModule, UploadsModule]);
