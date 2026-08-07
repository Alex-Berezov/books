import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SocialIdentityService } from './social-identity.service';
import type { ConfigService } from '@nestjs/config';

const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const GOOGLE_ID = 'our-google-client.apps.googleusercontent.com';
const FACEBOOK_ID = '1234567890';
const FACEBOOK_SECRET = 'fb-app-secret';

function service(overrides: Record<string, string | undefined> = {}): SocialIdentityService {
  const values: Record<string, string | undefined> = {
    AUTH_GOOGLE_ID: GOOGLE_ID,
    AUTH_FACEBOOK_ID: FACEBOOK_ID,
    AUTH_FACEBOOK_SECRET: FACEBOOK_SECRET,
    ...overrides,
  };
  const config = { get: (name: string) => values[name] } as unknown as ConfigService;
  return new SocialIdentityService(config);
}

/** Queue of Graph API responses, consumed in call order (debug_token, then /me). */
function mockGraph(responses: { status?: number; body: unknown }[]): jest.Mock {
  const fetchMock = jest.fn();
  for (const { status = 200, body } of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const VALID_DEBUG = {
  data: { is_valid: true, app_id: FACEBOOK_ID, user_id: 'fb-user-1' },
};

describe('SocialIdentityService', () => {
  beforeEach(() => {
    mockVerifyIdToken.mockReset();
    jest.restoreAllMocks();
  });

  describe('google', () => {
    it('landing 1g: a token Google refuses is not an identity', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('Invalid token signature'));

      await expect(service().verify('google', 'garbage')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    // Landing 4g. verifyIdToken without an explicit `audience` checks the
    // signature only — and every Google token is signed by Google. A token
    // minted for someone else's client would then pass as ours.
    it('landing 4g: the audience is passed explicitly to verifyIdToken', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'g-1',
          email: 'user@example.com',
          email_verified: true,
        }),
      });

      await service().verify('google', 'id-token');

      expect(mockVerifyIdToken).toHaveBeenCalledWith(
        expect.objectContaining({ idToken: 'id-token', audience: GOOGLE_ID }),
      );
    });

    it('landing 4g: a token for another client is refused (library rejects on aud mismatch)', async () => {
      mockVerifyIdToken.mockImplementation(({ audience }: { audience?: string }) => {
        if (audience !== 'other-client.apps.googleusercontent.com') {
          return Promise.reject(new Error('Wrong recipient, payload audience != requiredAudience'));
        }
        return Promise.resolve({ getPayload: () => ({ sub: 'g-2', email_verified: true }) });
      });

      await expect(service().verify('google', 'foreign-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    // Landing 5g. Identity is keyed on e-mail at this step, so a signed token
    // carrying an unverified address proves nothing about that address.
    it('landing 5g: an unverified e-mail is refused', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ sub: 'g-3', email: 'victim@example.com', email_verified: false }),
      });

      await expect(service().verify('google', 'id-token')).rejects.toThrow(/not verified/i);
    });

    it('landing 5g: a missing email_verified claim is refused too', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ sub: 'g-4', email: 'victim@example.com' }),
      });

      await expect(service().verify('google', 'id-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('returns the identity from the token, lower-cased', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'g-5',
          email: 'User@Example.COM',
          email_verified: true,
          name: 'Real Name',
          picture: 'https://example.com/a.png',
        }),
      });

      await expect(service().verify('google', 'id-token')).resolves.toEqual({
        provider: 'google',
        providerUserId: 'g-5',
        email: 'user@example.com',
        name: 'Real Name',
        avatarUrl: 'https://example.com/a.png',
      });
    });

    it('refuses to verify at all when the client id is not configured', async () => {
      await expect(
        service({ AUTH_GOOGLE_ID: undefined }).verify('google', 'id-token'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });
  });

  describe('facebook', () => {
    // `app_id` is deliberately *ours* here: otherwise the audience check would
    // reject the token as well, and the landing would stay green even with the
    // is_valid check removed — it would be testing the wrong guarantee.
    it('landing 1f: an invalid token is not an identity', async () => {
      const fetchMock = mockGraph([
        { body: { data: { is_valid: false, app_id: FACEBOOK_ID, user_id: 'fb-user-1' } } },
      ]);

      await expect(service().verify('facebook', 'garbage')).rejects.toThrow(/token is not valid/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('landing 1f: a response without a verdict is not an identity either', async () => {
      mockGraph([{ body: {} }]);

      await expect(service().verify('facebook', 'garbage')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    // Landing 4f, the twin of 4g. `is_valid: true` says the token is real, not
    // that it is ours: anyone can register a Facebook app and mint real tokens.
    it('landing 4f: a valid token issued for another application is refused', async () => {
      const fetchMock = mockGraph([
        { body: { data: { is_valid: true, app_id: '999-someone-else', user_id: 'fb-user-9' } } },
      ]);

      await expect(service().verify('facebook', 'foreign-token')).rejects.toThrow(
        /another application/i,
      );
      // The identity call must never happen once the audience check failed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('landing 4f: debug_token is called with the app access token', async () => {
      const fetchMock = mockGraph([
        { body: VALID_DEBUG },
        { body: { id: 'fb-user-1', email: 'fb@example.com' } },
      ]);

      await service().verify('facebook', 'user-token');

      const url = String((fetchMock.mock.calls[0] as [URL])[0]);
      expect(url).toContain('/debug_token');
      expect(url).toContain(
        `access_token=${encodeURIComponent(`${FACEBOOK_ID}|${FACEBOOK_SECRET}`)}`,
      );
      expect(url).toContain('input_token=user-token');
    });

    // Landing 5f. A Facebook account can exist without an e-mail; creating an
    // account with a blank address would collide with every other such user.
    it('landing 5f: a verified token without an e-mail is refused, not accepted blank', async () => {
      mockGraph([{ body: VALID_DEBUG }, { body: { id: 'fb-user-1' } }]);

      await expect(service().verify('facebook', 'user-token')).rejects.toThrow(/no e-mail/i);
    });

    it('refuses when /me describes a different user than the inspected token', async () => {
      mockGraph([{ body: VALID_DEBUG }, { body: { id: 'fb-user-2', email: 'other@example.com' } }]);

      await expect(service().verify('facebook', 'user-token')).rejects.toThrow(/does not match/i);
    });

    it('returns the identity from Graph, lower-cased', async () => {
      mockGraph([
        { body: VALID_DEBUG },
        {
          body: {
            id: 'fb-user-1',
            email: 'FB@Example.com',
            name: 'Real Name',
            picture: { data: { url: 'https://cdn.example.com/p.png' } },
          },
        },
      ]);

      await expect(service().verify('facebook', 'user-token')).resolves.toEqual({
        provider: 'facebook',
        providerUserId: 'fb-user-1',
        email: 'fb@example.com',
        name: 'Real Name',
        avatarUrl: 'https://cdn.example.com/p.png',
      });
    });

    it('treats a Graph outage as unavailable, not as a bad token', async () => {
      mockGraph([{ status: 503, body: {} }]);

      await expect(service().verify('facebook', 'user-token')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('refuses to verify at all when the app secret is not configured', async () => {
      const fetchMock = mockGraph([]);

      await expect(
        service({ AUTH_FACEBOOK_SECRET: undefined }).verify('facebook', 'user-token'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
