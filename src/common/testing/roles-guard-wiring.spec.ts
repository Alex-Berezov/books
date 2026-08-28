import {
  SRC_ROOT,
  decoratorBlocks,
  guardsInclude,
  listControllerFiles,
  readController,
  relativeToSrc,
  stripComments,
} from './controller-decorators';

/**
 * Сторож связки «`@Roles(...)` — `RolesGuard`» (`LEGACY-110`).
 *
 * Глобального `RolesGuard` в приложении нет: в `APP_GUARD` лежат только
 * `GlobalRateLimitGuard` и `LanguageResolverGuard`. Значит `@Roles(...)` без
 * `RolesGuard` в том же `@UseGuards(...)` не проверяет ничего — метаданные
 * `ROLES_KEY` некому прочитать, и маршрут открыт любому аутентифицированному.
 * Ни типы, ни линт, ни Swagger такой маршрут от закрытого не отличают:
 * декоратор корректен сам по себе, а замок в документации рисует
 * `@ApiBearerAuth()`.
 *
 * ⚠️ Проверка идёт **по обработчикам, а не по файлам**: `RolesGuard`,
 * упомянутый где-то в файле, ничего не говорит о соседнем методе, у которого
 * свой `@UseGuards(...)`. Файловой проверки хватило бы ровно до первого
 * контроллера, где гвард стоит на одном маршруте из трёх.
 *
 * ⚠️ Порог обхода задан не «на глазок», а сверкой с сырым числом вхождений
 * `@Roles(` в тех же файлах. Разбор декораторов может сломаться так, что часть
 * обработчиков просто перестанет считаться, — и мягкая нижняя граница этого
 * не заметит.
 *
 * Сам разбор декораторов вынесен в `controller-decorators.ts`: тем же разбором
 * собирается список закрытых маршрутов в
 * `test/closed-routes-unauthorized.e2e-spec.ts` (`LEGACY-234`).
 */

/** Ниже этого числа обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_CONTROLLERS = 40;
const MIN_ROLES_HANDLERS = 150;

/**
 * ⚠️ По границам слова, а не подстрокой: `RolesGuard` входит в любой будущий
 * `SoftRolesGuard`, который ролей не читает, — и такой маршрут считался бы
 * закрытым при зелёном стороже.
 */
const hasRolesGuard = (text: string): boolean => guardsInclude(text, 'RolesGuard');

describe('@Roles is always backed by RolesGuard', () => {
  const controllers = listControllerFiles(SRC_ROOT);

  const unguarded: string[] = [];
  let handlersWithRoles = 0;
  let rawRolesOccurrences = 0;

  for (const file of controllers) {
    const content = readController(file);
    rawRolesOccurrences += (stripComments(content).match(/@Roles\s*\(/g) ?? []).length;

    const blocks = decoratorBlocks(content);
    const classGuarded = blocks.some(
      (block) => block.ownerLine.includes('class ') && hasRolesGuard(block.text),
    );

    for (const block of blocks) {
      if (!/@Roles\s*\(/.test(block.text)) continue;
      handlersWithRoles += 1;
      if (classGuarded || hasRolesGuard(block.text)) continue;
      unguarded.push(`${relativeToSrc(file)} → ${block.ownerLine}`);
    }
  }

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it(`находит не меньше ${MIN_ROLES_HANDLERS} обработчиков с @Roles`, () => {
    expect(handlersWithRoles).toBeGreaterThanOrEqual(MIN_ROLES_HANDLERS);
  });

  it('видит все @Roles до единого — разбор декораторов ничего не потерял', () => {
    expect(handlersWithRoles).toBe(rawRolesOccurrences);
  });

  it('не оставляет ни одного @Roles без RolesGuard', () => {
    expect(unguarded).toEqual([]);
  });
});
