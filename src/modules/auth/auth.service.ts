import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JsonWebTokenError, JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  JWT_ACCESS_SECRET_ENV,
  JWT_REFRESH_SECRET_ENV,
  readJwtAccessExpiresIn,
  readJwtRefreshExpiresIn,
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
import { sessionStateCache } from '../../shared/session/session-state-cache';
import {
  claimedTokenVersion,
  isSessionAlive,
  SESSION_REVOKED_MESSAGE,
  type SessionTokenClaims,
} from '../../shared/session/session-token';
import { normalizeEmail } from '../../shared/validators/normalize-email.decorator';

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
 * Остальные обращения читают белым списком `ACCOUNT_USER_SELECT`, одним `id` или узким
 * состоянием сессии (`refresh`, `markSignIn`: `isActive`, `tokenVersion`): до правки все шли без `select` вовсе,
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

/** Refresh-токен после проверки подписи: поля сессии и срок, секунды. */
type RefreshTokenPayload = SessionTokenClaims & { exp: number };

/** Отказ заблокированному пользователю на входе любым путём (`LEGACY-452`). */
const ACCOUNT_DISABLED_MESSAGE = 'Account is disabled';

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
      // Регистрация паролем адрес не доказывает: повышенных ролей по спискам не выдаёт (LEGACY-443).
      await this.grantRegistrationRoles(tx, created.id, created.email, false);
      return created;
    }, REGISTRATION_TX_OPTIONS);

    const tokenVersion = await this.markSignIn(user.id);
    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles, tokenVersion);

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
    const email = normalizeEmail(identity.email) as string;

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

    // До привязки и правки профиля: заблокированному пользователю вход провайдером
    // не открывает ни сессии, ни новой привязки (`LEGACY-452`). Снимок строки отсекает
    // блокировку сразу, а отметка входа (`markSignIn`, условием записи) — и блокировку,
    // пришедшую после чтения.
    if (!user.isActive) throw new UnauthorizedException(ACCOUNT_DISABLED_MESSAGE);
    const signedInUser = user;

    // Отметка входа, привязка и дополнение профиля — одной транзакцией: отказ отметки
    // (блокировка в окне) не оставляет привязки, а сбой привязки — отметки входа без входа.
    const { tokenVersion, profile } = await this.prisma.$transaction(async (tx) => {
      const version = await this.markSignIn(signedInUser.id, tx);
      // upsert, а не create: два одновременных первых входа одной личности иначе
      // разошлись бы по уникальному индексу, и один из них упал бы с 500.
      await tx.userIdentity.upsert({
        where: {
          provider_providerUserId: {
            provider: identity.provider,
            providerUserId: identity.providerUserId,
          },
        },
        create: {
          userId: signedInUser.id,
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
      if (!signedInUser.name && identity.name) updateData.name = identity.name;
      if (!signedInUser.avatarUrl && identity.avatarUrl) updateData.avatarUrl = identity.avatarUrl;
      const updated =
        Object.keys(updateData).length > 0
          ? await tx.user.update({
              where: { id: signedInUser.id },
              data: updateData,
              select: ACCOUNT_USER_SELECT,
            })
          : signedInUser;
      return { tokenVersion: version, profile: updated };
    }, REGISTRATION_TX_OPTIONS);
    user = profile;

    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles, tokenVersion);

    return { user: { ...this.publicUser(user), roles }, ...tokens };
  }

  /** Адреса из env-списка через запятую, в нижнем регистре; пустое значение — пустой список. */
  private static parseEmailList(csv: string | undefined): string[] {
    return (csv || '')
      .split(',')
      .map((e) => normalizeEmail(e) as string)
      .filter(Boolean);
  }

  /** Повышенные роли, которые списки окружения назначают адресу. */
  private listedRoles(email: string): RoleName[] {
    const address = normalizeEmail(email) as string;
    const elevated: RoleName[] = [];
    // Ключи названы литералами: `check:env` сверяет чтения окружения с `.env.example` по имени.
    const admins = AuthService.parseEmailList(this.config.get<string>('ADMIN_EMAILS'));
    const managers = AuthService.parseEmailList(this.config.get<string>('CONTENT_MANAGER_EMAILS'));
    if (admins.includes(address)) elevated.push(RoleName.admin);
    if (managers.includes(address)) elevated.push(RoleName.content_manager);
    return elevated;
  }

  /**
   * Роли нового пользователя: базовая `user` всем, повышенные — по спискам `ADMIN_EMAILS`
   * и `CONTENT_MANAGER_EMAILS` (бутстрап первого администратора, `LEGACY-170`), но только
   * когда `isAddressProven` — то есть адрес доказан провайдером (`LEGACY-443`, решение арбитра
   * 08.10.2026): пароль владение адресом не доказывает, и незанятый адрес из списка
   * иначе получал админа у первого, кто его зарегистрировал.
   *
   * ⚠️ Выдача повышенной роли пишет `ROLE_ASSIGNED` той же транзакцией (`LEGACY-015`,
   * решение арбитра 27.09.2026, пачка `T43`): смена ролей журналируется всеми путями,
   * публичность маршрута тут ничего не решает. Актёр `null`, а не сам пользователь —
   * иначе журнал утверждал бы, что он выдал админку себе; путь отличает `source`.
   * Базовая роль события не получает: это не привилегия. Зовётся внутри транзакции,
   * создающей самого пользователя (`register()` и `createSocialUser()`), — `tx` приходит оттуда.
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
    isAddressProven: boolean,
  ): Promise<void> {
    const elevated = isAddressProven ? this.listedRoles(email) : [];
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
    const profile = {
      email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      languagePreference: languagePreference ?? PrismaLanguage.en,
    };

    // Повышенные роли по `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` выдаются только здесь и только
    // адресу, доказанному провайдером (`LEGACY-443`). Вход в уже существующий аккаунт роли
    // не повышает, регистрация паролем даёт одну `user`. Базовые роли уже завёл `socialLogin()`.
    if (identity.emailVerified && this.listedRoles(email).length > 0) {
      return this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({ data: profile, select: ACCOUNT_USER_SELECT });
        await this.grantRegistrationRoles(tx, created.id, created.email, true);
        return created;
      }, REGISTRATION_TX_OPTIONS);
    }

    const userRole = await this.prisma.role.findUnique({ where: { name: RoleName.user } });

    // Роль пишется вложенной записью в тот же `create`, а не отдельным `upsert` следом
    // (`LEGACY-015`, `T67`): вложенную запись Prisma выполняет одной транзакцией, поэтому
    // пользователь без базовой роли снаружи не виден ни миллисекунды — ни админскому
    // `PATCH /users/:id`, ни повторному входу, — и не остаётся таким при обрыве второго
    // запроса. Замок строки `User` (`lockUserRow`) здесь не нужен: строка появляется
    // в базе уже с ролью, окна, которое он закрывал бы, не возникает.
    return this.prisma.user.create({
      data: {
        ...profile,
        roles: userRole ? { create: { roleId: userRole.id } } : undefined,
      },
      select: ACCOUNT_USER_SELECT,
    });
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
    // После сверки пароля: о блокировке узнаёт только тот, кто знает пароль (`LEGACY-452`).
    if (!user.isActive) throw new UnauthorizedException(ACCOUNT_DISABLED_MESSAGE);

    const tokenVersion = await this.markSignIn(user.id);
    const roles = await this.computeRoles(user);
    const tokens = await this.signTokens(user.id, user.email, roles, tokenVersion);

    // Include roles in login response
    return { user: { ...this.publicUser(user), roles }, ...tokens };
  }

  /**
   * Новая пара по живому refresh (`LEGACY-451`, решение арбитра 10.10.2026).
   *
   * ⚠️ Refresh **не продлевает** сессию: новая пара наследует `exp` исходного refresh, access
   * живёт не дольше него. Пока каждый вызов выдавал refresh на полный срок, украденный токен
   * продлевал сессию бесконечно. Теперь сессия кончается через `JWT_REFRESH_EXPIRES_IN`
   * от входа, а раньше — при `tokenVersion++` (выход, пароль, роли, блокировка).
   */
  async refresh(dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = await this.verifyRefreshToken(dto.refreshToken);

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, isActive: true, tokenVersion: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (!user.isActive) throw new UnauthorizedException(ACCOUNT_DISABLED_MESSAGE);
    if (!isSessionAlive(user, payload)) throw new UnauthorizedException(SESSION_REVOKED_MESSAGE);

    const roles = await this.computeRoles(user);
    return this.signTokens(payload.sub, payload.email, roles, user.tokenVersion, payload.exp);
  }

  /**
   * Выход гасит **все** сессии пользователя: `tokenVersion++` (`LEGACY-451`, решение арбитра
   * 10.10.2026). Вход — refresh-токен в теле, а не access в заголовке: к моменту выхода access
   * (15 минут) часто уже истёк, а гасить нужно именно refresh.
   *
   * Подпись и срок проверяются — иначе 401. Версия сравнивается в самом `UPDATE`: токен,
   * уже погашенный прежним выходом, отвечает 200 и версию повторно не поднимает, иначе
   * повтор старого токена гасил бы сессию, открытую после него.
   */
  async logout(dto: RefreshDto): Promise<{ success: true }> {
    const payload = await this.verifyRefreshToken(dto.refreshToken);
    const { count } = await this.prisma.user.updateMany({
      where: { id: payload.sub, tokenVersion: claimedTokenVersion(payload) },
      data: { tokenVersion: { increment: 1 } },
    });
    if (count > 0) sessionStateCache.invalidate(payload.sub);
    return { success: true };
  }

  /**
   * Отметка входа (`lastLogin`) — и единственное чтение версии сессий для подписи.
   *
   * ⚠️ Версия и блокировка берутся **в момент подписи**, условием самой записи. Чтение до
   * `argon2.verify` (или до привязки провайдера) не годится: смена пароля, ролей или блокировка
   * за это время выдала бы токены уже погашенной версии — «вход удался» и тут же 401.
   * Роли читаются **после** неё: смена ролей поднимает версию той же транзакцией, поэтому
   * роли, прочитанные позже версии, не старше её — токен с новой `tv` и старыми ролями
   * не выдаётся.
   * Заблокированная строка под условие `isActive: true` не попадает: `P2025` — 401, и `lastLogin`
   * ей не пишется.
   */
  private async markSignIn(
    userId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    try {
      const { tokenVersion } = await client.user.update({
        where: { id: userId, isActive: true },
        data: { lastLogin: new Date() },
        select: { tokenVersion: true },
      });
      return tokenVersion;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new UnauthorizedException(ACCOUNT_DISABLED_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * Подпись и срок refresh-токена. Отказ проверки токена — 401, а не 500 из библиотеки.
   *
   * ⚠️ Перехват узкий: `JsonWebTokenError` и его наследники (`TokenExpiredError`,
   * `NotBeforeError`). Секрет читается до `try` — ошибка конфигурации остаётся 500 и уходит
   * в Sentry, а не притворяется негодным токеном каждого пользователя.
   */
  private async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    const secret = this.secret(JWT_REFRESH_SECRET_ENV);
    try {
      return await this.jwt.verifyAsync<RefreshTokenPayload>(token, { secret });
    } catch (error) {
      if (error instanceof JsonWebTokenError) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      throw error;
    }
  }

  /**
   * @param tokenVersion claim `tv` обоих токенов; сверяется в `JwtStrategy` и в `refresh`.
   * @param refreshExp `exp` исходного refresh (секунды) — только из `refresh`: новая пара его
   *   наследует, access обрезается до него же. Без него — полные сроки из окружения.
   */
  private async signTokens(
    userId: string,
    email: string,
    roles: RoleName[],
    tokenVersion: number,
    refreshExp?: number,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessSecret = this.secret(JWT_ACCESS_SECRET_ENV);
    const refreshSecret = this.secret(JWT_REFRESH_SECRET_ENV);
    const accessExpiresIn = readJwtAccessExpiresIn((key) => this.config.get<string>(key));
    const refreshExpiresIn = readJwtRefreshExpiresIn((key) => this.config.get<string>(key));

    // `iat` задаётся явно: `jsonwebtoken` считает `exp = iat + expiresIn`, и унаследованный
    // срок выходит точным, а не со сдвигом на смену секунды между двумя вызовами.
    const iat = Math.floor(Date.now() / 1000);
    const payload: SessionTokenClaims & { roles: RoleName[]; iat: number } = {
      sub: userId,
      email,
      roles,
      tv: tokenVersion,
      iat,
    };
    // `Math.max`: refresh, истекающий в эту же секунду, даёт уже мёртвую пару, а не ошибку подписи.
    const remaining = refreshExp === undefined ? undefined : Math.max(0, refreshExp - iat);

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, { secret: accessSecret, expiresIn: accessExpiresIn }),
      this.jwt.signAsync(payload, {
        secret: refreshSecret,
        expiresIn: remaining ?? refreshExpiresIn,
      }),
    ]);
    if (remaining === undefined) return { accessToken, refreshToken };

    // Срок access задан строкой окружения (`'15m'`) и в секунды здесь не переводится:
    // переподписывается только тот access, что пережил бы свой refresh.
    const { exp } = this.jwt.decode<{ exp: number }>(accessToken);
    if (exp <= iat + remaining) return { accessToken, refreshToken };
    return {
      accessToken: await this.jwt.signAsync(payload, {
        secret: accessSecret,
        expiresIn: remaining,
      }),
      refreshToken,
    };
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
   * request. The lists now only bootstrap the first administrator when an account
   * is created by a provider sign-in with a verified address (`createSocialUser`,
   * LEGACY-443), which writes the role into `UserRole`; {@link register} never elevates.
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
