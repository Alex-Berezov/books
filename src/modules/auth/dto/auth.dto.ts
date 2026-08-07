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
 * Two shapes live here on purpose, and only during the cross-repo rollout.
 *
 * The verified shape is `{ provider, token }`: the server asks the provider who
 * the caller is. The legacy shape is `{ email, name, avatarUrl, provider }`,
 * kept only until `books-front` starts sending the provider token — it proves
 * nothing and is stripped of every elevated role. It disappears in step 3.
 *
 * The branch is taken on `token`, never on `provider`: the old frontend already
 * sends `provider: 'google'` without any token.
 *
 * `token` is deliberately named for neither mechanic. Facebook has no OIDC
 * id_token — NextAuth leaves `account.id_token` undefined there and only
 * `account.access_token` exists.
 */
export class SocialLoginDto {
  @IsOptional()
  @IsIn(SOCIAL_PROVIDERS as unknown as string[])
  provider?: SocialProvider;

  /** google: `id_token`; facebook: `access_token`. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  token?: string;

  /** @deprecated Legacy step-1 compatibility. Ignored whenever `token` is present. */
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  languagePreference?: PrismaLanguage;
}
