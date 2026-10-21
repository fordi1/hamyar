// Platform detection. The platform order is a port of Liara CLI
// src/utils/detect-platform.ts so Hamyar picks exactly what `liara deploy` would.
// On top of it we add port, start command, runtime version, reasons and warnings.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type Platform =
  | 'dotnet' | 'laravel' | 'php' | 'python' | 'django' | 'flask' | 'next' | 'angular'
  | 'vue' | 'react' | 'node' | 'wordpress' | 'go' | 'docker' | 'static';

export interface Detection {
  platform: Platform;
  port: number;
  startCommand?: string;
  version?: string;
  reasons: string[];
  warnings: string[];
  // Liara CLI throws when a platform marker and a Dockerfile both exist; we report it instead.
  conflict?: string;
}

// Liara CLI src/utils/get-port.ts
const FIXED_PORTS: Partial<Record<Platform, number>> = {
  static: 80, python: 80, react: 80, vue: 80, angular: 80, laravel: 80,
  wordpress: 80, django: 80, flask: 80, php: 80, next: 3000,
};
const DEFAULT_PORTS: Partial<Record<Platform, number>> = { dotnet: 80, go: 8080 };

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'venv', '.venv', 'bin', 'obj', 'dist', 'build', '.next']);

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function readText(path: string): string {
  try {
    // requirements.txt is sometimes saved as UTF-16 on Windows; dropping NULs covers it
    // the same way the CLI's addNullBetweenChars check does.
    return readFileSync(path, 'utf8').replace(/\0/g, '');
  } catch {
    return '';
  }
}

function findFiles(dir: string, match: (name: string) => boolean, depth: number): string[] {
  if (depth < 0) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...findFiles(join(dir, entry.name), match, depth - 1));
    } else if (match(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function detectPlatform(dir: string, reasons: string[]): { platform: Platform; conflict?: string } {
  const has = (name: string) => existsSync(join(dir, name));
  const hasDocker = has('Dockerfile');
  const conflict = (marker: string, platform: Platform) =>
    hasDocker ? `Both ${marker} and Dockerfile exist; using ${platform}. Choose docker if the Dockerfile should be used.` : undefined;

  const programCs = findFiles(dir, (n) => n === 'Program.cs' || n === 'Startup.cs', 5)[0];
  if (programCs) {
    const csDir = join(programCs, '..');
    if (readdirSync(csDir).some((n) => n.endsWith('.csproj'))) {
      reasons.push('Program.cs and a .csproj file found → dotnet');
      return { platform: 'dotnet', conflict: conflict('*.csproj', 'dotnet') };
    }
  }

  if (has('composer.json')) {
    const require = readJson(join(dir, 'composer.json')).require ?? {};
    const c = conflict('composer.json', 'php');
    if (require['laravel/framework'] || require['laravel/lumen-framework']) {
      reasons.push('composer.json requires laravel/framework → laravel');
      return { platform: 'laravel', conflict: c };
    }
    reasons.push('composer.json found without Laravel → php');
    return { platform: 'php', conflict: c };
  }

  if (has('index.php')) {
    reasons.push('index.php found → php');
    return { platform: 'php' };
  }

  if (has('pyproject.toml') || has('poetry')) {
    reasons.push('pyproject.toml found → python');
    return { platform: 'python' };
  }

  for (const file of ['requirements.txt', 'Pipfile']) {
    if (!has(file)) continue;
    const text = readText(join(dir, file));
    if (/django/i.test(text)) {
      reasons.push(`${file} lists Django → django`);
      return { platform: 'django' };
    }
    if (/flask/i.test(text)) {
      reasons.push(`${file} lists Flask → flask`);
      return { platform: 'flask' };
    }
    reasons.push(`${file} found → python`);
    return { platform: 'python' };
  }

  if (has('package.json')) {
    const pkg = readJson(join(dir, 'package.json'));
    const deps = pkg.dependencies ?? {};
    const dev = pkg.devDependencies ?? {};
    const c = conflict('package.json', 'node');
    if (deps.next) {
      reasons.push('package.json depends on next → next');
      return { platform: 'next', conflict: c };
    }
    if (deps['@angular/core']) {
      reasons.push('package.json depends on @angular/core → angular');
      return { platform: 'angular', conflict: c };
    }
    if (dev['@vue/cli-service'] || (deps.vue && dev.vite)) {
      reasons.push('package.json uses vue → vue');
      return { platform: 'vue', conflict: c };
    }
    if (deps['react-scripts'] || (dev.vite && deps.react) || deps.preact) {
      reasons.push('package.json is a React single-page app → react');
      return { platform: 'react', conflict: c };
    }
    reasons.push('package.json without a frontend framework → node');
    return { platform: 'node', conflict: c };
  }

  if (has('wp-content')) {
    reasons.push('wp-content folder found → wordpress');
    return { platform: 'wordpress', conflict: conflict('wp-content', 'wordpress') };
  }

  if (has('go.mod')) {
    reasons.push('go.mod found → go');
    return { platform: 'go', conflict: conflict('go.mod', 'go') };
  }

  if (hasDocker) {
    reasons.push('Dockerfile found → docker');
    return { platform: 'docker' };
  }

  reasons.push('no server-side project file found → static');
  return { platform: 'static' };
}

// Finds `listen(8080` or `PORT || 8080` in the node entry file.
function hardcodedNodePort(dir: string, pkg: any): number | undefined {
  const candidates = [pkg.main, 'server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js'].filter(Boolean);
  for (const file of candidates) {
    const text = readText(join(dir, file));
    const m = text.match(/PORT\s*\|\|\s*(\d{2,5})/) ?? text.match(/\.listen\(\s*(\d{2,5})/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export function detectProject(dir: string): Detection {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const { platform, conflict } = detectPlatform(dir, reasons);

  let port = FIXED_PORTS[platform] ?? DEFAULT_PORTS[platform] ?? 3000;
  let startCommand: string | undefined;
  let version: string | undefined;

  if (platform === 'node' || platform === 'next') {
    const pkg = readJson(join(dir, 'package.json'));
    startCommand = pkg.scripts?.start;
    const engine: string | undefined = pkg.engines?.node;
    version = engine?.match(/\d+/)?.[0];
    if (platform === 'node') {
      const found = hardcodedNodePort(dir, pkg);
      if (found) {
        port = found;
        reasons.push(`the code listens on port ${found}`);
      }
      if (!startCommand) warnings.push('package.json has no "start" script; Liara runs `npm start` for node apps.');
    }
  }

  if (existsSync(join(dir, '.env'))) {
    warnings.push('A .env file is in the project and would be uploaded with the code. Move its values to Liara environment variables instead.');
  }

  return { platform, port, startCommand, version, reasons, warnings, conflict };
}
