// Where the code for a new deploy comes from: an uploaded ZIP, a public GitHub repository,
// or a folder on the machine running Hamyar. Liara has no documented deploy-from-GitHub API,
// so Hamyar downloads the repository archive itself and uploads it through the official
// sources endpoint like any other folder.
//
// Everything lands in its own folder under .hamyar/sources/<id>. Archives are untrusted:
// entries that escape the folder are refused, links are skipped, sizes are capped.
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar } from 'tar';
import yauzl from 'yauzl';

export class SourceError extends Error {}

export type SourceOrigin = 'zip' | 'github' | 'local';
export interface Source {
  id: string;
  origin: SourceOrigin;
  label: string;
  dir: string;
  createdAt: string;
}

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
// unpacked size; a small archive can expand enormously (zip bomb)
export const MAX_EXTRACTED_BYTES = 300 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

// ---------- names ----------

// Liara app ids: lowercase letters, digits and hyphens, starting with a letter.
export function appNameProblem(name: string): string | undefined {
  if (name.length < 3) return 'نام برنامه باید دست‌کم ۳ حرف باشد.';
  if (name.length > 32) return 'نام برنامه حداکثر ۳۲ حرف است.';
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) return 'فقط حروف کوچک انگلیسی، عدد و خط تیره؛ با حرف شروع شود و با خط تیره تمام نشود.';
  return undefined;
}

export function suggestAppName(from: string): string {
  let name = from.toLowerCase().replace(/\.(zip|git)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(name)) name = `app-${name}`.replace(/-+$/, '');
  name = name.slice(0, 32).replace(/-+$/, '');
  return name.length >= 3 ? name : `${name}-app`.replace(/^-/, 'my');
}

// ---------- GitHub ----------

export interface GithubRef {
  owner: string;
  repo: string;
  branch?: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function parseGithubUrl(input: string): GithubRef {
  const text = input.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const parts = text.split('/');
  if (parts[0].includes('.') && parts[0] !== 'github.com' && parts[0] !== 'www.github.com') {
    throw new SourceError('فقط ریپازیتوری‌های github.com پشتیبانی می‌شوند.');
  }
  if (parts[0].endsWith('github.com')) parts.shift();
  const [owner, rawRepo, kind, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new SourceError('آدرس ریپازیتوری درست نیست. نمونه: https://github.com/you/my-app');
  }
  const branch = kind === 'tree' && rest.length ? rest.join('/') : undefined;
  return branch ? { owner, repo, branch } : { owner, repo };
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

// Counts bytes as they stream and stops once the limit is passed.
function limiter(maxBytes: number, what: string) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > maxBytes) return done(new SourceError(`حجم ${what} بیشتر از ${Math.round(maxBytes / 1024 / 1024)} مگابایت است.`));
      done(null, chunk);
    },
  });
}

// Public repositories only: codeload serves the branch as a .tar.gz with one top folder.
export async function fetchGithub(ref: GithubRef, dest: string, opts: { fetchImpl?: FetchImpl; maxBytes?: number } = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const branch = ref.branch ?? 'HEAD';
  if (!/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes('..')) throw new SourceError('نام شاخه درست نیست.');
  const url = `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/${branch}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  } catch (err: any) {
    throw new SourceError(`دانلود از GitHub انجام نشد (${err?.message ?? err}). اینترنت یا فیلترشکن را بررسی کنید.`);
  }
  if (res.status === 404) {
    throw new SourceError(`ریپازیتوری ${ref.owner}/${ref.repo}${ref.branch ? ` یا شاخه‌ی ${ref.branch}` : ''} پیدا نشد. اگر خصوصی است، در این نسخه پشتیبانی نمی‌شود؛ پروژه را ZIP کنید و آپلود کنید.`);
  }
  if (!res.ok || !res.body) throw new SourceError(`GitHub پاسخ ${res.status} داد؛ کمی بعد دوباره امتحان کنید.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  const max = opts.maxBytes ?? MAX_ARCHIVE_BYTES;
  if (declared > max) throw new SourceError(`حجم ریپازیتوری بیشتر از ${Math.round(max / 1024 / 1024)} مگابایت است.`);
  mkdirSync(dest, { recursive: true });
  let unpacked = 0;
  await pipeline(
    Readable.fromWeb(res.body as any),
    limiter(max, 'ریپازیتوری'),
    extractTar({
      cwd: dest,
      strip: 1,
      // tar already refuses absolute paths and '..'; links are skipped as well
      filter: (_path, entry: any) => {
        if (entry.type !== 'File' && entry.type !== 'Directory') return false;
        unpacked += entry.size ?? 0;
        if (unpacked > MAX_EXTRACTED_BYTES) throw new SourceError('حجم پروژه بعد از باز شدن بیش از حد مجاز است.');
        return true;
      },
    }),
  );
}

// ---------- ZIP ----------

const openZip = (buffer: Buffer) =>
  new Promise<yauzl.ZipFile>((resolveZip, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) =>
      err || !zip ? reject(new SourceError('این فایل ZIP معتبر نیست یا خراب است.')) : resolveZip(zip),
    ),
  );

