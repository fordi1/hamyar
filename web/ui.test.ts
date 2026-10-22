// Static checks on the dashboard client: every element the scripts look up must exist in
// index.html or be created by the scripts, and no markup may carry inline styles (the CSP
// blocks them). A missing element at load once stopped app.js before init() ran.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pub = join(__dirname, 'public');
const html = readFileSync(join(pub, 'index.html'), 'utf8');
const scripts = ['app.js', 'wizard.js', 'apps.js', 'incidents.js', 'domains.js'].map((f) => ({ f, src: readFileSync(join(pub, f), 'utf8') }));
const allSrc = scripts.map((s) => s.src).join('\n');

const idsIn = (text: string) => new Set([...text.matchAll(/\bid="([a-z0-9-]+)"/g)].map((m) => m[1]));
const known = new Set([...idsIn(html), ...idsIn(allSrc)]);

describe('dashboard client', () => {
  it('only looks up element ids that exist in the page or in script templates', () => {
    const missing: string[] = [];
    for (const { f, src } of scripts) {
      for (const m of src.matchAll(/\$\('#([a-z0-9-]+)'\)/g)) if (!known.has(m[1])) missing.push(`${f}: #${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('wires top-level handlers only to elements present in index.html', () => {
    // statements that run at load (not inside a function) must find their element
    const app = scripts[0].src;
    const topLevel = app.split('\n').filter((l) => /^\$\('#[a-z0-9-]+'\)\.(onclick|onchange|onsubmit)/.test(l) || /^document\.querySelector\(/.test(l));
    for (const line of topLevel) {
      const id = line.match(/\$\('#([a-z0-9-]+)'\)/)?.[1];
      if (id) expect(idsIn(html).has(id), line).toBe(true);
      const sel = line.match(/^document\.querySelector\('([^']+)'\)/)?.[1];
      if (sel) expect(html.includes(sel.replace(/^\[|\]$/g, '')), line).toBe(true);
    }
  });

  it('has no inline style attributes (blocked by the CSP)', () => {
    expect(html).not.toMatch(/\sstyle="/);
    for (const { f, src } of scripts) expect(src, f).not.toMatch(/\sstyle="/);
  });

  it('loads every client script from the page', () => {
    for (const { f } of scripts) expect(html).toContain(`<script src="/${f}"></script>`);
  });
});
