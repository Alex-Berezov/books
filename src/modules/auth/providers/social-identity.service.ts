import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { TokenPayload } from 'google-auth-library';
import { USER_NAME_MAX_LENGTH } from '../../../shared/constants/validation';

export type SocialProvider = 'google';

export const SOCIAL_PROVIDERS: readonly SocialProvider[] = ['google'];

/** Identity as the *provider* states it. Never assembled from the request body. */
export interface SocialIdentity {
  provider: SocialProvider;
  providerUserId: string;
  email: string;
  /**
   * Провайдер доказал владение именно этим адресом.
   *
   * 🔴 Не косметика: от этого флага зависит, можно ли привязать личность к **уже
   * существующему** аккаунту с тем же адресом. Google даёт `email_verified` в
   * подписанном токене; у другого провайдера адрес может оказаться просто полем
   * профиля без подтверждения. Поле обязательное, чтобы новый провайдер не получил доступ к
   * чужим аккаунтам по умолчанию просто потому, что автор о нём не подумал.
   */
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

/**
 * Proves who the caller is by asking the provider, not by trusting the body.
 *
 * Google issues an OIDC id_token that is verified locally against its JWKS.
 * The trap: "the token is genuine" is not "the token is ours". A Google
 * id_token minted for any other Google client carries a valid Google
 * signature; the explicit `audience` check below is what makes the
 * difference, and it is the reason landing 4g exists.
 */
@Injectable()
export class SocialIdentityService {
  private googleClient?: OAuth2Client;

  constructor(private readonly config: ConfigService) {}

  async verify(provider: SocialProvider, token: string): Promise<SocialIdentity> {
    switch (provider) {
      case 'google':
        return this.verifyGoogle(token);
      default: {
        // Провайдер вне перечня сюда не доходит: его отбивает DTO. Вызов мимо DTO получает
        // отказ, а не `undefined` вместо личности.
        const unsupported: never = provider;
        throw new UnauthorizedException(`Unsupported provider: ${String(unsupported)}`);
      }
    }
  }

  private async verifyGoogle(token: string): Promise<SocialIdentity> {
    const audience = this.config.get<string>('AUTH_GOOGLE_ID')?.trim();
    if (!audience) {
      // Without the client id there is nothing to check the audience against,
      // and a check we cannot perform must not be silently skipped.
      throw new ServiceUnavailableException('Google sign-in is not configured on this server');
    }

    this.googleClient ??= new OAuth2Client();

    let payload: TokenPayload | undefined;
    try {
      // `audience` is passed explicitly on purpose. Omitted, verifyIdToken
      // checks the signature alone — and every Google token carries the same
      // Google signature.
      const ticket = await this.googleClient.verifyIdToken({ idToken: token, audience });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Google token is not valid for this application');
    }

    if (!payload?.sub) throw new UnauthorizedException('Google token carries no subject');

    if (payload.email_verified !== true) {
      // Identity is keyed on e-mail at this step, so an unverified address
      // would let anyone claim someone else's account.
      throw new UnauthorizedException('Google account e-mail is not verified');
    }

    const email = payload.email?.trim().toLowerCase();
    if (!email) throw new UnauthorizedException('Google token carries no e-mail address');

    return {
      provider: 'google',
      providerUserId: payload.sub,
      email,
      // Проверено выше: без `email_verified === true` сюда не дойти.
      emailVerified: true,
      // Имя пишется в `User.name` как есть: потолок формы (`LEGACY-471`), провайдер его не знает.
      // Режется по кодовым точкам, а не по единицам UTF-16: суррогатная пара на границе не распадается
      // (составной эмодзи с ZWJ разрезаться может — это не битая строка).
      name:
        payload.name == null
          ? undefined
          : Array.from(payload.name).slice(0, USER_NAME_MAX_LENGTH).join(''),
      avatarUrl: payload.picture ?? undefined,
    };
  }
}
