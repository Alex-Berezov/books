import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SocialIdentityService } from './social-identity.service';
import type { ConfigService } from '@nestjs/config';
import { USER_NAME_MAX_LENGTH } from '../../../shared/constants/validation';

const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const GOOGLE_ID = 'our-google-client.apps.googleusercontent.com';

function service(overrides: Record<string, string | undefined> = {}): SocialIdentityService {
  const values: Record<string, string | undefined> = {
    AUTH_GOOGLE_ID: GOOGLE_ID,
    ...overrides,
  };
  const config = { get: (name: string) => values[name] } as unknown as ConfigService;
  return new SocialIdentityService(config);
}

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
        // Google подтверждает владение адресом — только с этим флагом вход
        // вправе привязаться к уже существующему аккаунту того же адреса.
        emailVerified: true,
        name: 'Real Name',
        avatarUrl: 'https://example.com/a.png',
      });
    });

    // LEGACY-471: имя провайдера пишется в User.name без своей проверки длины.
    it('cuts the provider name to the profile name ceiling', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'g-6',
          email: 'user@example.com',
          email_verified: true,
          name: 'n'.repeat(USER_NAME_MAX_LENGTH + 50),
        }),
      });

      const identity = await service().verify('google', 'id-token');

      expect(identity.name).toBe('n'.repeat(USER_NAME_MAX_LENGTH));
    });

    it('takes a null provider name as no name', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'g-8',
          email: 'user@example.com',
          email_verified: true,
          name: null,
        }),
      });

      const identity = await service().verify('google', 'id-token');

      expect(identity.name).toBeUndefined();
    });

    it('cuts the provider name by characters, not by UTF-16 halves', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'g-7',
          email: 'user@example.com',
          email_verified: true,
          name: 'n'.repeat(USER_NAME_MAX_LENGTH - 1) + '😀😀',
        }),
      });

      const identity = await service().verify('google', 'id-token');

      expect(identity.name).toBe('n'.repeat(USER_NAME_MAX_LENGTH - 1) + '😀');
    });

    it('refuses to verify at all when the client id is not configured', async () => {
      await expect(
        service({ AUTH_GOOGLE_ID: undefined }).verify('google', 'id-token'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });
  });
});
