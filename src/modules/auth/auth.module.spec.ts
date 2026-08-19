import { describeDiSmoke } from '../../common/testing/di-smoke';
import { AuthModule } from './auth.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';

const savedEnv = { ...process.env };

describeDiSmoke('AuthModule', () => [PrismaModule, AuthModule], {
  beforeEach: () => {
    // `JwtModule.registerAsync` читает секреты фабрикой на этапе сборки
    // контейнера, и `requireJwtAccessSecret` бросает при их отсутствии. Значения
    // здесь — фикстура: тест проверяет разрешимость зависимостей, а не подпись.
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
  },
  afterEach: () => {
    process.env = { ...savedEnv };
  },
});
