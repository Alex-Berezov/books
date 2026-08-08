import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  JWT_ACCESS_SECRET_ENV,
  JWT_REFRESH_SECRET_ENV,
  requireJwtSecret,
} from '../../common/config/jwt-secrets';
import { LoginDto, RegisterDto, RefreshDto, SocialLoginDto } from './dto/auth.dto';
import { SocialIdentityService } from './providers/social-identity.service';
import type { SocialIdentity } from './providers/social-identity.service';
import { User, Language as PrismaLanguage, RoleName } from '@prisma/client';

type PublicUser = Omit<User, 'passwordHash'>;

type AuthSession = {
  user: PublicUser & { roles: RoleName[] };
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private social: SocialIdentityService,
  ) {}

  private secret(name: string): string {
    return requireJwtSecret(name, (key) => this.config.get<string>(key));
  }

  async register(dto: RegisterDto): Promise<{
    user: PublicUser & { roles: RoleName[] };
    accessToken: string;
    refreshToken: string;
  }> {
    // Ensure core roles exist (idempotent)
    await this.prisma.$transaction([
      this.prisma.role.upsert({
        where: { name: RoleName.user },
        update: {},
        create: { name: RoleName.user },
      }),
      this.prisma.role.upsert({
        where: { name: RoleName.admin },
        update: {},
        create: { name: RoleName.admin },
      }),
      this.prisma.role.upsert({
        where: { name: RoleName.content_manager },
        update: {},
        create: { name: RoleName.content_manager },
      }),
    ]);
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await argon2.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        languagePreference: dto.languagePreference ?? PrismaLanguage.en,
      },
    });

    // Assign default 'user' role and optionally elevated roles from env lists
    const userRole = await this.prisma.role.findUnique({ where: { name: RoleName.user } });
    if (userRole) {
      await this.prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: userRole.id } },
        create: { userId: user.id, roleId: userRole.id },
        update: {},
      });
    }

    const adminsList = (this.config.get<string>('ADMIN_EMAILS') || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (adminsList.includes(user.email.toLowerCase())) {
      const adminRole = await this.prisma.role.findUnique({ where: { name: RoleName.admin } });
      if (adminRole)
        await this.prisma.userRole.upsert({
          where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
          create: { userId: user.id, roleId: adminRole.id },
          update: {},
        });
    }

    const managersList = (this.config.get<string>('CONTENT_MANAGER_EMAILS') || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (managersList.includes(user.email.toLowerCase())) {
      const managerRole = await this.prisma.role.findUnique({
        where: { name: RoleName.content_manager },
      });
      if (managerRole)
        await this.prisma.userRole.upsert({
          where: { userId_roleId: { userId: user.id, roleId: managerRole.id } },
          create: { userId: user.id, roleId: managerRole.id },
          update: {},
        });
    }

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    // Include roles in register response
    return { user: { ...this.publicUser(user), roles }, ...tokens };
  }

  /**
   * The provider states who the caller is. The request body never does.
   *
   * A body-only shape (`{ email }`) was accepted during step 1 of the rollout so
   * that deploying the API ahead of the frontend would not break sign-in. It is
   * gone: the frontend sends `{ provider, token }` and refuses to sign in at all
   * without a provider token, so nothing legitimate reaches the old shape.
   */
  async socialLogin(dto: SocialLoginDto): Promise<AuthSession> {
    await this.ensureCoreRoles();

    const identity = await this.social.verify(dto.provider, dto.token);

    return this.issueSocialSession(identity, dto.languagePreference);
  }

  /**
   * Кто вошёл — определяет пара `(provider, providerUserId)`, а не адрес почты.
   *
   * Адрес негоден как ключ по трём независимым причинам: он меняется на стороне
   * провайдера, у Facebook его может не быть вовсе, и — главное — совпадение
   * адреса не доказывает владение аккаунтом. Пока ключом был email, вход через
   * провайдера открывал **уже существующий парольный аккаунт того же адреса**,
   * минуя пароль (LEGACY-070, NEXT-SESSION §5).
   *
   * Email остаётся мостом ровно для одного случая — первой привязки, и только
   * от провайдера, доказавшего владение адресом. Иначе прошлые входы через
   * Google (для которых `providerUserId` нигде не сохранён) при следующем входе
   * заводили бы вторые аккаунты вместо своих собственных.
   */
  private async issueSocialSession(
    identity: SocialIdentity,
    languagePreference?: PrismaLanguage,
  ): Promise<AuthSession> {
    const email = identity.email.trim().toLowerCase();

    const link = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerUserId: {
          provider: identity.provider,
          providerUserId: identity.providerUserId,
        },
      },
    });

    let user = link ? await this.prisma.user.findUnique({ where: { id: link.userId } }) : null;

    if (!user) {
      const byEmail = await this.prisma.user.findUnique({ where: { email } });

      if (byEmail && !identity.emailVerified) {
        // Провайдер подтвердил, что владелец токена — это он сам, но не то, что
        // адрес принадлежит ему. Привязка здесь означала бы вход в чужой аккаунт
        // по совпадению строки.
        throw new UnauthorizedException(
          'This e-mail already belongs to an account and the provider does not prove ownership of the address',
        );
      }

      user = byEmail ?? (await this.createSocialUser(email, identity, languagePreference));
    }

    // upsert, а не create: два одновременных первых входа одной личности иначе
    // разошлись бы по уникальному индексу, и один из них упал бы с 500.
    await this.prisma.userIdentity.upsert({
      where: {
        provider_providerUserId: {
          provider: identity.provider,
          providerUserId: identity.providerUserId,
        },
      },
      create: {
        userId: user.id,
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        email,
        lastLoginAt: new Date(),
      },
      // Адрес обновляется **у привязки**, а не у пользователя: смена почты на
      // стороне провайдера не должна переименовывать аккаунт на нашей стороне.
      update: { email, lastLoginAt: new Date() },
    });

    // Профиль дополняется, но не перезаписывается: провайдер вправе добавить
    // недостающее имя или аватар и не вправе затирать выставленное человеком.
    const updateData: Partial<User> = {};
    if (!user.name && identity.name) updateData.name = identity.name;
    if (!user.avatarUrl && identity.avatarUrl) updateData.avatarUrl = identity.avatarUrl;
    if (Object.keys(updateData).length > 0) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: updateData });
    }

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    return { user: { ...this.publicUser(user), roles }, ...tokens };
  }

  private async createSocialUser(
    email: string,
    identity: SocialIdentity,
    languagePreference?: PrismaLanguage,
  ): Promise<User> {
    const user = await this.prisma.user.create({
      data: {
        email,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        languagePreference: languagePreference ?? PrismaLanguage.en,
      },
    });

    // Baseline role only. Elevated roles are never granted from an e-mail
    // list here — ADMIN_EMAILS bootstraps the first administrator through
    // register(), and nothing else.
    const userRole = await this.prisma.role.findUnique({ where: { name: RoleName.user } });
    if (userRole) {
      await this.prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: userRole.id } },
        create: { userId: user.id, roleId: userRole.id },
        update: {},
      });
    }

    return user;
  }

  /** Idempotent; the three core roles must exist before anything is linked to them. */
  private async ensureCoreRoles(): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.role.upsert({
        where: { name: RoleName.user },
        update: {},
        create: { name: RoleName.user },
      }),
      this.prisma.role.upsert({
        where: { name: RoleName.admin },
        update: {},
        create: { name: RoleName.admin },
      }),
      this.prisma.role.upsert({
        where: { name: RoleName.content_manager },
        update: {},
        create: { name: RoleName.content_manager },
      }),
    ]);
  }

  async login(dto: LoginDto): Promise<{
    user: PublicUser & { roles: RoleName[] };
    accessToken: string;
    refreshToken: string;
  }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    if (!user.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    // Include roles in login response
    return { user: { ...this.publicUser(user), roles }, ...tokens };
  }

  async refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(dto.refreshToken, {
      secret: this.secret(JWT_REFRESH_SECRET_ENV),
    });

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('User not found');

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(payload.sub, payload.email, roles);
    return tokens;
  }

  logout(): { success: true } {
    return { success: true };
  }

  private async signTokens(
    userId: string,
    email: string,
    roles: RoleName[],
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessSecret = this.secret(JWT_ACCESS_SECRET_ENV);
    const refreshSecret = this.secret(JWT_REFRESH_SECRET_ENV);
    const accessExpiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
    const refreshExpiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';

    const payload = { sub: userId, email, roles };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, { secret: accessSecret, expiresIn: accessExpiresIn }),
      this.jwt.signAsync(payload, { secret: refreshSecret, expiresIn: refreshExpiresIn }),
    ]);
    return { accessToken, refreshToken };
  }

  private publicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      nickname: user.nickname,
      isActive: user.isActive,
      avatarUrl: user.avatarUrl,
      languagePreference: user.languagePreference,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }

  /**
   * Roles come from the database and nowhere else.
   *
   * `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` used to elevate here as well.
   * Two independent sources for one role is a defect on its own, and the
   * second one compared an env list against a string that arrived in the
   * request. The lists now only bootstrap the first administrator through
   * {@link register}, which writes the role into `UserRole`.
   */
  private async computeRoles(user: User): Promise<RoleName[]> {
    const dbLinks = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: true },
    });
    const set = new Set<RoleName>(dbLinks.map((l) => l.role.name));

    // Baseline 'user'
    set.add('user');

    return Array.from(set);
  }
}
