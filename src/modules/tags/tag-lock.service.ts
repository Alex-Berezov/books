import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Границы транзакции, внутри которой строка тега заперта. Совпадают
 * с `CATEGORY_TREE_TX_OPTIONS` и по той же причине (`L-020`): голая
 * `$transaction` даёт дедлайн 5 секунд и `maxWait` 2 секунды, и писатель,
 * дождавшийся своей очереди на замке, отдаёт `P2028` и 500 вместо ответа.
 * Импорт партии держит замок по одному термину за раз, но термин — это базовая
 * строка, история слагов и все переводы, и на медленной машине это не укладывается
 * в пять секунд.
 *
 * ⚠️ Ту же константу берут `TagsService.attach`/`detach` — их транзакции замка
 * не берут (`LEGACY-360`, п.3). Меняя числа под импорт, меняешь и их дедлайн.
 */
export const TAG_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/** Чем адресуется запираемая строка: создатели знают `key`, правка — `id`. */
export type TagLockTarget = { key: string } | { id: string };

/**
 * Пространство имён двухаргументного `pg_advisory_xact_lock(int4, int4)`.
 * Двухаргументная форма живёт в отдельном от одноаргументной (bigint) ключевом
 * пространстве и с `CATEGORY_TREE_LOCK_KEY` не пересекается. Наружу не выставлено
 * по той же причине, что и ключ дерева: замок мимо `lockTag` ничего не стережёт.
 */
const TAG_KEY_LOCK_NAMESPACE = 831_427_002;

/**
 * 🔴 `LEGACY-320`. Запирание строки тега на путях, где снимок участвует
 * в решении, а не только пишется.
 *
 * `ImportService.upsertTag` читает строку внутри транзакции и решает по ней три
 * вещи: писать ли историю базового слага, создавать перевод или обновлять,
 * и есть ли термин вообще. Админский `PATCH /tags/:id {"slug": ...}`,
 * закоммитившийся в окне между чтением и записью, давал битую цепочку
 * редиректов — в отчёте при этом `updated: 1` и пустые `errors`.
 *
 * С 16.09.2026 (`LEGACY-360`) замок берут все, кто создаёт, удаляет или
 * переименовывает строки `Tag`/`TagTranslation`: `update`, `remove`, три ручки
 * переводов (`POST/PATCH/DELETE /tags/:id/translations`) — по `id`; импорт
 * и `POST /tags` — по `key`. Развилка импорта «создать или обновить перевод»
 * решается по снимку строк `TagTranslation`, и эти писатели ждут того же замка.
 *
 * ⚠️ **Не все писатели.** Пересчёт индексируемости
 * (`TaxonomyIndexabilityService.syncTags`/`recomputeAll`) обновляет счётчики
 * `TagTranslation` по `id` на пуле, мимо замка. Развилку импорта это не ломает
 * (строки не создаются и не удаляются), но `P2025` у пересчёта при параллельном
 * `DELETE .../translations/:language` возможен. Писать «закрыто целиком» нельзя
 * (`L-019`).
 *
 * ⚠️ Запирается **строка или ключ одного тега**, а не класс. Общей на все теги
 * очереди нет намеренно (решения арбитра от 29.08.2026 и 03.09.2026): она
 * поставила бы админский `PATCH` в ожидание за партией импорта целиком.
 *
 * ⚠️ **Несуществующую строку `FOR UPDATE` не запирает**, поэтому путь по `key`
 * сначала берёт advisory-замок на хеш ключа (`LEGACY-320`, решение арбитра
 * от 16.09.2026). Без него при `read committed` проба не находила строки,
 * сосед её создавал и коммитил, а следующий `findUnique` той же транзакции
 * уже видел её — и ветка обновления шла по строке, которую замок не держал.
 * Advisory-замок берут оба создателя строки `Tag` (импорт и `TagsService.create`),
 * так что сосед ждёт коммита, а не вклинивается между операторами.
 *
 * Путь по `id` advisory-замка не берёт: строка там существует до входа (иначе
 * 404), и порядок «advisory, потом строка» встречается только на пути по ключу —
 * взаимной блокировки двух путей это не даёт. Коллизия `hashtext` двух разных
 * ключей лишь ставит их в очередь друг за другом; целостность от неё не страдает.
 */
@Injectable()
export class TagLockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ⚠️ Замок берётся **первым** оператором транзакции, и порядок держит эта
   * конструкция, а не комментарий у места вызова (`LEGACY-310`). Транзакция,
   * успевшая тронуть строку до замка, встала бы во взаимную блокировку с чужой.
   */
  async runInLockedTag<T>(
    target: TagLockTarget,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockTag(tx, target);
      return fn(tx);
    }, TAG_TX_OPTIONS);
  }

  /**
   * ⚠️ Сырой SQL живёт **в одном месте** — `Prisma` не умеет `FOR UPDATE`
   * из типизированного клиента вовсе. Копия этого запроса у второго вызывающего
   * означала бы два разных замка на одну строку: именно так разошлись
   * `LEGACY-275` и `LEGACY-308`.
   *
   * Столбцы `id` и `key` — оба `TEXT` (`prisma/migrations/20260705000001_*`),
   * приведения типа не требуется. Значение подставляется параметром тега
   * `$queryRaw`, а не склейкой строки.
   */
  private async lockTag(tx: Prisma.TransactionClient, target: TagLockTarget): Promise<void> {
    // Ветвится **условие**, а не оператор: сам `SELECT ... FOR UPDATE` написан
    // один раз. Две копии оператора разошлись бы при первой же правке одной
    // из них — `NOWAIT`, `SKIP LOCKED`, переименование таблицы, — и один
    // из двух путей записи молча остался бы без замка (`L-017`).
    if ('key' in target) await this.lockTagKey(tx, target.key);

    const where = 'key' in target ? Prisma.sql`key = ${target.key}` : Prisma.sql`id = ${target.id}`;

    await tx.$queryRaw`SELECT id FROM "Tag" WHERE ${where} FOR UPDATE`;
  }

  /**
   * Хеш считается в SQL (`hashtext`), а не в JS: одна функция на всех
   * вызывающих. Вызов из `FROM` — `pg_advisory_xact_lock` возвращает `void`,
   * см. `CategoryTreeService.lockTree`.
   */
  private async lockTagKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$queryRaw`SELECT true AS locked
      FROM pg_advisory_xact_lock(${TAG_KEY_LOCK_NAMESPACE}::int4, hashtext(${key}::text))`;
  }
}
