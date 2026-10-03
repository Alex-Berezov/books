# ast-index Rules

Инструмент структурного поиска по коду (AST-индекс в SQLite). Быстрее grep и
возвращает структурированный результат, поэтому экономит контекст.

## Когда что

Поиск символов, их использований, реализаций и структуры кода начинай с `ast-index`: он дешевле
по контексту, и его ответа на структурный вопрос обычно достаточно — повторять тот же поиск
grep'ом не нужно. Grep/Glob нужен, когда:

- `ast-index` вернул пустой результат;
- нужен regex (в `ast-index` — литеральное совпадение);
- ищем строковый литерал внутри кода (`"some text"`);
- ищем по содержимому комментариев;
- ищем в не-кодовых файлах (`.md`, `.prisma`, `.sql`, `.json`, `.yaml`);
- ссылка живёт строкой, а не символом: `prisma['model']`, ключи `select`/`include`
  (`select: { relation: true }`), имена в декораторах — `usages` такие места не находит.

`prisma/schema.prisma` и SQL-миграции индексом не покрываются — по ним
работаем Read/Grep.

## Command Reference

| Задача                | Команда                                  |
| --------------------- | ---------------------------------------- |
| Универсальный поиск   | `ast-index search "query"`               |
| Класс / интерфейс     | `ast-index class "Name"`                 |
| Символ                | `ast-index symbol "Name"`                |
| Использования         | `ast-index usages "Name"`                |
| Реализации интерфейса | `ast-index implementations "Interface"`  |
| Дерево вызовов        | `ast-index call-tree "fn" --depth 3`     |
| Вызывающие            | `ast-index callers "fnName"`             |
| Аутлайн файла         | `ast-index outline "src/x/y.service.ts"` |
| Импорты файла         | `ast-index imports "src/x/y.service.ts"` |
| Файл по имени         | `ast-index file "books.service"`         |
| TODO/FIXME            | `ast-index todo`                         |

## NestJS / TypeScript

| Задача               | Команда                          |
| -------------------- | -------------------------------- |
| Контроллеры          | `ast-index search "@Controller"` |
| Сервисы              | `ast-index class "Service"`      |
| DTO                  | `ast-index class "Dto"`          |
| Guards / декораторы  | `ast-index search "@UseGuards"`  |
| Где вызывается метод | `ast-index usages "findBySlug"`  |

## Управление индексом

- `ast-index rebuild` — полная переиндексация (после clone или крупного merge).
- `ast-index update` — инкрементально; запускать после `git pull`, смены ветки
  и после серии собственных правок, **до** следующего поиска.
- `ast-index stats` — статистика индекса.

База индекса лежит вне репозитория
(`%LOCALAPPDATA%\ast-index\<hash>\index.db`), в `.gitignore` добавлять нечего.
