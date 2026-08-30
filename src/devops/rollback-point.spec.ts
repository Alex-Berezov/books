import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Сторож точки отката (`LEGACY-325`).
 *
 * 30.08.2026 выкат `v1.0.15` покраснел на своей проверке версии, и по зависимости
 * из `LEGACY-227` запустился job отката. Он упал сразу: `No image_id in
 * .rollback_info`. То есть отката у выката не было **вовсе** — и не в тот день,
 * а на каждом выкате до него. Спасло только то, что откат упал: он снёс бы
 * исправно выкаченный образ по ложной тревоге.
 *
 * Причина, подтверждённая выводом с боевой машины: `save_current_state` доставал
 * идентификатор образа разбором `docker compose images --format json` через
 * `jq 'map(select(.Service == "app"))'`, а установленный там Docker поля `Service`
 * в этом выводе не отдаёт — там `ContainerName`. Выборка схлопывалась в пустой
 * массив, `.[0].ID` давал `null`, `// ""` записывал пустую строку. Поле `image`
 * тем же путём получало `":"` из `null + ":" + null` — ровно это и лежало
 * в `.rollback_info` на проде.
 *
 * 🔴 Молчание и было настоящим дефектом: файл без `image_id` выглядит как файл,
 * job отката объявлен, зависимость настроена, в отчёте он числится — и узнаёшь
 * ты обо всём этом ровно в тот момент, когда откат понадобился.
 *
 * Спека нужна потому, что `scripts/*.sh` не разбирает ни `tsc`, ни `eslint`,
 * ни `jest`: возврат разбора `compose images` или снятие проверки на пустой
 * идентификатор не покраснеют нигде.
 *
 * ⚠️ Текст скрипта читается **без комментариев**: сам комментарий выше объясняет
 * дефект и потому дословно цитирует и `Service`, и `compose images`. Проверка
 * по сырому тексту ловила бы собственное объяснение и краснела бы всегда, а после
 * «починки» — зеленела бы на вернувшемся дефекте.
 */
const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'deploy_production.sh'), 'utf8');
const LINES = SCRIPT.split(/\r?\n/);

/**
 * Тело функции: от её объявления до закрывающей скобки в первой колонке.
 *
 * ⚠️ Строки внутри heredoc пропускаются. В `save_current_state` есть `cat > ... << EOF`
 * с JSON-телом, и закрывающая скобка этого JSON стоит в первой колонке — то есть выглядит
 * ровно как конец функции. Разбор обрывался на ней, на четыре строки раньше настоящего
 * конца; сейчас всё проверяемое лежит выше обрыва, но это везение, а не расчёт: проверка
 * на хвост функции молча читала бы пустоту (`L-008`).
 */
const functionBody = (name: string): string => {
  const start = LINES.findIndex((line) => line.startsWith(`${name}()`));
  if (start === -1) return '';

  let heredoc: string | null = null;
  let end = -1;
  for (let i = start + 1; i < LINES.length; i += 1) {
    const line = LINES[i];
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const opened = line.match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/);
    if (opened) {
      heredoc = opened[1];
      continue;
    }
    if (line === '}') {
      end = i;
      break;
    }
  }

  return LINES.slice(start, end === -1 ? LINES.length : end)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
};

