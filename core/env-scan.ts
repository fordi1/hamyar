// Finds the environment variables the code reads and compares them with
// .env.example and with the variables already set on Liara.
// Only variable NAMES leave this module; values are never read from .env files.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

export interface EnvUse {
  name: string;
  // `process.env.X || 'default'` style reads that work without the variable
  optional: boolean;
  locations: string[];
}

export interface EnvScan {
  used: EnvUse[];
  documented: string[];
  missing: (EnvUse & { documented: boolean })[];
}

const PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  /os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
];

// Set by Liara or the runtime itself, so they never need to be configured.
const PROVIDED = new Set(['PORT', 'NODE_ENV', 'HOME', 'PATH', 'HOSTNAME', 'PWD', 'TZ', 'CI']);

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.php', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'venv', '.venv', '__pycache__', 'dist', 'build', '.next', 'coverage']);

function* codeFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) yield* codeFiles(join(dir, entry.name));
    } else if (CODE_EXT.has(extname(entry.name)) && !entry.name.includes('.test.')) {
      yield join(dir, entry.name);
    }
  }
}

function envNames(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((n): n is string => Boolean(n));
}

export function scanEnv(dir: string, setOnLiara: string[] = []): EnvScan {
  const found = new Map<string, EnvUse>();

  for (const file of codeFiles(dir)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const pattern of PATTERNS) {
        for (const m of line.matchAll(pattern)) {
          const name = m[1];
          if (PROVIDED.has(name)) continue;
          const after = line.slice((m.index ?? 0) + m[0].length);
          // `|| x`, `?? x`, or a second argument to getenv/get/env() means a default exists.
          const optional = /^\s*\)?\s*(\|\||\?\?)/.test(after) || /^\s*['"]?\s*,/.test(after);
          const use = found.get(name) ?? { name, optional: true, locations: [] };
          use.optional = use.optional && optional;
          use.locations.push(`${relative(dir, file).replace(/\\/g, '/')}:${i + 1}`);
          found.set(name, use);
        }
      }
    });
  }

  const used = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  const documented = envNames(join(dir, '.env.example'));
  const onLiara = new Set(setOnLiara);
  const missing = used
    .filter((u) => !onLiara.has(u.name))
    .map((u) => ({ ...u, documented: documented.includes(u.name) }));

  return { used, documented, missing };
}
