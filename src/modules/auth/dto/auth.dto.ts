import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { Language as PrismaLanguage } from '@prisma/client';
import { SOCIAL_PROVIDERS, type SocialProvider } from '../providers/social-identity.service';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  languagePreference?: PrismaLanguage;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

/**
 * The only accepted shape: a provider and that provider's own token.
 *
 * `email`, `name` and `avatarUrl` used to be accepted here and were what the
 * identity was built from — which is how naming an account was enough to get a
 * session for it (LEGACY-070). They are gone, not merely ignored: a field that
 * is still accepted is a field a future change can start trusting again. All
 * three now come out of the verified provider response.
 *
 * `token` is deliberately named for neither mechanic. Facebook has no OIDC
 * id_token — NextAuth leaves `account.id_token` undefined there and only
 * `account.access_token` exists.
 */
export class SocialLoginDto {
  @IsIn(SOCIAL_PROVIDERS as unknown as string[])
  provider!: SocialProvider;

  /** google: `id_token`; facebook: `access_token`. */
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  languagePreference?: PrismaLanguage;
}
