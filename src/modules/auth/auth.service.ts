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
import {
  AdminAuditAction,
  AdminAuditTargetType,
  Prisma,
  User,
  Language as PrismaLanguage,
  RoleName,
} from '@prisma/client';
import { ACCOUNT_USER_SELECT, AccountUser } from '../../common/selects/account-user.select';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';

/**
 * Пользователь в ответах входа и регистрации.
 *
 * ⚠️ Выводится из белого списка, а не из `Omit<User, 'passwordHash'>` (`LEGACY-116`,
 * `LEGACY-190`). Разница видна на следующей колонке в схеме: `Omit` пропустил бы её
 * в этот тип сам, а `tsc` попросил бы заполнить её в `publicUser` — и колонка уехала бы
 * в тело ответа входа, хотя `ACCOUNT_USER_SELECT` её не отдаёт. С белым списком новое
 * поле не появляется в ответе, пока его не впишут в список руками.
 */
type PublicUser = AccountUser;

/**
 * Единственное чтение пользователя, которому argon2-хеш нужен по существу (`LEGACY-190`).
 *
 * 🔴 `passwordHash: true` во всём файле стоит **только здесь**. Это не обещание автора:
 * спека разбирает исходник этого файла деревом и считает обращения, просящие хеш, — блок
 * «инвариант по исходнику сервиса» в `auth.service.spec.ts`. Чтение, добавленное завтра
 * без `select`, краснит прогон, даже если его не вызвал ни один тест.
 *
 * ⚠️ Охрана точная, а не сплошная, и границы у неё две. Первая: `select` требуется
 * у читающих методов по белому списку — у `deleteMany` и `updateMany` этого поля нет
 * в типах вовсе, и требование к ним было бы неисполнимо. Вторая: обращение через
 * промежуточную переменную (`const users = this.prisma.user`) разбор не видит.
 * Владелец перед `.user` при этом не проверяется — `tx.user.*` внутри транзакции
 * под охраной наравне с `this.prisma.user.*`.
 *
 * Остальные десять обращений читают белым списком
 * `ACCOUNT_USER_SELECT` или одним `id`: до правки все одиннадцать шли без `select` вовсе,
 * то есть хеш лежал в памяти и в объекте, который дальше уходил в `publicUser` и в ответ.
 * Наружу он не попадал по единственной причине — `publicUser` перечисляет поля руками;
 * одна невнимательная правка вида `return { ...user, roles }` отправила бы его в тело
 * ответа входа, в логи фронта и в кэш. Ни типы, ни линт, ни тесты этого не ловили.
 *
 * `login` читает хеш, чтобы сверить пароль (`argon2.verify`), и в ответ он не идёт:
 * ответ собирает всё тот же `publicUser`.
 */
const LOGIN_USER_SELECT = {
  ...ACCOUNT_USER_SELECT,
  passwordHash: true,
} satisfies Prisma.UserSelect;

type AuthSession = {
  user: PublicUser & { roles: RoleName[] };
  accessToken: string;
  refreshToken: string;
};

/** Метка пути в `payload` события: выдача роли по env-списку при регистрации (`LEGACY-015`). */
export const ENV_BOOTSTRAP_AUDIT_SOURCE = 'env_bootstrap';

/**
 * Создание пользователя, до трёх вставок ролей и двух записей журнала — до семи коротких
 * операторов, чуть больше пары, на которую рассчитан дефолт Prisma (5 с / 2 с). Бюджет
 * **ниже**, чем у ролевых транзакций `users.service.ts` (30 с / 10 с): маршрут публичный,
 * и всплеск регистраций с застрявшим замком держал бы соединение пула до `timeout`.
 */
