import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, packProject } from './pack.js';
import { list } from 'tar';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-pack-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('listFiles', () => {
  it('skips Liara CLI default ignores, .env files and .gitignore entries', () => {
    const dir = project({
      'server.js': '',
      'src/a.js': '',
      'node_modules/x/index.js': '',
      '.git/HEAD': '',
      '.env': 'SECRET=1',
      '.env.production': 'SECRET=1',
      '.env.example': 'SECRET=',
      'liara.json': '{}',
      'logs/app.log': '',
      '.gitignore': 'logs/\n',
    });
    expect(listFiles(dir, 'node').sort()).toEqual(['.env.example', '.gitignore', 'server.js', 'src/a.js']);
  });

  it('honours .liaraignore', () => {
    const dir = project({ 'a.js': '', 'big/data.bin': '', '.liaraignore': 'big\n' });
    expect(listFiles(dir, 'node')).not.toContain('big/data.bin');
  });

  it('applies platform ignores such as venv for python', () => {
    const dir = project({ 'app.py': '', 'venv/lib/x.py': '', '__pycache__/a.pyc': '' });
    expect(listFiles(dir, 'flask')).toEqual(['app.py']);
  });
});

describe('packProject', () => {
  it('creates a gzip tarball containing the listed files', async () => {
    const dir = project({ 'server.js': 'x', 'node_modules/a.js': 'x' });
    const result = await packProject(dir, 'node');
    const entries: string[] = [];
    await list({ file: result.path, onReadEntry: (e) => { entries.push(e.path); } });
    expect(entries).toEqual(['server.js']);
    expect(result.fileCount).toBe(1);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });
});
