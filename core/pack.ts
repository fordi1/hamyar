// Packs a project into the .tar.gz that `POST /v2/projects/{name}/sources` expects.
// Ignore rules follow Liara CLI src/utils/create-archive.ts, plus .gitignore,
// .liaraignore, and — unlike the CLI — all .env files, so secrets are never uploaded.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ignoreModule, { type Ignore } from 'ignore';
import { create } from 'tar';

// `ignore` is a CommonJS module whose typings don't resolve as callable under NodeNext.
const ignore = ignoreModule as unknown as () => Ignore;

const DEFAULT_IGNORES = [
  '.git', '.idea', '.vscode', '.next', '.dockerignore', '*.*~', 'liara.json',
  'node_modules', 'bower_components', '.DS_Store',
  '.env', '.env.*', '!.env.example',
];

const PYTHON_IGNORES = [
  'venv', '.venv', 'ENV', '.python-version', '.cache', '__pycache__', 'lib', 'lib64',
  '*.py[cod]', '*$py.class', 'pip-log.txt', 'pip-delete-this-directory.txt', 'celerybeat-schedule',
];

const PLATFORM_IGNORES: Record<string, string[]> = {
  django: [...PYTHON_IGNORES, '*.log', 'local_settings.py', 'staticfiles'],
  flask: [...PYTHON_IGNORES, 'instance', '.webassets-cache'],
  python: PYTHON_IGNORES,
  laravel: ['/vendor'],
  php: ['/vendor'],
  dotnet: ['Debug', 'debug', 'Release', 'release', 'Releases', 'releases', 'x64', 'x86', 'build', 'bld', 'Bin', 'bin', 'Obj', 'obj'],
};

// Liara rejects sources larger than this (CLI constants MAX_SOURCE_SIZE).
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

function ignoreFile(dir: string, name: string): string[] {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
}

export function listFiles(dir: string, platform: string): string[] {
  const ig = ignore()
    .add(DEFAULT_IGNORES)
    .add(PLATFORM_IGNORES[platform] ?? [])
    .add(ignoreFile(dir, '.gitignore'))
    .add(ignoreFile(dir, '.liaraignore'));

  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = relative(dir, join(current, entry.name)).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!ig.ignores(rel + '/')) walk(join(current, entry.name));
      } else if (!ig.ignores(rel)) {
        files.push(rel);
      }
    }
  };
  walk(dir);
  return files;
}

export interface PackResult {
  path: string;
  sizeBytes: number;
  fileCount: number;
}

export async function packProject(dir: string, platform: string): Promise<PackResult> {
  const files = listFiles(dir, platform);
  if (!files.length) throw new Error('No files to deploy in this folder');
  const path = join(mkdtempSync(join(tmpdir(), 'hamyar-src-')), 'source.tar.gz');
  await create({ gzip: true, file: path, cwd: dir, portable: true }, files);
  const sizeBytes = statSync(path).size;
  if (sizeBytes > MAX_SOURCE_BYTES) {
    throw new Error(`Source is ${Math.round(sizeBytes / 1024 / 1024)} MB, above Liara's 256 MB limit; add big folders to .liaraignore`);
  }
  return { path, sizeBytes, fileCount: files.length };
}
