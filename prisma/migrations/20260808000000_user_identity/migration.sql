-- Идентичность провайдера отделяется от email (NEXT-SESSION §5, LEGACY-070).
--
-- До этой таблицы вход через провайдера искал пользователя по email. Это значит,
-- что владелец почтового адреса входил в аккаунт, заведённый паролем, минуя пароль.
-- Для Google с `email_verified === true` такое связывание стандартно, для провайдера
-- со слабым подтверждением адреса — нет, и именно эта асимметрия делала email
-- негодным ключом идентичности.
--
-- Бэкфилла нет и быть не может: `providerUserId` прошлых входов нигде не сохранялся.
-- Существующие аккаунты привяжутся сами при следующем входе через провайдера —
-- по подтверждённому адресу, один раз (см. AuthService.issueSocialSession).

CREATE TABLE "UserIdentity" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "provider"       TEXT NOT NULL,
  "providerUserId" TEXT NOT NULL,
  "email"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt"    TIMESTAMP(3),

  CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

-- Ключ идентичности. Пара обязана быть уникальной глобально: она и есть «кто вошёл».
CREATE UNIQUE INDEX "UserIdentity_provider_providerUserId_key"
  ON "UserIdentity" ("provider", "providerUserId");

CREATE INDEX "UserIdentity_userId_idx" ON "UserIdentity" ("userId");

-- ON DELETE CASCADE: удаление пользователя не должно оставлять привязку, по которой
-- следующий вход тем же провайдером получил бы ссылку на несуществующий аккаунт.
ALTER TABLE "UserIdentity"
  ADD CONSTRAINT "UserIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
