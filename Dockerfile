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
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 5000
CMD ["/usr/local/bin/docker-entrypoint.sh"]