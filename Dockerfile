FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache bash openssl
COPY package.json yarn.lock ./
# NOTE: Temporarily removing --frozen-lockfile due to lockfile drift. For reproducible builds,
# regenerate and commit a correct yarn.lock, then restore the flag.
RUN yarn install
COPY . .
RUN yarn prisma:generate || echo "Prisma generate failed, continuing..."
RUN yarn build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock ./
# NOTE: Previously we re-ran `yarn install --frozen-lockfile --production=true` here.
# The build failed because `yarn.lock` is out of sync with `package.json`, causing
# Yarn to request a lockfile update which `--frozen-lockfile` forbids.
# For a fast unblock in prod we copy the already installed modules from the builder stage.
# This includes devDependencies; later we can optimize by pruning to production-only.
	RUN apk add --no-cache bash openssl
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Prisma runtime bits
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Prisma CLI for migrate deploy (copied from builder where it was installed)
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# Две строки ниже нужны не сборке, а `prisma db seed` внутри контейнера — с 02.09.2026
# его зовёт конвейер фронта, чтобы набор e2e шёл не по пустой базе (`LEGACY-294`).
#
# 🔴 `tsconfig.json`. Команда сида объявлена в `prisma.config.ts` как `ts-node ./prisma/seed.ts`.
# Без файла проекта ts-node отдаёт entry-point загрузчику ESM, и тот падает на расширении:
# `TypeError: Unknown file extension ".ts"`. Воспроизводится прогоном
# `npx ts-node --skipProject prisma/seed.ts`; тот же прогон с файлом проекта проходит.
COPY --from=builder /app/tsconfig.json ./tsconfig.json
# 🔴 `PATH`. Одного `tsconfig.json` мало: CLI prisma запускает команду сида через execa
# **без shell и с `preferLocal: false`** (`node_modules/prisma/build/index.js`: `Dhe(n, {stdout,
# stderr})` → `_he` с умолчанием `preferLocal:!1`), то есть `ts-node` ищется только в `PATH`.
# Базовый `PATH` образа `node:22-alpine` каталога `/app/node_modules/.bin` не содержит,
# и без этой строки `docker exec books-api node_modules/.bin/prisma db seed` падает
# `spawn ts-node ENOENT` — уже после того, как файл проекта на месте.
#
# ⚠️ Локальные прогоны этот случай не воспроизводят: `yarn` и `npx` дополняют `PATH` сами,
# а все прежние вызовы сида шли через них (`test/setup-e2e.ts`, `deploy.yml`). Проверять
# надо тем способом, которым сид зовут в контейнере, а не похожим.
#
# ⚠️ Каталог дописывается в КОНЕЦ, а не в начало: в образе лежат devDependencies целиком
# (строка 22), и приставка спереди поставила бы `ts-node`, `jest`, `eslint` и прочие
# локальные бинари впереди системных. Хвост эту тень не создаёт, а `ts-node` всё равно
# находится - системного с таким именем в образе нет.
ENV PATH="${PATH}:/app/node_modules/.bin"
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p var/uploads
EXPOSE 5000
CMD ["/usr/local/bin/docker-entrypoint.sh"]