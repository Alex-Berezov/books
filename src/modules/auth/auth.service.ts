import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { LoginDto, RegisterDto, RefreshDto } from './dto/auth.dto';
import { User, Language as PrismaLanguage } from '@prisma/client';

type PublicUser = Omit<User, 'passwordHash'>;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ user: PublicUser; accessToken: string; refreshToken: string }> {
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

    const tokens = await this.signTokens(user.id, user.email);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    return { user: this.publicUser(user), ...tokens };
  }

  async login(
    dto: LoginDto,
  ): Promise<{ user: PublicUser; accessToken: string; refreshToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.signTokens(user.id, user.email);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    return { user: this.publicUser(user), ...tokens };
  }

  async refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    const refreshSecret = this.config.get<string>('JWT_REFRESH_SECRET') || 'dev_refresh_secret';
    const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(dto.refreshToken, {
      secret: refreshSecret,
    });
    const tokens = await this.signTokens(payload.sub, payload.email);
    return tokens;
  }

  logout(): { success: true } {
    return { success: true };
  }

  private async signTokens(
    userId: string,
    email: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessSecret = this.config.get<string>('JWT_ACCESS_SECRET') || 'dev_access_secret';
    const refreshSecret = this.config.get<string>('JWT_REFRESH_SECRET') || 'dev_refresh_secret';
    const accessExpiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
    const refreshExpiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { sub: userId, email },
        { secret: accessSecret, expiresIn: accessExpiresIn },
      ),
      this.jwt.signAsync(
        { sub: userId, email },
        { secret: refreshSecret, expiresIn: refreshExpiresIn },
      ),
    ]);
    return { accessToken, refreshToken };
  }

  private publicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      languagePreference: user.languagePreference,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }
}
