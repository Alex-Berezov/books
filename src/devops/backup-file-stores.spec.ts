import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Сторож охвата файловых хранилищ резервным копированием (`LEGACY-032`).
 *
 * WP-9 завёл второй файловый том — `rights_files_data_prod`, приватное хранилище
 * юридических файлов прав (отчёты о правах, файлы исходных изданий, архивные копии
 * доказательств). Оснастка копирования знала ровно один том, `uploads_data_prod`,
 * и второй не попадал в бэкап вовсе. При `STORAGE_DRIVER=local` это необратимая
 * потеря против `ADR-009`: строка `RightsEvidence` со ссылкой на несуществующий
 * объект не доказывает ничего.
 *
 * 🔴 Дефект был не в том, что детектор ошибался, а в том, что второго тома
 * в оснастке не существовало — и заметить это было нечем: `scripts/*.sh` не разбирает
 * ни `tsc`, ни `eslint`, ни `jest`, а `test_backup.sh` считал прогон исправным,
 * потому что имени пропавшего архива он не знал. Образец такого сторожа в репозитории
 * уже есть — `rollback-point.spec.ts` (`LEGACY-325`) и `monitoring-wiring.spec.ts`.
 *
 * Здесь проверяется ровно одно: **каждое место, которое держит список файловых
 * хранилищ, знает про оба**. Снятие второго тома из любого из семи файлов красит прогон.
 *
 * ⚠️ Текст скриптов читается **без комментариев**: комментарии в самих скриптах
 * объясняют дефект и потому дословно называют и том, и хранилище. Проверка по сырому
 * тексту зеленела бы на одном объяснении, переживя удаление самого кода.
 */
const ROOT = resolve(__dirname, '..', '..');

