import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { requireJwtAccessSecret } from '../../../common/config/jwt-secrets';
import { readRolesCacheTtlMs } from '../../../common/roles/roles-cache';
import { PrismaService } from '../../../prisma/prisma.service';
import { readSessionState } from '../../../shared/session/session-state-reader';
import {
  isSessionAlive,
  SESSION_REVOKED_MESSAGE,
  type SessionTokenClaims,
} from '../../../shared/session/session-token';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly ttlMs: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireJwtAccessSecret((key) => config.get<string>(key)),
    });
    this.ttlMs = readRolesCacheTtlMs(config.get<string>('ROLES_CACHE_TTL_MS'));
  }

  /**
   * Подпись и срок проверил `passport-jwt`; здесь — что сессия ещё жива (`LEGACY-451`, `452`):
   * пользователь есть, не заблокирован, и версия токена равна текущей. Токен без `tv`
   * (выдан до выката `T122`) считается версией 0 — колонка заведена с умолчанием 0,
   * и такие токены живут до своего срока, пока версию не поднимут.
   */
  async validate(payload: SessionTokenClaims) {
    if (!isSessionAlive(await readSessionState(this.prisma, payload.sub, this.ttlMs), payload)) {
      throw new UnauthorizedException(SESSION_REVOKED_MESSAGE);
    }
    return { userId: payload.sub, email: payload.email };
  }
}
