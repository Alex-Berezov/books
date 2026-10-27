/**
 * Сводка досье по группам (`F05-Rb`): вход сводки (частичные досье или результаты прошлого
 * уровня) не влез в контекст модели - его делят на группы подряд идущих элементов, каждая
 * влезает. Здесь только чистая арифметика групп; вызовы и хранение - в обработчике и сервисе.
 */

/** Элемент входа уровня: частичное досье куска (уровень 0) или результат группы прошлого уровня. */
export interface GroupItem {
  firstChapter: number;
  lastChapter: number;
  /** То, что уходит в запрос сводки как есть. */
  entry: object;
}

export interface GroupSpan {
  firstItem: number;
  itemCount: number;
  firstChapter: number;
  lastChapter: number;
}

/**
 * Делит элементы на группы подряд идущих, каждая под `fits`. Группа растёт удвоением и
 * уточняется бинарным поиском, так что проб - порядка логарифма размера группы. Обработчик
 * меряет пробу сложением длин (`summaryInputChars`, Р6); `fits` остаётся асинхронным, чтобы
 * граница могла приходить и запросом. `null` - даже один элемент не влезает (`DOSSIER_TOO_LONG`).
 */
export async function packGroups(
  items: readonly GroupItem[],
  fits: (group: readonly GroupItem[]) => Promise<boolean>,
): Promise<GroupSpan[] | null> {
  const spans: GroupSpan[] = [];
  let start = 0;
  while (start < items.length) {
    if (!(await fits(items.slice(start, start + 1)))) return null;
    const left = items.length - start;
    let good = 1;
    if (left === 1) {
      spans.push({
        firstItem: start,
        itemCount: 1,
        firstChapter: items[start].firstChapter,
        lastChapter: items[start].lastChapter,
      });
      break;
    }
    // Удвоение: `bad` - первое число элементов, которое не влезло (или `left + 1`, если влезло всё).
    let bad = left + 1;
    for (let size = 2; ; size *= 2) {
      if (size >= left) {
        if (await fits(items.slice(start, start + left))) good = left;
        else bad = left;
        break;
      }
      if (await fits(items.slice(start, start + size))) good = size;
      else {
        bad = size;
        break;
      }
    }
    while (bad - good > 1) {
      const mid = Math.floor((good + bad) / 2);
      if (await fits(items.slice(start, start + mid))) good = mid;
      else bad = mid;
    }
    const taken = items.slice(start, start + good);
    spans.push({
      firstItem: start,
      itemCount: good,
      firstChapter: Math.min(...taken.map((i) => i.firstChapter)),
      lastChapter: Math.max(...taken.map((i) => i.lastChapter)),
    });
    start += good;
  }
  return spans;
}

/**
 * Число вызовов групп по уровням, когда в вызов помещается `capacity` элементов (оценка
 * сверху для лимита операции). Первый уровень может состоять из групп по одному элементу, дальше
 * уровень обязан сужаться (иначе обработчик отказывает `DOSSIER_TOO_LONG`), то есть в группе
 * не меньше двух. Последний вызов - итоговая сводка из `finalItems` элементов.
 */
export function summaryLevels(
  items: number,
  capacity: number,
): { groupsPerLevel: number[]; finalItems: number } {
  const groupsPerLevel: number[] = [];
  let n = items;
  let size = Math.max(1, capacity);
  while (n > size) {
    n = Math.ceil(n / size);
    groupsPerLevel.push(n);
    size = Math.max(2, capacity);
  }
  return { groupsPerLevel, finalItems: n };
}

/**
 * Уровень групп годится (решение арбитра `F05 | F05-Rb`, Р3): нулевой - любой, выше нулевого -
 * групп не больше половины элементов (вверх) и меньше, чем элементов. Так уровней не больше
 * log2(n), строк групп не больше 2n, а `summaryLevels` остаётся верхней границей. Нечётный хвост
 * из одного элемента отказа не даёт: считается число групп, а не размер каждой.
 */
export function levelNarrows(level: number, items: number, groups: number): boolean {
  return level === 0 || (groups < items && groups <= Math.ceil(items / 2));
}

/**
 * Длина входа сводки (`estimateInputTokens` запроса) по длинам элементов: вход -
 * `Partial dossiers: ${JSON.stringify(parts)}`, поэтому это длина запроса с пустым массивом, плюс
 * длины элементов, плюс запятые между ними. Та же величина без сериализации на каждую пробу
 * упаковки (решение арбитра `F05 | F05-Rb`, Р6).
 */
export function summaryInputChars(emptyChars: number, entryLengths: readonly number[]): number {
  const items = entryLengths.reduce((sum, n) => sum + n, 0);
  return emptyChars + items + Math.max(0, entryLengths.length - 1);
}
