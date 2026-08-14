import { Role } from '../decorators/roles.decorator';

/**
 * Кэш ролей, общий на процесс (`LEGACY-112`).
 *
 * 🔴 Почему он живёт вне `RolesGuard`, а не полем в нём. Nest создаёт гвард
 * **по экземпляру на модуль**: `GuardsContextCreator.getInstanceByMetatype`
 * ищет класс в `moduleRef.injectables` того модуля, где объявлен контроллер,
 * и в каждом таком модуле получается своя запись. Контроллеров с `RolesGuard`
 * здесь больше пятнадцати — значит и приватных `Map` было бы больше
 * пятнадцати, а `invalidate` на одном экземпляре очистил бы одну из них.
 * Сброс, который срабатывает через раз, хуже отсутствия сброса: он выглядит
 * рабочим.
 *
 * ⚠️ Кэш общий только внутри одного процесса Node. Экземпляров приложения
 * может быть несколько, и снятие роли на одном из них не гасит запись на
 * другом — там она уходит по `ROLES_CACHE_TTL_MS`. Общего хранилища для этого
 * не заводится: ради секунд задержки не стоит вносить Redis в путь каждой
 * проверки прав.
 */

/**
 * Потолок числа записей. Ключ — `userId`, поэтому без потолка карта растёт по
 * числу когда-либо заходивших пользователей и в долгоживущем процессе не
 * освобождается никогда.
 */
export const ROLES_CACHE_MAX_ENTRIES = 5000;

/**
 * Сколько записей остаётся после вытеснения. Вытеснять ровно до потолка нельзя:
 * следующая же запись снова упирается в него, и каждый промах кэша начинает
 * обходить всю карту дважды.
 */
const EVICT_DOWN_TO = Math.floor(ROLES_CACHE_MAX_ENTRIES * 0.9);

type Entry = { roles: Set<Role>; exp: number };

class RolesCache {
  private readonly entries = new Map<string, Entry>();

  /**
   * Номер поколения. Растёт на каждом сбросе и решает судьбу чтений, начатых
   * до него: см. `beginRead` и `set`.
   */
  private generation = 0;

  /**
   * Отметка «читаю из базы». Возвращённое значение отдаётся обратно в `set`.
   *
   * 🔴 Без неё сброс работает через раз. Запрос, вошедший в гвард **до** отзыва
   * роли, промахивается по кэшу и уходит за ролями в базу; ответ он получает
   * старый, а записать успевает уже **после** `invalidate` — и кладёт снятую
   * роль обратно на весь TTL. Окно узкое, но это ровно тот дефект, который
   * закрывает `LEGACY-112`, только незаметнее.
   */
  beginRead(): number {
    return this.generation;
  }

  /** Роли пользователя, если запись есть и не просрочена; иначе `undefined`. */
  get(userId: string, now: number): ReadonlySet<Role> | undefined {
    const entry = this.entries.get(userId);
    if (!entry) return undefined;
    if (entry.exp <= now) {
      this.entries.delete(userId);
      return undefined;
    }
    // Наружу отдаётся только чтение: `Set` тут общий на всех, и один `add`
    // над результатом выдал бы лишнюю роль каждому следующему запросу.
    return entry.roles;
  }

  /**
   * @param readGeneration значение `beginRead()`, взятое **до** чтения ролей
   *   из базы. Если с тех пор был сброс, запись отбрасывается.
   */
  set(userId: string, roles: Set<Role>, exp: number, now: number, readGeneration: number): void {
    if (readGeneration !== this.generation) return;
    // Перезапись через удаление: `Map` держит порядок вставки, и свежая запись
    // должна оказаться в конце очереди на вытеснение, а не остаться в начале.
    this.entries.delete(userId);
    if (this.entries.size >= ROLES_CACHE_MAX_ENTRIES) this.evict(now);
    this.entries.set(userId, { roles, exp });
  }

  /** Сброс роли конкретного пользователя — зовётся после записи в `UserRole`. */
  invalidate(userId: string): void {
    this.entries.delete(userId);
    // Поколение общее, а не по пользователю: карта «userId → время сброса»
    // растёт так же, как сам кэш, и её пришлось бы чистить тем же способом.
    // Цена общего счётчика — отброшенные чтения других пользователей в тот же
    // миг; записи в `UserRole` редки, и такой промах стоит одного запроса.
    this.generation += 1;
  }

  /** Полный сброс. Нужен спекам: состояние общее на процесс и течёт между ними. */
  clear(): void {
    this.entries.clear();
    this.generation += 1;
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [userId, entry] of this.entries) {
      if (entry.exp <= now) this.entries.delete(userId);
    }
    // Просроченных не хватило — вытесняем самые старые по порядку вставки.
    for (const userId of this.entries.keys()) {
      if (this.entries.size <= EVICT_DOWN_TO) break;
      this.entries.delete(userId);
    }
  }
}

export const rolesCache = new RolesCache();
