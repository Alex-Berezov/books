import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { readJwtAccessExpiresIn, requireJwtAccessSecret } from '../../common/config/jwt-secrets';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SocialIdentityService } from './providers/social-identity.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    RateLimitModule,
    AdminAuditModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: requireJwtAccessSecret((key) => config.get<string>(key)),
        signOptions: { expiresIn: readJwtAccessExpiresIn((key) => config.get<string>(key)) },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, SocialIdentityService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
