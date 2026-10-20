import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { shellFunctionLines } from '../common/testing/shell-function';

/**
 * Сторож уборки образов после выката (`cleanup_old_images` в `scripts/deploy_production.sh`).
 *
 * 🔴 20.10.2026 диск боевой машины был занят на 85 %: 275 образов
 * `ghcr.io/alex-berezov/books` по 1,3 ГБ. Конвейер выкатывает с `--pull`, и `build_image`
 * кладёт каждый релиз ещё и под именем реестра, а уборка перебирала только `books-app` —
 * теги реестра не удалял никто. Верни уборку к одному `books-app`, и первый кейс покраснеет.
 *
 * Проверка исполняемая: функция вырезается из скрипта как есть и запускается в bash
 * на подставном `docker`. Сторож по тексту здесь бессилен — дефект был не в отсутствии
 * слова, а в том, по каким именам идёт перебор.
 */
const ROOT = resolve(__dirname, '..', '..');
const SCRIPT_LINES = readFileSync(join(ROOT, 'scripts', 'deploy_production.sh'), 'utf8').split(
  /\r?\n/,
);

const functionText = (name: string): string => shellFunctionLines(SCRIPT_LINES, name).join('\n');

const REGISTRY = 'ghcr.io/alex-berezov/books';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'image-cleanup-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Run = { status: number | null; out: string; removed: string[]; docker: string[] };

type Options = {
  registry?: string;
  /** Образы, на которых `docker rmi` отказывает. */
  busy?: string[];
  /** Выкат из реестра (`--pull`); `false` — сборка на месте. */
  pull?: boolean;
  /** На какой команде уборки `docker` завершается ошибкой. */
  failOn?: 'images' | 'image prune' | 'builder prune';
};