const REGISTRATION_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private social: SocialIdentityService,
    private adminAudit: AdminAuditService,
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
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await argon2.hash(dto.password);

    // Пользователь, его роли и запись журнала — одной транзакцией: отказ любой части
    // не оставляет аккаунта без ролей, на который повторная регистрация ответила бы 409.
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          name: dto.name,
          languagePreference: dto.languagePreference ?? PrismaLanguage.en,
        },
        select: ACCOUNT_USER_SELECT,
      });
      await this.grantRegistrationRoles(tx, created.id, created.email);
      return created;
    }, REGISTRATION_TX_OPTIONS);

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
      select: { id: true },
    });

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

    let user: AccountUser | null = link
      ? await this.prisma.user.findUnique({
          where: { id: link.userId },
          select: ACCOUNT_USER_SELECT,
        })
      : null;

    if (!user) {
      const byEmail = await this.prisma.user.findUnique({
        where: { email },
        select: ACCOUNT_USER_SELECT,
      });

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
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: updateData,
        select: ACCOUNT_USER_SELECT,
      });
    }

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
      select: { id: true },
    });

    return { user: { ...this.publicUser(user), roles }, ...tokens };
  }

  /** Адреса из env-списка через запятую, в нижнем регистре; пустое значение — пустой список. */
  private static parseEmailList(csv: string | undefined): string[] {
    return (csv || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Роли при регистрации: базовая `user` всем, повышенные — по спискам `ADMIN_EMAILS`
   * и `CONTENT_MANAGER_EMAILS` (бутстрап первого администратора, `LEGACY-170`).
   *
   * ⚠️ Выдача повышенной роли пишет `ROLE_ASSIGNED` той же транзакцией (`LEGACY-015`,
   * решение арбитра 27.09.2026, пачка `T43`): смена ролей журналируется всеми путями,
   * публичность маршрута тут ничего не решает. Актёр `null`, а не сам пользователь —
   * иначе журнал утверждал бы, что он выдал админку себе; путь отличает `source`.
   * Базовая роль события не получает: это не привилегия. Зовётся внутри транзакции
   * `register()`, создающей самого пользователя, — `tx` приходит оттуда.
   *
   * ⚠️ Признак «роль появилась» — `count` вставки с `skipDuplicates` (решение арбитра).
   * Пока пользователь создаётся этой же транзакцией, `count` всегда 1: чужая транзакция
   * не вставит роль строке, которой ещё нет. Проверка стоит как сторож инварианта
   * «событие = изменение состояния» на случай, если путь позовут для существующего
   * пользователя, а не как защита от гонки.
   */
  private async grantRegistrationRoles(
    tx: Prisma.TransactionClient,
    userId: string,
    email: string,
  ): Promise<void> {
    const address = email.toLowerCase();
    const elevated: RoleName[] = [];
    // Ключи названы литералами: `check:env` сверяет чтения окружения с `.env.example` по имени.
    const admins = AuthService.parseEmailList(this.config.get<string>('ADMIN_EMAILS'));
    const managers = AuthService.parseEmailList(this.config.get<string>('CONTENT_MANAGER_EMAILS'));
    if (admins.includes(address)) elevated.push(RoleName.admin);
    if (managers.includes(address)) elevated.push(RoleName.content_manager);
    const wanted = [RoleName.user, ...elevated];

    const roles = await tx.role.findMany({
      where: { name: { in: wanted } },
      select: { id: true, name: true },
    });
    // Порядок — по `wanted`, а не по выдаче базы: события пишутся в предсказуемом порядке.
    for (const name of wanted) {
      const role = roles.find((r) => r.name === name);
      if (!role) continue;
      const { count } = await tx.userRole.createMany({
        data: [{ userId, roleId: role.id }],
        skipDuplicates: true,
      });
      if (count === 0 || role.name === RoleName.user) continue;
      await this.adminAudit.record(tx, {
        action: AdminAuditAction.ROLE_ASSIGNED,
        targetType: AdminAuditTargetType.USER,
        targetId: userId,
        actorUserId: null,
        payload: { role: role.name, source: ENV_BOOTSTRAP_AUDIT_SOURCE },
      });
    }
  }

  private async createSocialUser(
    email: string,
    identity: SocialIdentity,
    languagePreference?: PrismaLanguage,
  ): Promise<AccountUser> {
    const user = await this.prisma.user.create({
      data: {
        email,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        languagePreference: languagePreference ?? PrismaLanguage.en,
      },
      select: ACCOUNT_USER_SELECT,
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
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: LOGIN_USER_SELECT,
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    if (!user.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
      select: { id: true },
    });

    // Include roles in login response
    return { user: { ...this.publicUser(user), roles }, ...tokens };
  }

  async refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(dto.refreshToken, {
      secret: this.secret(JWT_REFRESH_SECRET_ENV),
    });

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: ACCOUNT_USER_SELECT,
    });
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

  private publicUser(user: AccountUser): PublicUser {
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
  private async computeRoles(user: Pick<User, 'id'>): Promise<RoleName[]> {
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
