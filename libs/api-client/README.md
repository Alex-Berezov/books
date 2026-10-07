# libs/api-client: снимок контракта OpenAPI

Здесь лежит машинная копия публичного контракта API. Главное в каталоге — снимок схемы;
остальное сгенерировано из него или оставлено как пример.

## Что внутри

- `api-schema.json` — закоммиченный снимок схемы OpenAPI, собранный из кода (`LEGACY-016`).
  Его читают:
  - `src/common/testing/openapi-snapshot.spec.ts` — на каждом `yarn test` собирает схему
    из контроллеров и сверяет со снимком: смена маршрута, параметра или поля ответа краснеет
    и видна в диффе этого файла;
  - `yarn check:response-schema` (`scripts/check-response-schema.mjs`) — схема ответа
    не беднее того, что реально отдаёт контроллер;
  - фронт `books-front`: `yarn check:type-sync` сверяет рукописные типы
    `types/api-schema/**` с копией этого файла (`scripts/type-sync/api-schema.json`
    во фронте).
- `src/types.ts` — типы `paths`/`components`, сгенерированные `openapi-typescript`
  из `api-schema.json`. Обязан совпадать с выводом генератора побайтно — это проверяет
  `src/common/testing/api-client-types.spec.ts`.
- `src/index.ts`, `package.json`, `tsconfig.json`, `examples/` — клиент на axios и примеры
  к нему. Ни бэкенд, ни `books-front` их не импортируют; сборка — `yarn api-client:build`.

## Как обновить после смены контракта

Из корня репозитория:

```bash
yarn openapi:snapshot            # пересобрать api-schema.json из кода
yarn openapi:types:from-schema   # перегенерировать src/types.ts из снимка
```

Дифф `api-schema.json` прочитайте глазами: это и есть описание того, что увидит клиент.
В CI режим обновления снимка не включается — спека только сверяет.

⚠️ Не используйте для этого `yarn openapi:schema`, `openapi:schema:prod`, `openapi:types`
и `openapi:types:prod`: они берут схему с запущенного сервера (локального или продового),
а не из кода. Снимок тогда описывает развёртывание, а не репозиторий, а `types.ts`
расходится со снимком и роняет `api-client-types.spec.ts`. Если всё же запускали —
верните файлы командами выше.

## Как фронт получает типы

Копированием `types.ts` — никак. `books-front` пишет типы ответов руками в
`types/api-schema/**` и держит их в согласии с контрактом проверкой `yarn check:type-sync`
против копии `api-schema.json`. Поэтому после смены контракта нужна парная правка во фронте:
обновить копию схемы и рукописные типы.

## Адреса

- Swagger UI: `https://api.bibliaris.com/docs` (локально `http://localhost:5000/docs`).
- Схема OpenAPI: `https://api.bibliaris.com/docs-json` — без префикса `/api`.
- Контракты фронт-бэк описаны в
  [ai-context/api-contracts.md](https://github.com/Alex-Berezov/books-app-docs/blob/main/ai-context/api-contracts.md).
