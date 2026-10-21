import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanEnv } from './env-scan.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-env-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('scanEnv', () => {
  it('finds env vars read by JS, Python, PHP and Go code', () => {
    const dir = project({
      'a.js': "const u = process.env.DATABASE_URL; const k = process.env['API_KEY'];",
      'b.ts': 'const x = import.meta.env.VITE_TITLE;',
      'c.py': "os.environ['SECRET_KEY']; os.getenv('DEBUG'); os.environ.get(\"REDIS_URL\")",
      'd.php': "env('APP_KEY');",
      'e.go': 'os.Getenv("GO_TOKEN")',
    });
    const names = scanEnv(dir).used.map((u) => u.name).sort();
    expect(names).toEqual(['API_KEY', 'APP_KEY', 'DATABASE_URL', 'DEBUG', 'GO_TOKEN', 'REDIS_URL', 'SECRET_KEY', 'VITE_TITLE']);
  });

  it('records where each variable is read', () => {
    const dir = project({ 'src/db.js': '\n\nconst u = process.env.DATABASE_URL;' });
    const used = scanEnv(dir).used[0];
    expect(used.locations[0]).toBe('src/db.js:3');
  });

  it('ignores node_modules and platform-provided vars', () => {
    const dir = project({
      'node_modules/x/index.js': 'process.env.FROM_DEP',
      'a.js': 'process.env.PORT; process.env.NODE_ENV; process.env.MINE',
    });
    expect(scanEnv(dir).used.map((u) => u.name)).toEqual(['MINE']);
  });

  it('treats a var with an inline fallback as optional', () => {
    const dir = project({ 'a.js': "const t = process.env.TITLE || 'Shop'; const d = process.env.DATABASE_URL;" });
    const byName = Object.fromEntries(scanEnv(dir).used.map((u) => [u.name, u.optional]));
    expect(byName).toEqual({ TITLE: true, DATABASE_URL: false });
  });

  it('compares with .env.example and with what is already set on Liara', () => {
    const dir = project({
      'a.js': 'process.env.DATABASE_URL; process.env.API_KEY; process.env.SET_ALREADY',
      '.env.example': 'DATABASE_URL=postgres://user:pass@host/db\n# comment\nUNUSED_VAR=1\n',
    });
    const result = scanEnv(dir, ['SET_ALREADY']);
    expect(result.missing.map((m) => m.name).sort()).toEqual(['API_KEY', 'DATABASE_URL']);
    expect(result.documented).toEqual(['DATABASE_URL', 'UNUSED_VAR']);
    expect(result.missing.find((m) => m.name === 'DATABASE_URL')?.documented).toBe(true);
  });

  it('never returns values from .env files', () => {
    const dir = project({ 'a.js': 'process.env.TOKEN', '.env': 'TOKEN=super-secret' });
    expect(JSON.stringify(scanEnv(dir))).not.toContain('super-secret');
  });
});
