import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject } from './detect.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-detect-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const pkg = (deps: object, devDeps: object = {}, extra: object = {}) =>
  JSON.stringify({ dependencies: deps, devDependencies: devDeps, ...extra });

describe('detectProject platform (same order as Liara CLI)', () => {
  it.each([
    ['next', { 'package.json': pkg({ next: '15', react: '19' }) }],
    ['angular', { 'package.json': pkg({ '@angular/core': '18' }) }],
    ['vue', { 'package.json': pkg({ vue: '3' }, { vite: '5' }) }],
    ['react', { 'package.json': pkg({ react: '18' }, { vite: '5' }) }],
    ['react', { 'package.json': pkg({ 'react-scripts': '5' }) }],
    ['node', { 'package.json': pkg({ express: '4' }) }],
    ['laravel', { 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }) }],
    ['php', { 'composer.json': JSON.stringify({ require: {} }) }],
    ['php', { 'index.php': '<?php echo 1;' }],
    ['python', { 'pyproject.toml': '[project]' }],
    ['django', { 'requirements.txt': 'Django==5.0\n' }],
    ['flask', { 'requirements.txt': 'flask\n' }],
    ['python', { 'requirements.txt': 'fastapi\n' }],
    ['django', { Pipfile: '[packages]\ndjango = "*"' }],
    ['go', { 'go.mod': 'module x' }],
    ['docker', { Dockerfile: 'FROM alpine' }],
    ['wordpress', { 'wp-content/index.php': '' }],
    ['dotnet', { 'src/Program.cs': '', 'src/app.csproj': '<Project/>' }],
    ['static', { 'index.html': '<h1>hi</h1>' }],
  ])('detects %s', (platform, files) => {
    expect(detectProject(project(files)).platform).toBe(platform);
  });

  it('composer.json wins over package.json', () => {
    const dir = project({ 'composer.json': '{"require":{}}', 'package.json': pkg({ next: '1' }) });
    expect(detectProject(dir).platform).toBe('php');
  });

  it('reports a conflict instead of throwing when package.json and Dockerfile both exist', () => {
    const result = detectProject(project({ 'package.json': pkg({}), Dockerfile: 'FROM node' }));
    expect(result.platform).toBe('node');
    expect(result.conflict).toMatch(/Dockerfile/);
  });
});

describe('detectProject port, start command and reasons', () => {
  it('uses Liara CLI default ports', () => {
    expect(detectProject(project({ 'package.json': pkg({ next: '15' }) })).port).toBe(3000);
    expect(detectProject(project({ 'requirements.txt': 'django' })).port).toBe(80);
    expect(detectProject(project({ 'go.mod': 'module x' })).port).toBe(8080);
    expect(detectProject(project({ 'package.json': pkg({ express: '4' }) })).port).toBe(3000);
  });

  it('reads the port a node app listens on when it is hardcoded', () => {
    const dir = project({
      'package.json': pkg({ express: '4' }, {}, { main: 'server.js', scripts: { start: 'node server.js' } }),
      'server.js': "app.listen(process.env.PORT || 8080, () => {})",
    });
    const result = detectProject(dir);
    expect(result.port).toBe(8080);
    expect(result.startCommand).toBe('node server.js');
  });

  it('reads the node version from engines', () => {
    const dir = project({ 'package.json': pkg({ express: '4' }, {}, { engines: { node: '>=20' } }) });
    expect(detectProject(dir).version).toBe('20');
  });

  it('explains why it chose the platform', () => {
    const result = detectProject(project({ 'package.json': pkg({ next: '15' }) }));
    expect(result.reasons.join(' ')).toMatch(/next/);
  });

  it('warns when a .env file would be uploaded', () => {
    const dir = project({ 'package.json': pkg({ express: '4' }), '.env': 'SECRET=1' });
    expect(detectProject(dir).warnings.join(' ')).toMatch(/\.env/);
  });
});