const isLink = (e: yauzl.Entry) => ((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000;

function safeTarget(dest: string, name: string): string {
  const clean = name.replace(/\\/g, '/');
  const target = resolve(dest, clean);
  if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || (target !== dest && !target.startsWith(dest + sep))) {
    throw new SourceError(`فایل «${name}» در ZIP می‌خواهد بیرون از پوشه‌ی پروژه نوشته شود؛ این ZIP پذیرفته نشد.`);
  }
  return target;
}

export async function extractZip(buffer: Buffer, dest: string, opts: { maxBytes?: number } = {}): Promise<void> {
  const maxBytes = opts.maxBytes ?? MAX_EXTRACTED_BYTES;
  const zip = await openZip(buffer);
  const entries: yauzl.Entry[] = [];
  await new Promise<void>((done, reject) => {
    zip.on('entry', (e: yauzl.Entry) => {
      entries.push(e);
      if (entries.length > MAX_ENTRIES) return reject(new SourceError('تعداد فایل‌های ZIP بیش از حد است.'));
      zip.readEntry();
    });
    zip.on('end', done);
    zip.on('error', () => reject(new SourceError('این فایل ZIP معتبر نیست یا خراب است.')));
    zip.readEntry();
  });

  const files = entries.filter((e) => !e.fileName.endsWith('/') && !isLink(e) && !e.fileName.startsWith('__MACOSX/'));
  const total = files.reduce((n, e) => n + e.uncompressedSize, 0);
  if (total > maxBytes) throw new SourceError(`حجم پروژه بعد از باز شدن (${Math.round(total / 1024 / 1024)} مگابایت) بیش از حد مجاز است.`);

  // "shop/…" for every file: the user zipped the folder itself, so drop that level
  const tops = new Set(files.map((e) => e.fileName.replace(/\\/g, '/').split('/')[0]));
  const strip = tops.size === 1 && files.every((e) => e.fileName.replace(/\\/g, '/').includes('/')) ? [...tops][0] + '/' : '';

  mkdirSync(dest, { recursive: true });
  const root = resolve(dest);
  // validate every name before writing anything
  const targets = files.map((e) => safeTarget(root, e.fileName.replace(/\\/g, '/').slice(strip.length)));
  let written = 0;
  const zip2 = await openZip(buffer);
  const byName = new Map(files.map((e, i) => [e.fileName, targets[i]]));
  await new Promise<void>((done, reject) => {
    zip2.on('entry', (e: yauzl.Entry) => {
      const target = byName.get(e.fileName);
      if (!target) return zip2.readEntry();
      zip2.openReadStream(e, (err, stream) => {
        if (err || !stream) return reject(new SourceError('خواندن یکی از فایل‌های ZIP ممکن نشد.'));
        mkdirSync(dirname(target), { recursive: true });
        const count = new Transform({
          transform(chunk, _enc, cb) {
            written += chunk.length;
            if (written > maxBytes) return cb(new SourceError('حجم پروژه بعد از باز شدن بیش از حد مجاز است.'));
            cb(null, chunk);
          },
        });
        pipeline(stream, count, createWriteStream(target)).then(() => zip2.readEntry(), reject);
      });
    });
    zip2.on('end', done);
    zip2.on('error', reject);
    zip2.readEntry();
  });
}

// ---------- store ----------

const ID = /^[a-f0-9]{16}$/;

export class SourceStore {
  constructor(private root: string) {}

  create(origin: SourceOrigin, label: string): Source {
    const id = randomBytes(8).toString('hex');
    const source: Source = { id, origin, label, dir: join(this.root, id), createdAt: new Date().toISOString() };
    mkdirSync(source.dir, { recursive: true });
    writeFileSync(join(this.root, `${id}.json`), JSON.stringify(source));
    return source;
  }

  // a local folder is used in place, never copied
  register(origin: 'local', label: string, dir: string): Source {
    const id = randomBytes(8).toString('hex');
    const source: Source = { id, origin, label, dir, createdAt: new Date().toISOString() };
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, `${id}.json`), JSON.stringify(source));
    return source;
  }

  get(id: string): Source | undefined {
    if (!ID.test(id)) return undefined;
    const meta = join(this.root, `${id}.json`);
    if (!existsSync(meta)) return undefined;
    return JSON.parse(readFileSync(meta, 'utf8'));
  }

  // the folder that holds the project, optionally a subfolder (monorepos)
  projectDir(source: Source, subdir = ''): string {
    const base = resolve(source.dir);
    const target = resolve(base, subdir.replace(/\\/g, '/').replace(/^\/+/, ''));
    if (target !== base && !relative(base, target).split(sep).every((p) => p && p !== '..')) {
      throw new SourceError('زیرپوشه باید داخل پروژه باشد.');
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) throw new SourceError(`زیرپوشه‌ی «${subdir}» در پروژه پیدا نشد.`);
    return target;
  }

  remove(source: Source) {
    if (source.origin !== 'local') rmSync(source.dir, { recursive: true, force: true });
    rmSync(join(this.root, `${source.id}.json`), { force: true });
  }

  // downloaded and uploaded copies are kept for a day (re-deploys, retries), then removed
  cleanup(maxAgeMs = 86_400_000): number {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.root)) {
      const full = join(this.root, name);
      if (!ID.test(name) || !statSync(full).isDirectory()) continue;
      if (Date.now() - statSync(full).mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
        rmSync(join(this.root, `${name}.json`), { force: true });
        removed++;
      }
    }
    return removed;
  }
}
