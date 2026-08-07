import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { TokenPayload } from 'google-auth-library';

export type SocialProvider = 'google' | 'facebook';

export const SOCIAL_PROVIDERS: readonly SocialProvider[] = ['google', 'facebook'];

/** Identity as the *provider* states it. Never assembled from the request body. */
export interface SocialIdentity {
  provider: SocialProvider;
  providerUserId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

interface FacebookDebugToken {
  data?: {
    is_valid?: boolean;
    app_id?: string;
    user_id?: string;
  };
}

interface FacebookMe {
  id?: string;
  email?: string;
  name?: string;
  picture?: { data?: { url?: string } };
}

const GRAPH_BASE = 'https://graph.facebook.com';
const GRAPH_TIMEOUT_MS = 5_000;

/**
 * Proves who the caller is by asking the provider, not by trusting the body.
 *
 * The two providers need different mechanics: Google issues an OIDC id_token
 * that is verified locally against its JWKS, Facebook issues an OAuth2 access
 * token that only Facebook itself can judge.
 *
 * Both mechanics share one trap: "the token is genuine" is not "the token is
 * ours". A Google id_token minted for any other Google client carries a valid
 * Google signature, and a Facebook token minted for any other Facebook app
 * comes back `is_valid: true`. The audience checks below (`audience` /
 * `app_id`) are what make the difference, and they are the reason landings 4g
 * and 4f exist.
 */
@Injectable()
export class SocialIdentityService {
  private googleClient?: OAuth2Client;

  constructor(private readonly config: ConfigService) {}

  async verify(provider: SocialProvider, token: string): Promise<SocialIdentity> {
    return provider === 'google' ? this.verifyGoogle(token) : this.verifyFacebook(token);
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
      name: payload.name ?? undefined,
      avatarUrl: payload.picture ?? undefined,
    };
  }

  private async verifyFacebook(token: string): Promise<SocialIdentity> {
    const appId = this.config.get<string>('AUTH_FACEBOOK_ID')?.trim();
    const appSecret = this.config.get<string>('AUTH_FACEBOOK_SECRET')?.trim();
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException('Facebook sign-in is not configured on this server');
    }

    const debug = await this.graph<FacebookDebugToken>('debug_token', {
      input_token: token,
      access_token: `${appId}|${appSecret}`,
    });

    const data = debug.data;
    if (data?.is_valid !== true) {
      throw new UnauthorizedException('Facebook token is not valid');
    }
    if (data.app_id !== appId) {
      // `is_valid` only says the token is real. Anyone can register their own
      // Facebook application and get real tokens from it.
      throw new UnauthorizedException('Facebook token was issued for another application');
    }
    if (!data.user_id) {
      throw new UnauthorizedException('Facebook token carries no subject');
    }

    // debug_token returns the user id but never the e-mail — hence a second call.
    const me = await this.graph<FacebookMe>('me', {
      fields: 'id,email,name,picture.type(large)',
      access_token: token,
    });

    if (me.id !== data.user_id) {
      throw new UnauthorizedException('Facebook identity does not match the inspected token');
    }

    const email = me.email?.trim().toLowerCase();
    if (!email) {
      // Facebook accounts can exist without an e-mail (phone signup, or the
      // `email` scope was declined). Refuse rather than create an account with
      // a blank address that would later collide with every other such user.
      throw new UnauthorizedException(
        'Facebook account has no e-mail address available; sign in with e-mail instead',
      );
    }

    return {
      provider: 'facebook',
      providerUserId: data.user_id,
      email,
      name: me.name ?? undefined,
      avatarUrl: me.picture?.data?.url ?? undefined,
    };
  }

  private async graph<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${GRAPH_BASE}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
    } catch {
      throw new ServiceUnavailableException('Facebook could not be reached to verify the token');
    }

    if (!response.ok) {
      // 4xx is Facebook judging the token; 5xx is Facebook being unavailable.
      // Only the first one is the caller's fault.
      if (response.status >= 500) {
        throw new ServiceUnavailableException('Facebook could not verify the token right now');
      }
      throw new UnauthorizedException('Facebook token is not valid');
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ServiceUnavailableException('Facebook returned an unreadable response');
    }
  }
}
