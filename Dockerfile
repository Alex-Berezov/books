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
# LEGACY-100. Чистка мёртвого веса стоит здесь, в builder-стадии, а НЕ в runner после
# `COPY --from=builder /app/node_modules`. Удаление отдельным слоем поверх готового COPY
# веса не снимает вовсе: файлы остаются лежать в нижнем слое, а `RUN rm` кладёт сверху
# только whiteout-записи, и размер образа (сумма слоёв) от этого не падает, а растёт.
# Снять вес можно, только если `COPY --from=builder` копирует уже урезанное дерево.
#
# Что удаляется и почему это безопасно:
# - `@prisma/client/runtime` несёт wasm-компиляторы под все провайдеры Prisma сразу,
#   а схема объявляет только postgresql (`prisma/schema.prisma:2`), доступ идёт через
#   `PrismaPg` (`@prisma/adapter-pg`), сгенерированный клиент лежит в
#   `node_modules/.prisma/client` со своим компилятором и имён чужих провайдеров
#   не содержит. Проверено живым запросом к локальному Postgres при убранных файлах:
#   `$queryRaw SELECT 1` и `user.count()` отвечают как обычно;
# - `@swc/cli` и `@swc/core` не упоминаются больше нигде в репозитории (сборка идёт
#   `nest build --webpack`), и удаляются уже ПОСЛЕ `yarn build`. Проверено: без них
#   грузится и CLI prisma, и `dist/main.js`.
#
# 🔴 Чего здесь быть не должно, сколько бы оно ни весило:
# - `@prisma/studio-core` и `@prisma/dev` - их `require` стоит в бандле CLI
#   (`node_modules/prisma/build/index.js`) на верхнем уровне, а не в ветке команд
#   `prisma studio`/`prisma dev`. Без них падает ЛЮБОЙ вызов `prisma`, включая
#   `migrate deploy` из `scripts/docker-entrypoint.sh` - и падает молча, потому что
#   entrypoint глушит его `|| echo`: контейнер поднимется без применённых миграций.
#   Проверено воспроизведением: `Cannot find module '@prisma/studio-core/data/bff'`;
# - `typescript` и `ts-node` - их требует `prisma db seed` (`LEGACY-294`).
# Сторож на оба случая - `src/devops/dockerfiles.spec.ts`, он сверяет цели чистки
# с графом `require` бандла CLI, а не с текстом этого комментария.
RUN find node_modules/@prisma/client/runtime -type f \
      \( -name '*.cockroachdb.*' -o -name '*.mysql.*' -o -name '*.sqlite.*' -o -name '*.sqlserver.*' \) \
      -delete \
  && rm -rf node_modules/@swc

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package.json yarn.lock ./
# NOTE: Previously we re-ran `yarn install --frozen-lockfile --production=true` here.
# The build failed because `yarn.lock` is out of sync with `package.json`, causing
# Yarn to request a lockfile update which `--frozen-lockfile` forbids.
# For a fast unblock in prod we copy the already installed modules from the builder stage.
# This includes devDependencies.
#
# 🔴 Урезание до production-only здесь не годится (LEGACY-100, проверено и отвергнуто):
# `prisma db seed` зовёт `ts-node ./prisma/seed.ts` (LEGACY-294), а ts-node требует
# `typescript` рядом как peer-зависимость - обе лежат в devDependencies. Урезание
# соберёт образ и запустит `dist/main.js` без единой ошибки, а сид молча упадёт
# только в конвейере фронта, который его зовёт. Это стережёт
# `src/devops/dockerfiles.spec.ts` ("не урезает зависимости до production").
# Мёртвый вес снимается в builder-стадии, до этого COPY, а не после него - см. там же,
# почему удаление поверх готового слоя веса не снимает.
	RUN apk add --no-cache bash openssl
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# LEGACY-100: node_modules скопирован целиком строкой выше - @prisma, .prisma
# и prisma/.bin/prisma уже внутри него. Точечные COPY тех же путей поверх состава
# не меняли, а клали второй слой с теми же файлами: один только дубль `.prisma`
# весил 22.9 МБ (`docker history`).
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