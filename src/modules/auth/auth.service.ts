import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
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
import { User, Language as PrismaLanguage, RoleName } from '@prisma/client';

type PublicUser = Omit<User, 'passwordHash'>;

type AuthSession = {
  user: PublicUser & { roles: RoleName[] };
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
   * Two entry shapes during the cross-repo rollout, see {@link SocialLoginDto}.
   *
   * Verified: the provider is asked who the caller is, and the answer — not the
   * body — becomes the identity. Legacy: no proof at all, so the session is
   * issued with the baseline role only.
   */
  async socialLogin(dto: SocialLoginDto, clientIp?: string): Promise<AuthSession> {
    await this.ensureCoreRoles();

    if (dto.token) {
      if (!dto.provider) {
        throw new BadRequestException('provider is required when a provider token is supplied');
      }
      const identity = await this.social.verify(dto.provider, dto.token);
      return this.issueSocialSession(identity.email, {
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        languagePreference: dto.languagePreference,
        elevatedRoles: true,
      });
    }

    if (!dto.email) {
      throw new BadRequestException('token is required');
    }

    // Legacy path — kept only until books-front sends the provider token.
    // Logged on every call so step 3 can be scheduled from evidence rather
    // than from hope that nobody uses it any more.
    this.logger.warn(
      `[deprecated] POST /auth/social called without a provider token ` +
        `(provider=${dto.provider ?? 'unset'}, ip=${clientIp ?? 'unknown'}). ` +
        'The request proves nothing; the session is issued with the baseline role only.',
    );

    return this.issueSocialSession(dto.email, {
      name: dto.name,
      avatarUrl: dto.avatarUrl,
      languagePreference: dto.languagePreference,
      elevatedRoles: false,
    });
  }

  private async issueSocialSession(
    rawEmail: string,
    options: {
      name?: string;
      avatarUrl?: string;
      languagePreference?: PrismaLanguage;
      elevatedRoles: boolean;
    },
  ): Promise<AuthSession> {
    const email = rawEmail.trim().toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          name: options.name,
          avatarUrl: options.avatarUrl,
          languagePreference: options.languagePreference ?? PrismaLanguage.en,
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
    } else {
      // If user exists, optionally update name or avatarUrl if they were missing
      const updateData: Partial<User> = {};
      if (!user.name && options.name) updateData.name = options.name;
      if (!user.avatarUrl && options.avatarUrl) updateData.avatarUrl = options.avatarUrl;

      if (Object.keys(updateData).length > 0) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: updateData,
        });
      }
    }

    const stored = await this.computeRoles(user);
    // An unproven caller gets the baseline role even if the account really is
    // an administrator: the request did not show it is that account.
    const roles = options.elevatedRoles ? stored : stored.filter((r) => r === RoleName.user);

    const tokens = await this.signTokens(user.id, user.email, roles);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    return { user: { ...this.publicUser(user), roles }, ...tokens };
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