const readScript = (name: string): string =>
  readFileSync(join(ROOT, 'scripts', name), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const BACKUP = readScript('backup_database.sh');
const RESTORE = readScript('restore_database.sh');
const TEST_BACKUP = readScript('test_backup.sh');
const CHECK_STATUS = readScript('check_backup_status.sh');
const SETUP_SERVER = readScript('setup_server.sh');
const SETUP_SECURITY = readScript('setup_security.sh');
const SETUP_CRON = readScript('setup_backup_cron.sh');

const RIGHTS_VOLUME = 'rights_files_data_prod';
const RIGHTS_SLUG = 'rights-files';

describe('LEGACY-032: оснастка копирования знает оба файловых хранилища', () => {
  describe('backup_database.sh создаёт архив второго хранилища', () => {
    it('объявляет том, каталог и выключатель приватного хранилища', () => {
      expect(BACKUP).toContain('RIGHTS_FILES_DOCKER_VOLUME=');
      expect(BACKUP).toContain('RIGHTS_FILES_DIR=');
      expect(BACKUP).toContain('INCLUDE_RIGHTS_FILES=');
    });

    it('зовёт создание архива прав отдельно от архива загрузок', () => {
      expect(BACKUP).toContain('backup_rights_files()');
      expect(BACKUP).toContain(RIGHTS_VOLUME);
      expect(BACKUP).toMatch(/backup_rights_files "\$backup_type"/);
      expect(BACKUP).toMatch(/backup_uploads "\$backup_type"/);
    });

    it('обёртка прав берёт СВОЙ том и СВОЙ каталог, а не чужие', () => {
      // Ровно этим дефектом заканчивается копипаста обёртки: архив прав создаётся,
      // называется правильно, проходит проверку целостности - и содержит файлы загрузок.
      // Ни одна проверка на имя архива такого не ловит, только сверка аргументов.
      expect(BACKUP).toMatch(
        /backup_rights_files\(\) \{\s*\n\s*backup_file_store rights-files "Rights files" rights_files_data_prod \\\s*\n\s*"\$\{RIGHTS_FILES_DOCKER_VOLUME:-\}" "\$RIGHTS_FILES_DIR"/,
      );
      expect(BACKUP).toMatch(
        /backup_uploads\(\) \{\s*\n\s*backup_file_store uploads "Uploads\/media" uploads_data_prod \\\s*\n\s*"\$\{UPLOADS_DOCKER_VOLUME:-\}" "\$UPLOADS_DIR"/,
      );
    });

    it('отдаёт архив прав в отчёт и во внешнее хранилище', () => {
      expect(BACKUP).toContain('$rights_files_backup_file');
      expect(BACKUP).toMatch(/upload_to_remote "\$rights_files_backup_file"/);
    });

    it('кладёт архив прав под приватный префикс ADR-015 и чистит его ретенцией', () => {
      // Приватность объектов держится на сегменте ключа `rights-private/`: по нему
      // стоит правило Cloudflare WAF. Ключ без него открыл бы юридический архив наружу,
      // если бакет копий совпадает с медийным.
      expect(BACKUP).toContain('BACKUP_S3_RIGHTS_PREFIX=');
      expect(BACKUP).toMatch(/BACKUP_S3_RIGHTS_PREFIX="\$\{BACKUP_S3_PREFIX\}\/rights-private"/);
      // Сама выгрузка обязана получить приватный префикс: объявленная, но неиспользованная
      // переменная оставила бы юридический архив на общем пути, а проверка объявления
      // при этом осталась бы зелёной.
      expect(BACKUP).toMatch(
        /upload_to_remote "\$rights_files_backup_file" "\$backup_type" "\$BACKUP_S3_RIGHTS_PREFIX"/,
      );
      expect(BACKUP).toMatch(
        /cleanup_remote_old_backups "\$backup_type" "\$BACKUP_S3_RIGHTS_PREFIX"/,
      );
    });

    it('не выдаёт отказ хранилища за успешную ночь', () => {
      // Копия юридических файлов не создалась, а метрика свежая - худший из исходов:
      // задания крона оканчиваются на `>/dev/null 2>&1`, и метрика - единственный сигнал,
      // покидающий машину (LEGACY-219).
      // Отметку ставят ОБА хранилища, и она же решает код возврата. Проверка на одно
      // вхождение зеленела бы, когда отметку перестало ставить одно из двух.
      const marks = BACKUP.match(/store_backup_failed=true/g) ?? [];
      expect(marks).toHaveLength(2);
      expect(BACKUP).toMatch(/if \[\[ "\$store_backup_failed" == "true" \]\]; then/);
      expect(BACKUP).toMatch(/store_backup_failed[\s\S]{0,600}write_backup_success_metric/);
    });

    it('различает пустое хранилище и пропавшее', () => {
      // Пустой том штатен при STORAGE_DRIVER=r2 и обязан оставаться нулевым исходом,
      // иначе ночной бэкап на сегодняшнем проде станет красным каждый прогон.
      expect(BACKUP).toMatch(/enabled but neither Docker volume nor host directory found/);
    });
  });

  describe('restore_database.sh возвращает второе хранилище на место', () => {
    it('зовёт восстановление прав отдельно от загрузок', () => {
      expect(RESTORE).toContain('restore_rights_files()');
      expect(RESTORE).toContain(RIGHTS_VOLUME);
      expect(RESTORE).toMatch(/restore_rights_files "\$rights_files_backup_file"/);
    });

    it('не даёт отказу одного хранилища отменить второе', () => {
      // Обе функции возвращают 1 при неудаче и зовутся под `set -e`: голым вызовом первая
      // неудача унесла бы с собой то хранилище, потеря которого необратима.
      expect(RESTORE).toMatch(
        /restore_uploads "\$uploads_backup_file" \|\| store_restore_failed=true/,
      );
      expect(RESTORE).toMatch(
        /restore_rights_files "\$rights_files_backup_file" \|\| store_restore_failed=true/,
      );
    });

    it('ищет архив хранилища по частям имени дампа, а не подстановкой по образцу', () => {
      // `sed 's/bibliaris-prod-[^-]*-/.../'` съедает только первый сегмент типа копии,
      // поэтому на `before-deploy` точное имя не совпадало никогда - то есть ровно
      // на предвыкатных копиях, ради которых откат и делается.
      expect(RESTORE).toContain('find_store_archive()');
      expect(RESTORE).toMatch(/backup_type=\$\(basename "\$dir"\)/);
      expect(RESTORE).toMatch(/find_store_archive "\$backup_file" rights-files/);
    });

    it('ограничивает запасной поиск архива окном по времени', () => {
      // Без окна «ближайшим» оказался бы архив чужого прогона из ротации за месяц -
      // и распаковался бы поверх тома, смешав два поколения доказательств.
      expect(RESTORE).toContain('window_seconds');
      expect(RESTORE).toMatch(/if \[\[ \$delta -gt \$window_seconds \]\]; then/);
    });

    it('не раздаёт приватное хранилище правами публичной статики', () => {
      // ADR-015: отчёты юриста и персональные данные заявителей не читаются любым
      // локальным аккаунтом и любым контейнером, смонтировавшим /opt/books.
      expect(RESTORE).toMatch(/"\$RIGHTS_FILES_DIR" 750/);
    });

    it('не кладёт страховочный снимок хранилища в общий /tmp', () => {
      // В /tmp снимок создавался с правами 644 в каталоге 1777 и лежал до перезагрузки:
      // весь юридический архив целиком читал любой процесс на машине.
      expect(RESTORE).toContain('snapshot_dir');
      expect(RESTORE).not.toMatch(/backup_current="\/tmp\//);
    });
  });

  describe('test_backup.sh проверяет архивы обоих хранилищ', () => {
    it('зовёт проверку прав отдельно от проверки загрузок', () => {
      expect(TEST_BACKUP).toContain('check_rights_files_backups()');
      expect(TEST_BACKUP).toMatch(/check_rights_files_backups\s*$/m);
      expect(TEST_BACKUP).toContain(`\${BACKUP_PREFIX}-${RIGHTS_SLUG}`);
    });

    it('не краснеет на законно пустом хранилище', () => {
      // Условие приёмки LEGACY-032: при STORAGE_DRIVER=r2 том пуст, архива нет, и это
      // не отказ. fail_test здесь красил бы исправную машину каждую ночь, а дежурный,
      // привыкший к ложной тревоге, пропустил бы настоящую.
      expect(TEST_BACKUP).not.toMatch(/fail_test "\$\{store_label\} enabled but no backups found"/);
    });
  });

  describe('оснастка машины знает про второй том', () => {
    it('check_backup_status.sh видит архив прав в проверке свежести', () => {
      expect(CHECK_STATUS).toContain(`\${BACKUP_PREFIX}-${RIGHTS_SLUG}-*.tar.gz`);
    });

    it('оба скрипта подготовки сервера создают каталог хранилища', () => {
      expect(SETUP_SERVER).toContain(`/opt/books/{app,uploads,${RIGHTS_SLUG},backups,logs}`);
      expect(SETUP_SECURITY).toContain(`/opt/books/{app,uploads,${RIGHTS_SLUG},backups,logs}`);
    });

    it('шаблон .env.backup объявляет выключатель и каталог хранилища', () => {
      // Файл перезаписывается целиком при каждом прогоне setup_backup_cron.sh,
      // поэтому дописанная руками строка в нём не живёт.
      expect(SETUP_CRON).toContain('INCLUDE_RIGHTS_FILES=');
      expect(SETUP_CRON).toContain('RIGHTS_FILES_DIR=');
    });
  });

  /**
   * LEGACY-032/T26: четыре дефекта, внесённые самой правкой T24 (`books@f8643bd`,
   * тег `v1.0.110`) и уехавшие на прод раньше, чем их нашло ревью. Разбор -
   * `decisions-log.md`, строка `T26`, `work-queue.md`, строка `T26`.
   */
  describe('T26: провал восстановления файлового хранилища доезжает до кода возврата', () => {
    it('после провала обоих store restore код возврата ненулевой даже при целой базе', () => {
      // Раньше `store_restore_failed` выставлялся, логировался строкой предупреждения -
      // и терялся: "Restore completed successfully" и код 0 уходили при провале
      // восстановления юридических файлов. Симметрично backup_database.sh:912.
      // Привязка к ветке УСПЕХА обязательна: перенос того же блока в `else` вернул бы
      // дефект целиком (целая база плюс провал хранилища снова дают код 0), а проверка
      // «где-то ниже по файлу» осталась бы зелёной. Поэтому между `if verify_restore`
      // и блоком не допускается ни одного `else`.
      expect(RESTORE).toMatch(
        /if verify_restore; then\n(?:(?!\s*else\b)[^\n]*\n)*?\s*if \[\[ "\$store_restore_failed" == "true" \]\]; then\n\s*log_error[^\n]*\n\s*exit 1/,
      );
    });
  });

  describe('T26: Docker-ветка restore разбирает раскладку архива хостовой ветки', () => {
    it('не распаковывает архив вслепую по фиксированному -C /data', () => {
      // Архив хостовой ветки бэкапа лежит внутри `<store>/file`, Docker-ветка бэкапа -
      // внутри `./file`. Слепой `tar -xzf ... -C /data` кладёт хостовой архив на уровень
      // глубже (`/data/<store>/...`), tar возвращает 0, и восстановление отчитывается
      // успешным, хотя ожидаемых путей в томе нет.
      expect(RESTORE).toMatch(/NEEDS_FLATTEN=\$\{archive_has_top_dir\}/);
      expect(RESTORE).toMatch(/cp -a "\/data\/\$STORE_ROOT\/\." \/data\//);
      expect(RESTORE).toMatch(/rm -rf "\/data\/\$STORE_ROOT"/);
    });

    it('определяет раскладку по первой записи архива, а не по имени файла', () => {
      expect(RESTORE).toMatch(
        /first_entry=\$\(tar -tzf "\$store_backup" 2>\/dev\/null \| sed -n '1p'\)/,
      );
    });

    it('решает про верхний каталог ОДИН раз, до ветвления на Docker и хост', () => {
      // Две копии одного решения - это тот же дефект через год: обе прошлые правки этого
      // места легли только в хостовую ветку. Обе ветки обязаны читать один флаг.
      const decisions = RESTORE.match(/archive_has_top_dir=0/g) ?? [];
      expect(decisions).toHaveLength(1);
      expect(RESTORE).toMatch(/NEEDS_FLATTEN=\$\{archive_has_top_dir\}/);
      expect(RESTORE).toMatch(/if \[\[ "\$archive_has_top_dir" == "1" \]\]; then/);
    });

    it('передаёт имя архива в контейнер через -e, а не склейкой в текст sh -c', () => {
      // Имя копии приходит позиционным аргументом main: пробел, скобка или апостроф
      // в нём разорвали бы одинарную кавычку `sh -c`, stderr погашен, и ветка молча
      // ушла бы в хостовый откат с рапортом об успехе при нетронутом томе.
      expect(RESTORE).toMatch(/-e "ARCHIVE_NAME=\$\(basename "\$store_backup"\)"/);
      expect(RESTORE).toMatch(/tar -xzf "\/backup\/\$ARCHIVE_NAME" -C \/data/);
    });
  });

  describe('T26: проверки держат настраиваемый BACKUP_PREFIX, а не литерал', () => {
    it('restore_database.sh выбирает список и дамп по BACKUP_PREFIX', () => {
      expect(RESTORE).toContain('BACKUP_PREFIX="${BACKUP_PREFIX:-bibliaris-prod}"');
      expect(RESTORE).toMatch(
        /find "\$dir" \\\( -name "\$\{BACKUP_PREFIX\}-\*\.sql\*" -o -name "\$\{BACKUP_PREFIX\}-\*\.dump" \\\)/,
      );
      expect(RESTORE).not.toMatch(
        /-name "bibliaris-prod-\*\.sql\*" -o -name "bibliaris-prod-\*\.dump"/,
      );
    });

    it('test_backup.sh зовёт проверку хранилищ с BACKUP_PREFIX', () => {
      expect(TEST_BACKUP).toContain('BACKUP_PREFIX="${BACKUP_PREFIX:-bibliaris-prod}"');
      expect(TEST_BACKUP).toMatch(/check_file_store_backups "\$\{BACKUP_PREFIX\}-uploads"/);
      expect(TEST_BACKUP).toMatch(/check_file_store_backups "\$\{BACKUP_PREFIX\}-rights-files"/);
    });

    it('check_backup_status.sh считает свежесть и размер по BACKUP_PREFIX', () => {
      expect(CHECK_STATUS).toContain('BACKUP_PREFIX="${BACKUP_PREFIX:-bibliaris-prod}"');
      // Оба места проверяются ПОИМЕННО. Один шаблон дампа встречается в файле дважды -
      // в вызове свежести и в поиске файла для проверки размера; регулярка без привязки
      // к своей строке зеленела бы, когда литерал вернулся ровно в одно из двух.
      expect(CHECK_STATUS).toMatch(
        /check_store_freshness "Database" "true" "fail" \\\( -name "\$\{BACKUP_PREFIX\}-\*\.dump" -o -name "\$\{BACKUP_PREFIX\}-\*\.sql\*" \\\)/,
      );
      expect(CHECK_STATUS).toMatch(
        /latest_db=\$\(find "\$BACKUP_DIR" \\\( -name "\$\{BACKUP_PREFIX\}-\*\.dump" -o -name "\$\{BACKUP_PREFIX\}-\*\.sql\*" \\\)/,
      );
      expect(CHECK_STATUS).not.toContain('bibliaris-prod-');
    });
  });

  describe('T26: свежесть каждого хранилища проверяется отдельно', () => {
    it('провал дампа базы не тонет в свежести архива прав', () => {
      // Один `find` по объединению всех шаблонов маскировал провал: свежий (возможно
      // пустой) архив прав удовлетворял порогу 36 часов при устаревшем или отсутствующем
      // дампе базы. Три раздельных вызова - три независимых исхода.
      expect(CHECK_STATUS).toContain('check_store_freshness()');
      expect(CHECK_STATUS).toMatch(/check_store_freshness "Database" "true" "fail"/);
      expect(CHECK_STATUS).toMatch(
        /check_store_freshness "Uploads" "\$\{INCLUDE_UPLOADS:-true\}" "warn"/,
      );
      expect(CHECK_STATUS).toMatch(
        /check_store_freshness "Rights files" "\$\{INCLUDE_RIGHTS_FILES:-true\}" "warn"/,
      );
      expect(CHECK_STATUS).not.toMatch(/latest_local=\$\(find "\$BACKUP_DIR" \\\(/);
    });

    it('законно пустое файловое хранилище не краснит проверку', () => {
      // Записанное решение LEGACY-032: при STORAGE_DRIVER=r2 том пуст, архива нет вовсе,
      // и `fail` красил бы исправную машину каждую ночь. У дампа базы законной причины
      // отсутствовать нет - он единственный остаётся `fail`.
      expect(CHECK_STATUS).toMatch(/check "No \$label backups found" "\$missing_verdict"/);
      expect(CHECK_STATUS).not.toMatch(/check "No \$label backups found" "fail"/);
    });

    it('не берёт первую строку через head под set -euo pipefail', () => {
      // head закрывает трубу, sort получает SIGPIPE и выходит с 141; под pipefail это
      // роняет весь скрипт прямо на присваивании - молча и до всех оставшихся проверок.
      // Срабатывает на накопленной ротации, то есть на проде, а не на стенде.
      expect(CHECK_STATUS).toContain('set -euo pipefail');
      expect(CHECK_STATUS).not.toMatch(/\| head -1/);
      const firstLinePicks = CHECK_STATUS.match(/sort -rn \| sed -n '1p'/g) ?? [];
      expect(firstLinePicks).toHaveLength(2);
    });
  });
});
