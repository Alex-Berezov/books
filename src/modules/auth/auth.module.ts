import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { requireJwtAccessSecret } from '../../common/config/jwt-secrets';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SocialIdentityService } from './providers/social-identity.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    RateLimitModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: requireJwtAccessSecret((key) => config.get<string>(key)),
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PrismaService, JwtStrategy, SocialIdentityService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
