import { redactKeys } from './redact.util';
import { RIGHTS_ALLOW_LIST } from './rights-allow-list';

/**
 * Проверки не поведения, а **состава** списка (`LEGACY-334`).
 *
 * 🔴 Список — единственное, что отделяет данные правовой заявки от внешнего сервиса,
 * и ошибиться в нём можно двумя способами, каждый из которых компилятор пропускает.
 * Оба уже случились за один заход: `claimant_type` был внесён и оказался недостижим
 * (маска гасит его раньше), `claim_number` и `person_id` — внесены по ответному DTO,
 * которого ни одна ручка не принимает. Обе строки читались как разрешение.
 */
describe('RIGHTS_ALLOW_LIST', () => {
  const keys = Array.from(RIGHTS_ALLOW_LIST);

  it('🔴 ни один ключ списка не гасится маской раньше самого списка', () => {
    // Порядок проверок в `redactByKey` — секрет, почта, персональное, список.
    // Ключ, совпавший с любой из трёх масок, до списка не доходит: строка мертва,
    // а следующий читатель поймёт её как «поле разрешено» и пойдёт чинить маску.
    const dead = keys.filter((key) => {
      const out = redactKeys({ [key]: 'PROBE' }, RIGHTS_ALLOW_LIST) as Record<string, unknown>;
      return out[key] !== 'PROBE';
    });

    expect(dead).toEqual([]);
  });

  it('имена уже нормализованы: список сверяется с `normalizeKey`, а не с сырым ключом', () => {
    // `bookVersionId` в списке обязан быть записан как `book_version_id`.
    // Ключ в чужой форме молча не совпадёт ни с чем и стерёт нужное поле.
    const wrong = keys.filter((key) => key !== key.toLowerCase() || /[^a-z0-9_]/.test(key));

    expect(wrong).toEqual([]);
  });

  it('в списке нет свободного текста: критерий отбора закрытый', () => {
    // Строка свободной формы не берётся ни при каких обстоятельствах — решение
    // арбитра от 30.08.2026. Здесь ловится не всякая ошибка отбора, а самая частая:
    // имя, по которому видно, что внутри проза.
    //
    // ⚠️ Исключения названы поимённо, чтобы список нельзя было расширить молча.
    // `source_text_type` — перечисление вида текста-источника, а не текст.
    // `reason` — перечисление `RightsRecheckReason` (`list-recheck-tasks.dto.ts:24-27`,
    // `create-recheck-task.dto.ts:19-20`), внесено 01.09.2026 по сторожу полноты
    // (`LEGACY-338`). Прозаический сосед у него отдельный и в список не идёт:
    // `reason_ru` из девяти DTO — свободный текст.
    const ENUM_EXCEPTIONS = new Set(['source_text_type', 'reason']);

    const prose = keys.filter(
      (key) =>
        !ENUM_EXCEPTIONS.has(key) &&
        /(^|_)(q|text|texts|description|descriptions|notes|note|reason|title|comment)(_|$)/.test(
          key,
        ),
    );

    expect(prose).toEqual([]);
  });

  it('ключ из списка проходит наружу, а не перечисленный рядом — стирается', () => {
    const out = redactKeys({ status: 'OPEN', descriptionRu: 'проза' }, RIGHTS_ALLOW_LIST) as Record<
      string,
      unknown
    >;

    expect(out.status).toBe('OPEN');
    expect(out.descriptionRu).toBe('[Filtered]');
  });
});
