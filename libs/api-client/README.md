# libs/api-client: снимок контракта OpenAPI

Здесь лежит машинная копия публичного контракта API. Главное в каталоге — снимок схемы;
остальное сгенерировано из него.

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

Клиент на axios, примеры к нему и `package.json` npm-пакета сняты 08.10.2026: их никто
не импортировал, каталог не является пакетом и не входит ни в workspaces, ни в сборку.

## Как обновить после смены контракта

Из корня репозитория:

```bash
yarn openapi:snapshot            # пересобрать api-schema.json из кода
yarn openapi:types:from-schema   # перегенерировать src/types.ts из снимка
```

Дифф `api-schema.json` прочитайте глазами: это и есть описание того, что увидит клиент.
В CI режим обновления снимка не включается — спека только сверяет.

Других способов обновить снимок нет: `yarn openapi:schema*` и `openapi:types`/`openapi:types:prod`,
которые брали схему с запущенного сервера, удалены 08.10.2026 — снимок с ними описывал
развёртывание, а не репозиторий, и `types.ts` расходился со снимком. Изменили
`api-schema.json` или `src/types.ts` руками или чем-то ещё — верните их командами выше.

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
