import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('DevOps: Docker artifacts', () => {
  const root = join(__dirname, '..', '..');

  it('Dockerfile exists and has multi-stage build', () => {
    const dockerfile = join(root, 'Dockerfile');
    expect(existsSync(dockerfile)).toBe(true);
    const content = readFileSync(dockerfile, 'utf8');
    expect(content).toContain('FROM node:22-alpine AS builder');
    expect(content).toContain('FROM node:22-alpine AS runner');
    expect(content).toContain('yarn build');
    expect(content).toContain('CMD ["/usr/local/bin/docker-entrypoint.sh"]');
  });

  /**
   * 🔴 `prisma db seed` внутри образа (`LEGACY-294`).
   *
   * Команда сида объявлена в `prisma.config.ts` как `ts-node ./prisma/seed.ts`. Без файла
   * проекта ts-node отдаёт entry-point загрузчику ESM, и тот падает на расширении:
   * `TypeError: Unknown file extension ".ts"`. До 02.09.2026 `tsconfig.json` в runner-стадию
   * не копировался вовсе, то есть сид в образе не запускался ни разу - и обнаружилось это
   * только когда конвейер фронта начал звать его для наполнения базы под e2e.
   *
   * Проверяется наличие всех четырёх частей: сам файл проекта, каталог `prisma` с `seed.ts`,
   * конфигурация с командой сида и бинарь CLI. Пропажа любой из них ломает сид молча -
   * образ собирается и приложение стартует, потому что самому `dist/main.js` ничего
   * из этого не нужно.
   */
  it('runner-стадия несёт всё, что нужно для prisma db seed', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runner = content.slice(content.indexOf('AS runner'));
    expect(runner.length).toBeGreaterThan(200);

    expect(runner).toContain('COPY --from=builder /app/tsconfig.json ./tsconfig.json');
    expect(runner).toContain('COPY --from=builder /app/prisma ./prisma');
    expect(runner).toContain('COPY --from=builder /app/prisma.config.ts ./prisma.config.ts');
    expect(runner).toContain('COPY --from=builder /app/node_modules/.bin/prisma');
  });

  /**
   * 🔴 Одного `tsconfig.json` мало. CLI prisma запускает команду сида через execa
   * **без shell и с `preferLocal: false`**, то есть `ts-node` ищется только в `PATH`,
   * а базовый `PATH` образа `node:22-alpine` каталога `/app/node_modules/.bin`
   * не содержит. Без этой строки сид падает `spawn ts-node ENOENT` уже после того,
   * как файл проекта на месте.
   *
   * ⚠️ Проверка нужна именно здесь, потому что локальные прогоны этот случай
   * не воспроизводят: `yarn` и `npx` дополняют `PATH` сами.
   */
  it('runner-стадия кладёт локальные бинари в PATH', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runner = content.slice(content.indexOf('AS runner'));

    expect(runner).toMatch(/ENV\s+PATH=.*\/app\/node_modules\/\.bin/);
  });

  /**
   * 🔴 `ts-node` и `typescript` попадают в образ **только** потому, что строка
   * `COPY --from=builder /app/node_modules ./node_modules` тащит модули builder'а
   * целиком, вместе с devDependencies. Соседний комментарий Dockerfile прямо
   * предлагает это урезать («later we can optimize by pruning to production-only»),
   * и такое урезание убьёт сид молча: образ соберётся, `dist/main.js` стартует,
   * а `prisma db seed` в конвейере фронта умрёт, вернув базу к пустому состоянию —
   * то есть вернётся `LEGACY-294` целиком.
   *
   * Поэтому проверяется и то, что модули копируются целиком, и то, что установки
   * с урезанием до production в runner-стадии нет.
   */
  it('runner-стадия не урезает зависимости до production', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runner = content.slice(content.indexOf('AS runner'));
    const code = runner
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(code).toContain('COPY --from=builder /app/node_modules ./node_modules');
    expect(code).not.toMatch(/--production/);
    expect(code).not.toMatch(/--omit=dev/);
  });

  it('docker-compose.prod.yml exists and wires app->postgres', () => {
    const compose = join(root, 'docker-compose.prod.yml');
    expect(existsSync(compose)).toBe(true);
    const content = readFileSync(compose, 'utf8');
    expect(content).toMatch(/services:\s*[\s\S]*app:/);
    expect(content).toMatch(/depends_on:\s*[\s\S]*postgres/);
    expect(content).toMatch(/image: postgres:14/);
  });

  it('.dockerignore exists and ignores common dev files', () => {
    const ignore = join(root, '.dockerignore');
    expect(existsSync(ignore)).toBe(true);
    const content = readFileSync(ignore, 'utf8');
    expect(content).toContain('node_modules');
    expect(content).toContain('dist');
    expect(content).toContain('**/*.spec.ts');
  });

  it('entrypoint script exists and starts app', () => {
    const entry = join(root, 'scripts', 'docker-entrypoint.sh');
    expect(existsSync(entry)).toBe(true);
    const content = readFileSync(entry, 'utf8');
    expect(content).toContain('prisma migrate deploy');
    expect(content).toContain('exec node dist/main.js');
  });
});
