import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Строки комментариев Dockerfile выбрасываются перед любой сверкой с командами.
 * Без этого ожидание удовлетворяется абзацем комментария над командой и не краснеет
 * при вырезанной команде - ровно так первая версия тестов `LEGACY-100` и пропустила
 * два блокера.
 */
function stripComments(dockerfile: string): string {
  return dockerfile
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

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
   *
   * 🔴 Бинарь CLI (`node_modules/.bin/prisma`) с `LEGACY-100` больше не копируется отдельной
   * строкой - он уже внутри целикового `COPY --from=builder /app/node_modules ./node_modules`
   * (симлинк, который кладёт туда yarn install), точечная копия того же пути поверх была
   * чистым дублем. Проверка, что бинарь останется достижим, живёт ниже - в тесте про цели
   * чистки: он сверяет их с графом `require` бандла CLI.
   */
  it('runner-стадия несёт всё, что нужно для prisma db seed', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runner = content.slice(content.indexOf('AS runner'));
    expect(runner.length).toBeGreaterThan(200);

    expect(runner).toContain('COPY --from=builder /app/tsconfig.json ./tsconfig.json');
    expect(runner).toContain('COPY --from=builder /app/prisma ./prisma');
    expect(runner).toContain('COPY --from=builder /app/prisma.config.ts ./prisma.config.ts');
    expect(runner).toContain('COPY --from=builder /app/node_modules ./node_modules');
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
   * целиком, вместе с devDependencies. Урезание до production-only проверялось
   * и отвергнуто при разборе `LEGACY-100` (комментарий в Dockerfile перед этой строкой) -
   * оно убьёт сид молча: образ соберётся, `dist/main.js` стартует,
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

  /**
   * `LEGACY-100`. Чистка мёртвого веса обязана стоять в builder-стадии, до
   * `COPY --from=builder /app/node_modules`.
   *
   * 🔴 Слой образа неизменяем. Удаление файлов **после** готового `COPY` не снимает
   * ни байта: исходные файлы остаются лежать в нижнем слое, а `RUN rm` добавляет сверху
   * только whiteout-записи, и размер образа (сумма слоёв) от этого растёт, а не падает.
   * Первая версия правки `LEGACY-100` стояла именно так и не давала выигрыша вовсе -
   * при этом выглядела сделанной.
   */
  it('чистка мёртвого веса стоит в builder-стадии, а не поверх готового слоя (LEGACY-100)', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const code = stripComments(content);
    const runnerStart = code.indexOf('AS runner');
    const cleanup = code.search(/RUN\s+find\s+node_modules/);

    expect(cleanup).toBeGreaterThan(-1);
    expect(runnerStart).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(runnerStart);
  });

  /**
   * `LEGACY-100`. Цели чистки сверяются с графом `require` бандла CLI prisma,
   * а не с текстом Dockerfile.
   *
   * 🔴 Первая версия правки удаляла `@prisma/studio-core` и `@prisma/dev`, считая их
   * нужными только командам `prisma studio`/`prisma dev`. На деле бандл
   * `node_modules/prisma/build/index.js` требует их на верхнем уровне: без них падает
   * **любой** вызов `prisma`, включая `migrate deploy` из `scripts/docker-entrypoint.sh`.
   * Падение там проглочено (`|| echo`), поэтому контейнер поднялся бы без применённых
   * миграций - молча. Тест на текст Dockerfile такой дефект пропускает, поэтому здесь
   * проверяется сам артефакт.
   */
  it('чистка не трогает пакеты, которые бандл CLI prisma грузит при запуске (LEGACY-100)', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const code = stripComments(content);

    const targets = [...code.matchAll(/rm\s+-rf\s+([^\n&|]+)/g)]
      .flatMap((m) => m[1].trim().split(/\s+/))
      .filter((p) => p.startsWith('node_modules/'))
      .map((p) => p.replace(/^node_modules\//, ''));

    expect(targets.length).toBeGreaterThan(0);

    const cliBundle = join(root, 'node_modules', 'prisma', 'build', 'index.js');
    expect(existsSync(cliBundle)).toBe(true);
    const bundle = readFileSync(cliBundle, 'utf8');

    for (const target of targets) {
      const required = new RegExp(`require\\(["']${target.replace(/[/\\]/g, '\\$&')}(["'/])`);
      expect({ target, required: required.test(bundle) }).toEqual({ target, required: false });
    }

    // `ts-node` и `typescript` нужны `prisma db seed` (LEGACY-294) и в цели чистки
    // не входят независимо от того, что скажет про них граф require.
    expect(targets).not.toContain('ts-node');
    expect(targets).not.toContain('typescript');
  });

  /**
   * `LEGACY-100`. Шаблоны `find` удаляют wasm-компиляторы чужих провайдеров и
   * не задевают postgresql - единственный, который объявляет `prisma/schema.prisma`.
   * Сверяется команда, а не комментарий над ней: первая версия теста совпадала
   * с абзацем комментария и оставалась зелёной при вырезанной команде.
   */
  it('чистка снимает wasm чужих провайдеров и оставляет postgresql (LEGACY-100)', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const code = stripComments(content);
    const cleanup = code.slice(code.search(/RUN\s+find\s+node_modules/));
    const command = cleanup.slice(0, cleanup.indexOf('\nFROM') + 1 || undefined);

    expect(command).toContain('node_modules/@prisma/client/runtime');
    for (const provider of ['cockroachdb', 'mysql', 'sqlite', 'sqlserver']) {
      expect(command).toContain(`*.${provider}.*`);
    }
    expect(command).not.toContain('postgresql');
  });

  /**
   * `LEGACY-100`. `node_modules` копируется целиком одной строкой ("не урезает
   * зависимости до production" выше) - четыре точечные `COPY` того же
   * `@prisma`/`.prisma`/`prisma`/`.bin/prisma` копировали то, что уже лежало
   * внутри, вторым слоем поверх тех же файлов с новым mtime.
   */
  it('runner-стадия не дублирует то, что уже внутри целикового node_modules', () => {
    const content = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runner = content.slice(content.indexOf('AS runner'));

    expect(runner).not.toContain(
      'COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma',
    );
    expect(runner).not.toContain(
      'COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma',
    );
    expect(runner).not.toContain(
      'COPY --from=builder /app/node_modules/prisma ./node_modules/prisma',
    );
    expect(runner).not.toContain(
      'COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma',
    );
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