describe('scripts/deploy_production.sh: точка отката (LEGACY-325)', () => {
  const saveState = (): string => functionBody('save_current_state');

  // Страховка от «проверено ноль строк»: если разбор функции сломается, все
  // проверки ниже начнут сверять пустую строку и молча позеленеют.
  it('функция save_current_state находится и разбирается целиком', () => {
    const body = saveState();
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('ROLLBACK_FILE');
    // ⚠️ Якорь на **последнюю** строку функции, а не на любую её строку: разбор
    // обрывался на закрывающей скобке JSON внутри heredoc, и хвост функции
    // в `body` не попадал вовсе. Эта проверка и стережёт границу.
    expect(body).toContain('log_success "State saved for rollback"');
  });

  it('идентификатор образа берётся у контейнера, а не разбором вывода compose images', () => {
    const body = saveState();

    // `docker inspect --format '{{.Image}}'` отдаёт `sha256:...` — ровно то, что
    // принимает `docker tag` в откате, и формат этот от версии Docker не зависит.
    expect(body).toContain("docker inspect --format '{{.Image}}'");
    expect(body).toMatch(/ps -aq app/);

    // 🔴 Возврат прежнего способа. `Service` в выводе этой версии Docker нет вовсе,
    // поэтому любая выборка по нему снова даст пустую строку.
    expect(body).not.toContain('select(.Service');
    expect(body).not.toMatch(/images --format json/);
  });

  /**
   * 🔴 `ps -aq`, а не `ps -q`. Остановленный контейнер — не отсутствующий: упавший `app`
   * при `-q` выглядит как чистая машина, и точка отката переписывается пустой **поверх
   * годной**. Это возврат той же поломки с другой стороны.
   */
  it('перечисление контейнеров берёт и остановленные', () => {
    const body = saveState();
    expect(body).toMatch(/ps -aq app/);
    expect(body).not.toMatch(/ps -q app/);
  });

  /**
   * ⚠️ Третий исход: «не смог спросить». `local x=$(...)` вернул бы статус `local`,
   * а не подстановки, и отказ демона стал бы неотличим от «контейнера нет».
   */
  it('отказ перечисления — свой отказ, а не «контейнера нет»', () => {
    const body = saveState();
    const guard = body.indexOf('if ! app_containers=$(docker compose');
    expect(guard).toBeGreaterThanOrEqual(0);

    const endOfIf = body.slice(guard).search(/\n\s*fi\b/);
    expect(endOfIf).toBeGreaterThan(0);
    const branch = body.slice(guard, guard + endOfIf);
    expect(branch).toContain('log_error');
    expect(branch).toMatch(/return 1/);
  });

  /**
   * ⚠️ `run_migrations` поднимает контейнер той же службы через `docker compose run --rm`.
   * Переживший прерванный выкат `*-app-run-*` попадёт в ту же выборку, порядок строк
   * не определён — «взять первую» записало бы образ позапрошлого выката молча.
   */
  it('несколько контейнеров службы — отказ, а не выбор наугад', () => {
    const body = saveState();
    const guard = body.indexOf('app_count');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/app_count.*-gt 1/s);

    const check = body.indexOf('-gt 1');
    const endOfIf = body.slice(check).search(/\n\s*fi\b/);
    expect(endOfIf).toBeGreaterThan(0);
    const branch = body.slice(check, check + endOfIf);
    expect(branch).toContain('log_error');
    expect(branch).toMatch(/return 1/);
  });

  it('идентификатор попадает в файл отката', () => {
    const body = saveState();
    expect(body).toContain('"image_id": "$current_image_id"');
  });

  /**
   * ⚠️ Два исхода, а не один. Контейнера нет — законный первый выкат на чистую
   * машину, валить его нельзя. Контейнер есть, а образ не читается — отказ,
   * и он обязан быть слышен: следующий откат на таком файле не состоится.
   */
  it('контейнер есть, а образ не прочитан — это отказ, а не запись пустого поля', () => {
    const body = saveState();
    const check = body.indexOf('-z "$current_image_id"');
    expect(check).toBeGreaterThanOrEqual(0);

    // ⚠️ Граница ветки ищется по слову, а не по подстроке: `indexOf('fi')` находит
    // `fi` внутри `config`, `verify`, `notified` — переформулировка сообщения обрезала бы
    // срез до `return 1`, и проверка покраснела бы на исправном скрипте (`L-008`).
    const endOfIf = body.slice(check).search(/\n\s*fi\b/);
    expect(endOfIf).toBeGreaterThan(0);
    const tail = body.slice(check, check + endOfIf);
    expect(tail).toContain('log_error');
    expect(tail).toMatch(/return 1/);
  });

  it('отсутствие контейнера остаётся предупреждением и выкат не валит', () => {
    const body = saveState();
    const check = body.indexOf('-z "$app_container"');
    expect(check).toBeGreaterThanOrEqual(0);

    const endOfBranch = body.slice(check).search(/\n\s*elif\b/);
    expect(endOfBranch).toBeGreaterThan(0);
    const branch = body.slice(check, check + endOfBranch);
    expect(branch).toContain('log_warning');
    expect(branch).not.toMatch(/return 1/);
  });

  /**
   * Откат читает то же поле, что пишет `save_current_state`. Пара разъедется молча:
   * запись останется, чтение начнёт брать другое имя, и обнаружится это опять же
   * в момент, когда откат понадобился.
   */
  it('откат читает ровно то поле, которое записано', () => {
    const rollback = functionBody('perform_rollback');
    expect(rollback.length).toBeGreaterThan(100);
    expect(rollback).toContain("jq -r '.image_id");
    expect(rollback).toMatch(/docker tag \$rollback_image_id/);
  });
});
