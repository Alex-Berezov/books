import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Разбор метаданных `@Module` по исходнику, а не по `Reflect`.
 *
 * Зачем по тексту: сторожа единственности провайдера должны видеть **объявление**
 * в файле, а не результат сборки контейнера. Контейнер после дубля собирается
 * молча — в том и дефект (`LEGACY-130`, `LEGACY-259`).
 *
 * ⚠️ Две ловушки, и обе дают молчаливо неверный ответ.
 *
 * 1. **Скобки надо считать, а не сопоставлять регуляркой.** Ленивое
 *    `\[[\s\S]*?\]` заканчивает массив на первой же `]`, а внутри `providers`
 *    они бывают вложенные: у `HealthModule` там `inject: [ConfigService]`
 *    в пятой строке массива длиной в двадцать пять. Дописанный ниже провайдер
 *    в такой блок не попадает — сторож зелен при вернувшемся дефекте.
 * 2. **Считать надо элементы, а не вхождения имени в текст.** Тот же
 *    `HealthModule` называет `PrismaService` внутри массива дважды законно —
 *    типом параметра `useFactory` и токеном в `inject`. Поиск по тексту блока
 *    объявляет нарушением фабрику, которой сервис нужен аргументом, и правило
 *    начинают обходить, а не соблюдать.
 *
 * Отсюда разбор до элементов: запятые считаются только на нулевой глубине,
 * скобки всех трёх видов и строковые литералы пропускаются целиком.
 */

/** Все файлы `*.module.ts` под каталогом, рекурсивно. */
export const listModuleFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listModuleFiles(full);
    return entry.isFile() && entry.name.endsWith('.module.ts') ? [full] : [];
  });

/** Элементы верхнего уровня всех массивов `<key>: [...]` файла. */
export const metadataElements = (content: string, key: string): string[] => {
  const elements: string[] = [];
  const opener = new RegExp(`${key}:\\s*\\[`, 'g');
  let match: RegExpExecArray | null;

  while ((match = opener.exec(content)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    let current = '';

    for (let i = match.index + match[0].length; i < content.length; i += 1) {
      const ch = content[i];

      if (quote) {
        if (ch === quote && content[i - 1] !== '\\') quote = null;
        current += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === '[' || ch === '{' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ')') depth -= 1;
      else if (ch === ']') {
        if (depth === 0) {
          elements.push(current);
          opener.lastIndex = i + 1;
          break;
        }
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        elements.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
  }

  return elements.map((element) => element.trim()).filter(Boolean);
};

/**
 * Объявляет ли элемент массива `providers` собственный экземпляр `name`.
 *
 * Форм две, и вторую легко не заметить: голое имя класса и фабрика, которая
 * делает `new <name>(` в своём теле. Проверка «элемент равен имени» ловит только
 * первую, и `providers: [{ provide: X, useFactory: () => new PrismaService() }]`
 * проходит мимо обоих слоёв защиты — и мимо правила хука, и мимо сторожа.
 *
 * Токен в `inject` и тип параметра `useFactory` объявлением **не** считаются:
 * фабрика, которой сервис нужен аргументом, получает его от инжектора и своего
 * экземпляра не заводит.
 */
export const declaresOwnInstance = (element: string, name: string): boolean =>
  element === name || new RegExp(`\\bnew\\s+${name}\\s*\\(`).test(element);