/** `images` — что отдаёт `docker images <имя>` для каждого имени (от новых к старым). */
const runCleanup = (
  images: Record<string, string[]>,
  { registry = REGISTRY, busy = [], pull = true, failOn }: Options = {},
): Run => {
  // Дата сборки — по месту в списке (первый — самый новый), а отдаёт подставной `docker`
  // список от старых к новым: старшинство обязан установить сам скрипт, а не порядок вывода.
  for (const [repo, refs] of Object.entries(images)) {
    const lines = refs.map(
      (ref, i) => `2026-10-${String(30 - i).padStart(2, '0')} 10:00:00 +0000 UTC\t${ref}\n`,
    );
    writeFileSync(
      join(root, `images-${repo.replace(/[/:]/g, '_')}`),
      lines.reverse().join(''),
      'utf8',
    );
  }
  writeFileSync(join(root, 'busy'), busy.map((ref) => `${ref}\n`).join(''), 'utf8');

  const docker = join(root, 'docker');
  writeFileSync(
    docker,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$STATE/docker.log"',
      'if [ -n "$FAIL_ON" ] && { [ "$1" = "$FAIL_ON" ] || [ "$1 $2" = "$FAIL_ON" ]; }; then exit 1; fi',
      'case "$1" in',
      '  images)',
      '    f="$STATE/images-$(printf "%s" "$2" | tr "/:" "__")"',
      '    if [ -f "$f" ]; then cat "$f"; fi',
      '    exit 0 ;;',
      '  rmi)',
      '    rc=0',
      '    shift',
      '    for ref in "$@"; do',
      '      printf "%s\\n" "$ref" >> "$STATE/removed"',
      '      if grep -qxF "$ref" "$STATE/busy"; then rc=1; fi',
      '    done',
      '    exit $rc ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    'utf8',
  );
  chmodSync(docker, 0o755);

  const harness = [
    'set -euo pipefail',
    'log() { echo "$*"; }',
    'log_success() { echo "OK $*"; }',
    'log_warning() { echo "WARN $*"; }',
    'DRY_RUN=false',
    `REGISTRY='${registry}'`,
    `PULL_IMAGE=${pull}`,
    'execute() { eval "$1"; }',
    functionText('cleanup_old_images'),
    'cleanup_old_images',
  ].join('\n');

  // Сценарий — файлом, а не `bash -c`: на Windows длинная строка с кавычками в аргументе
  // приходит в bash искажённой.
  const script = join(root, 'harness.sh');
  writeFileSync(script, harness, 'utf8');
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
      STATE: root,
      FAIL_ON: failOn ?? '',
    },
  });

  const read = (name: string): string[] => {
    try {
      return readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  return {
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    removed: read('removed'),
    docker: read('docker.log'),
  };
};

/** Восемь релизов от нового к старому под одним именем, плюс служебные теги сверху. */
const releases = (repo: string, extra: string[] = []): string[] => [
  ...extra.map((tag) => `${repo}:${tag}`),
  ...[8, 7, 6, 5, 4, 3, 2, 1].map((n) => `${repo}:v1.0.${n}`),
];

const OLDEST_THREE = (repo: string): string[] => [
  `${repo}:v1.0.3`,
  `${repo}:v1.0.2`,
  `${repo}:v1.0.1`,
];

describe('scripts/deploy_production.sh: уборка старых образов', () => {
  it('функция находится в скрипте целиком', () => {
    const body = functionText('cleanup_old_images');
    expect(body).toContain('docker images');
    expect(body.trimEnd().endsWith('}')).toBe(true);
  });

  it('образы реестра убираются наравне с books-app: остаются пять последних каждого имени', () => {
    const { status, out, removed, docker } = runCleanup({
      'books-app': releases('books-app', ['prod', 'latest']),
      [REGISTRY]: releases(REGISTRY),
    });

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(removed).toEqual([...OLDEST_THREE('books-app'), ...OLDEST_THREE(REGISTRY)]);
    expect(docker.filter((line) => line.startsWith('images '))).toEqual([
      'images books-app --format {{.CreatedAt}}\t{{.Repository}}:{{.Tag}}',
      `images ${REGISTRY} --format {{.CreatedAt}}\t{{.Repository}}:{{.Tag}}`,
    ]);
  });

  /**
   * На `books-app:prod` смотрит `docker-compose.prod.yml`, и после отката он указывает
   * на образ старше пяти последних. `rollback` ставит `save_current_state` на образ точки
   * отката (`LEGACY-328`): после выката старого тега он тоже старше. `ghcr…/books:latest`
   * тянет конвейер фронта для e2e.
   */
  it('prod, latest, rollback и образ без тега не удаляются, даже если старше пяти последних', () => {
    const { status, out, removed } = runCleanup({
      'books-app': [
        ...releases('books-app'),
        'books-app:prod',
        'books-app:latest',
        'books-app:rollback',
        'books-app:<none>',
      ],
      [REGISTRY]: [...releases(REGISTRY), `${REGISTRY}:latest`],
    });

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(removed).toEqual([...OLDEST_THREE('books-app'), ...OLDEST_THREE(REGISTRY)]);
  });

  it('без реестра (сборка на месте) перебирается только books-app', () => {
    const { status, out, docker, removed } = runCleanup(
      { 'books-app': releases('books-app') },
      { registry: 'localhost' },
    );

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(docker.filter((line) => line.startsWith('images '))).toEqual([
      'images books-app --format {{.CreatedAt}}\t{{.Repository}}:{{.Tag}}',
    ]);
    expect(removed).toEqual(OLDEST_THREE('books-app'));
  });

  it('образов не больше пяти — docker rmi не зовётся вовсе', () => {
    const { status, out, docker } = runCleanup({ 'books-app': releases('books-app').slice(0, 5) });

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(docker.some((line) => line.startsWith('rmi'))).toBe(false);
  });

  it('занятый образ не валит выкат: отказ попадает в лог, остальное всё равно убирается', () => {
    const { status, out, removed } = runCleanup(
      { 'books-app': releases('books-app'), [REGISTRY]: releases(REGISTRY) },
      { busy: ['books-app:v1.0.2'] },
    );

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(out).toContain('WARN Some old books-app images could not be removed');
    expect(removed).toEqual([...OLDEST_THREE('books-app'), ...OLDEST_THREE(REGISTRY)]);
    expect(out).toContain('OK Cleanup completed');
  });

  it('перечислить образы не удалось — свой отказ, а не «образ занят», выкат не валится', () => {
    const { status, out, removed } = runCleanup(
      { 'books-app': releases('books-app') },
      { failOn: 'images' },
    );

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(removed).toEqual([]);
    expect(out).toContain('WARN Cannot list books-app images');
    expect(out).not.toContain('still in use');
    expect(out).toContain('OK Cleanup completed');
  });

  it('при сборке на месте кэш сборки не чистится', () => {
    const { status, out, docker } = runCleanup(
      { 'books-app': releases('books-app') },
      { registry: 'localhost', pull: false },
    );

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(docker).not.toContain('builder prune -f');
  });

  it('после образов чистятся безымянные образы и кэш сборки, в этом порядке', () => {
    const { status, out, docker } = runCleanup({ 'books-app': releases('books-app') });

    expect({ status, out }).toMatchObject({ status: 0 });
    const rmi = docker.findIndex((line) => line.startsWith('rmi '));
    const prune = docker.indexOf('image prune -f');
    const builder = docker.indexOf('builder prune -f');
    expect(rmi).toBeGreaterThanOrEqual(0);
    expect(prune).toBeGreaterThan(rmi);
    expect(builder).toBeGreaterThan(prune);
  });

  it.each([
    ['image prune', 'WARN docker image prune failed'],
    ['builder prune', 'WARN Build cache could not be pruned'],
  ] as const)('отказ docker %s не валит выкат и попадает в лог', (failOn, warning) => {
    const { status, out } = runCleanup({ 'books-app': releases('books-app') }, { failOn });

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(out).toContain(warning);
    expect(out).toContain('OK Cleanup completed');
  });
});

/**
 * 🔴 `LEGACY-328`. Тег `rollback`, который уборка обходит, ставит `save_current_state`
 * на образ точки отката. Пропади эта строка — уборка снова снимет все теги с образа
 * точки отката после выката старого тега, и `--rollback` его не найдёт.
 */
describe('scripts/deploy_production.sh: образ точки отката держится своим тегом', () => {
  /** `container` — что отдаёт `compose ps -aq app` (пусто — первый выкат); `tagFails` — `docker tag` отказывает. */
  const runSave = ({ container = 'c1', tagFails = false, rollbackTagExists = false } = {}): {
    status: number | null;
    out: string;
    docker: string[];
  } => {
    const docker = join(root, 'docker');
    writeFileSync(
      docker,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$STATE/docker.log"',
        'case "$1" in',
        '  compose) printf "%s\\n" "$CONTAINER"; exit 0 ;;',
        '  inspect)',
        '    case "$3" in *Config.Image*) echo "books-app:prod" ;; *) echo "sha256:img-prev" ;; esac',
        '    exit 0 ;;',
        '  tag) if [ -n "$TAG_FAILS" ]; then exit 1; fi; exit 0 ;;',
        // `docker image inspect books-app:rollback`: есть ли прежний тег точки отката.
        '  image) if [ -n "$ROLLBACK_EXISTS" ]; then exit 0; fi; exit 1 ;;',
        'esac',
        'exit 0',
      ].join('\n'),
      'utf8',
    );
    chmodSync(docker, 0o755);
    writeFileSync(join(root, 'git'), '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    chmodSync(join(root, 'git'), 0o755);

    const harness = [
      'set -euo pipefail',
      'log() { echo "$*"; }',
      'log_success() { echo "OK $*"; }',
      'log_warning() { echo "WARN $*"; }',
      'log_error() { echo "ERR $*"; }',
      'write_state_file() { :; }',
      'DRY_RUN=false',
      'SKIP_GIT_UPDATE=false',
      'IMAGE_TAG=v1.0.9',
      'execute() { eval "$1"; }',
      functionText('save_current_state'),
      'save_current_state',
    ].join('\n');

    const script = join(root, 'harness.sh');
    writeFileSync(script, harness, 'utf8');
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
        STATE: root,
        DEPLOY_DIR: root,
        DEPLOY_PREVIOUS_SHA: 'abc1234',
        ROLLBACK_FILE: join(root, 'rollback_info'),
        CONTAINER: container,
        TAG_FAILS: tagFails ? '1' : '',
        ROLLBACK_EXISTS: rollbackTagExists ? '1' : '',
      },
    });

    let log: string[] = [];
    try {
      log = readFileSync(join(root, 'docker.log'), 'utf8').split('\n').filter(Boolean);
    } catch {
      log = [];
    }
    return {
      status: result.status,
      out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      docker: log,
    };
  };

  it('ставит books-app:rollback на образ работающего контейнера', () => {
    const { status, out, docker } = runSave();

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(docker).toContain('tag sha256:img-prev books-app:rollback');
  });

  it('не поставился тег — точка отката не защищена, функция отказывает', () => {
    const { status, out } = runSave({ tagFails: true });

    expect(status).toBe(1);
    expect(out).toContain('ERR Could not tag rollback image sha256:img-prev');
  });

  it('первый выкат (контейнера нет) — тег не ставится, выкат не валится', () => {
    const { status, out, docker } = runSave({ container: '' });

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(docker.some((line) => line.startsWith('tag '))).toBe(false);
    expect(docker.some((line) => line.startsWith('rmi '))).toBe(false);
  });

  it('первый выкат при оставшемся теге rollback — тег снимается, а не держит чужой образ', () => {
    const { status, out, docker } = runSave({ container: '', rollbackTagExists: true });

    expect({ status, out }).toMatchObject({ status: 0 });
    expect(docker).toContain('rmi books-app:rollback');
  });
});
