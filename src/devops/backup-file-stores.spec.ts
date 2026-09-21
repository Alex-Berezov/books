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
      expect(TEST_BACKUP).toContain(`bibliaris-prod-${RIGHTS_SLUG}`);
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
      expect(CHECK_STATUS).toContain(`bibliaris-prod-${RIGHTS_SLUG}-*.tar.gz`);
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
});
