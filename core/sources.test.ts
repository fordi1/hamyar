import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { create as createTar } from 'tar';
import { ZipFile } from 'yazl';
import { describe, expect, it } from 'vitest';
import { SourceError, SourceStore, appNameProblem, extractZip, fetchGithub, parseGithubUrl, suggestAppName } from './sources.js';

const tmp = (p = 'hamyar-src-') => mkdtempSync(join(tmpdir(), p));

function zip(entries: Record<string, string>, opts: { symlink?: string } = {}): Promise<Buffer> {
  const z = new ZipFile();
  for (const [name, text] of Object.entries(entries)) z.addBuffer(Buffer.from(text), name);
  if (opts.symlink) z.addBuffer(Buffer.from('/etc/passwd'), opts.symlink, { mode: 0o120777 });
  z.end();
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => parts.push(c)).on('end', () => resolve(Buffer.concat(parts))).on('error', reject);
  });
}

// yazl refuses unsafe names, so a traversal entry is written by patching the name bytes.
async function zipWithName(name: string): Promise<Buffer> {
  const safe = name.replace(/\.\./g, 'xx');
  const buf = await zip({ [safe]: 'evil' });
  return Buffer.from(buf.toString('latin1').split(safe).join(name), 'latin1');
}

describe('parseGithubUrl', () => {
  it('accepts the common ways people paste a repository', () => {
    expect(parseGithubUrl('https://github.com/you/shop-api')).toEqual({ owner: 'you', repo: 'shop-api' });
    expect(parseGithubUrl('github.com/you/shop-api.git')).toEqual({ owner: 'you', repo: 'shop-api' });
    expect(parseGithubUrl('https://github.com/you/shop-api/tree/dev')).toEqual({ owner: 'you', repo: 'shop-api', branch: 'dev' });
    expect(parseGithubUrl('you/shop-api')).toEqual({ owner: 'you', repo: 'shop-api' });
  });

  it('refuses other hosts and malformed input', () => {
    expect(() => parseGithubUrl('https://gitlab.com/you/shop')).toThrow(SourceError);
    expect(() => parseGithubUrl('https://github.com/you')).toThrow(SourceError);
    expect(() => parseGithubUrl('https://github.com/you/repo;rm -rf')).toThrow(SourceError);
  });
});

describe('appNameProblem / suggestAppName', () => {
  it('follows Liara name rules', () => {
    expect(appNameProblem('shop-api')).toBeUndefined();
    expect(appNameProblem('ab')).toMatch(/۳/);
    expect(appNameProblem('Shop')).toBeDefined();
    expect(appNameProblem('-shop')).toBeDefined();
    expect(appNameProblem('shop-')).toBeDefined();
    expect(appNameProblem('1shop')).toBeDefined();
  });

  it('turns a folder or repo name into a valid suggestion', () => {
    expect(suggestAppName('My_Shop API')).toBe('my-shop-api');
    expect(suggestAppName('42')).toBe('app-42');
    expect(appNameProblem(suggestAppName('x'))).toBeUndefined();
  });
});

describe('extractZip', () => {
  it('extracts files and strips a single top-level folder', async () => {
    const dest = tmp();
    await extractZip(await zip({ 'shop/package.json': '{}', 'shop/src/index.js': 'x' }), dest);
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe('{}');
    expect(existsSync(join(dest, 'src', 'index.js'))).toBe(true);
  });

  it('keeps the layout when files sit at the root', async () => {
    const dest = tmp();
    await extractZip(await zip({ 'package.json': '{}', 'src/index.js': 'x' }), dest);
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
  });

  it('refuses entries that escape the folder', async () => {
    const dest = tmp();
    await expect(extractZip(await zipWithName('../escape.txt'), dest)).rejects.toThrow(SourceError);
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false);
  });

  it('skips symbolic links', async () => {
    const dest = tmp();
    await extractZip(await zip({ 'a.txt': 'a' }, { symlink: 'link' }), dest);
    expect(existsSync(join(dest, 'link'))).toBe(false);
    expect(existsSync(join(dest, 'a.txt'))).toBe(true);
  });

  it('stops at the size limit (zip bomb guard)', async () => {
    const dest = tmp();
    await expect(extractZip(await zip({ 'big.txt': 'a'.repeat(5000) }), dest, { maxBytes: 1000 })).rejects.toThrow(/حجم/);
  });

  it('rejects data that is not a zip', async () => {
    await expect(extractZip(Buffer.from('not a zip'), tmp())).rejects.toThrow(SourceError);
  });
});

describe('fetchGithub', () => {
  async function tarball(): Promise<Buffer> {
    const root = tmp();
    mkdirSync(join(root, 'shop-api-main', 'src'), { recursive: true });
    writeFileSync(join(root, 'shop-api-main', 'package.json'), '{"name":"shop"}');
    writeFileSync(join(root, 'shop-api-main', 'src', 'i.js'), 'x');
    const parts: Buffer[] = [];
    for await (const c of createTar({ gzip: true, cwd: root }, ['shop-api-main'])) parts.push(c as Buffer);
    return Buffer.concat(parts);
  }

  it('downloads the branch archive from codeload and extracts it without the top folder', async () => {
    const body = await tarball();
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return new Response(Readable.toWeb(Readable.from(body)) as any, { status: 200 });
    };
    const dest = tmp();
    await fetchGithub({ owner: 'you', repo: 'shop-api', branch: 'main' }, dest, { fetchImpl });
    expect(urls).toEqual(['https://codeload.github.com/you/shop-api/tar.gz/main']);
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toContain('shop');
    expect(existsSync(join(dest, 'src', 'i.js'))).toBe(true);
  });

  it('explains a missing or private repository', async () => {
    const fetchImpl = async () => new Response('Not Found', { status: 404 });
    await expect(fetchGithub({ owner: 'you', repo: 'nope' }, tmp(), { fetchImpl })).rejects.toThrow(/خصوصی|پیدا نشد/);
  });

  it('stops a download over the size limit', async () => {
    const body = await tarball();
    const fetchImpl = async () => new Response(Readable.toWeb(Readable.from(body)) as any, { status: 200 });
    await expect(fetchGithub({ owner: 'you', repo: 'shop-api' }, tmp(), { fetchImpl, maxBytes: 10 })).rejects.toThrow(/حجم/);
  });
});

describe('SourceStore', () => {
  it('creates folders by id, finds them, and refuses unknown or unsafe ids', () => {
    const store = new SourceStore(tmp());
    const s = store.create('zip', 'shop.zip');
    expect(existsSync(s.dir)).toBe(true);
    expect(store.get(s.id)?.label).toBe('shop.zip');
    expect(store.get('../../etc')).toBeUndefined();
    expect(store.get('ffffffffffffffff')).toBeUndefined();
  });

  it('resolves a subfolder only inside the source', () => {
    const store = new SourceStore(tmp());
    const s = store.create('github', 'you/shop');
    mkdirSync(join(s.dir, 'apps', 'web'), { recursive: true });
    expect(store.projectDir(s, 'apps/web')).toBe(join(s.dir, 'apps', 'web'));
    expect(() => store.projectDir(s, '../..')).toThrow(SourceError);
    expect(() => store.projectDir(s, 'missing')).toThrow(SourceError);
  });

  it('removes sources older than the limit', () => {
    const store = new SourceStore(tmp());
    const old = store.create('zip', 'old.zip');
    const past = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(old.dir, past, past);
    const fresh = store.create('zip', 'new.zip');
    expect(store.cleanup(86_400_000)).toBe(1);
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(fresh.dir)).toBe(true);
  });
});
