SHELL := /bin/bash

.PHONY: up down logs ps migrate generate seed dev reset prisma-studio lint typecheck e2e e2e-serial ci

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

migrate:
	yarn prisma:migrate

generate:
	yarn prisma:generate

seed:
	yarn prisma:seed

dev:
	yarn start:dev

reset:
	npx prisma migrate reset --force

prisma-studio:
	yarn prisma:studio

lint:
	yarn lint

typecheck:
	yarn typecheck

e2e:
	yarn test:e2e

e2e-serial:
	yarn test:e2e:serial

ci:
	yarn ci
