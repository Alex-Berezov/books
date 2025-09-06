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
