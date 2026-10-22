import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIRECT_ACTIONS, RANGES, downsample, logLevel, requestAppAction, runApprovedAppAction, shapeLogs, shapeMetrics, shapeReleases, validAppName } from './monitor.js';
import { Policy } from './policy.js';

function ctx(mode: 'review' | 'auto-safe' = 'review') {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-mon-'));
  const calls: string[] = [];
  const client = {
    restart: async (app: string) => { calls.push(`restart:${app}`); return {}; },
    scale: async (app: string, n: number) => { calls.push(`scale:${app}:${n}`); return {}; },
  } as any;
  return { calls, ctx: { client, policy: new Policy({ mode, auditPath: join(dir, 'audit.jsonl'), approvalsPath: join(dir, 'approvals.json') }) } };
}

describe('requestAppAction / runApprovedAppAction', () => {
  it('files an approval request and runs only after a human approved it', async () => {
    const { ctx: c, calls } = ctx();
    const r = await requestAppAction(c, 'restart_app', { app: 'shop' });
    if (r.status !== 'needs_approval') throw new Error('expected approval');
    expect(calls).toEqual([]);
    await expect(runApprovedAppAction(c, r.approvalId)).rejects.toThrow(/تأیید/);
    c.policy.approvals.decide(r.approvalId, { approved: true, by: 'user', channel: 'dashboard' });
    const done = await runApprovedAppAction(c, r.approvalId);
    expect(done.status).toBe('done');
    expect(calls).toEqual(['restart:shop']);
    // single use
    await expect(runApprovedAppAction(c, r.approvalId)).rejects.toThrow();
  });

  it('refuses tools that are not direct app actions and unsafe names', async () => {
    const { ctx: c } = ctx();
    await expect(requestAppAction(c, 'set_env', { app: 'shop' })).rejects.toThrow();
    await expect(requestAppAction(c, 'restart_app', { app: '../x' })).rejects.toThrow();
    await expect(requestAppAction(c, 'rollback', { app: 'shop' })).rejects.toThrow(/نسخه/);
  });

  it('accepts domain steps with a valid domain and passes the domain on', async () => {
    const { ctx: c } = ctx();
    await expect(requestAppAction(c, 'add_domain', { app: 'shop', domain: 'http://x' })).rejects.toThrow(/دامنه/);
    const r = await requestAppAction(c, 'enable_ssl', { app: 'shop', domain: 'shop.ir' });
    if (r.status !== 'needs_approval') throw new Error('expected approval');
    expect(c.policy.approvals.get(r.approvalId)?.args).toMatchObject({ app: 'shop', domain: 'shop.ir', direct: true });
  });

  it('will not run a request filed by Claude Code from the dashboard path', async () => {
    const { ctx: c, calls } = ctx();
    const other = c.policy.approvals.request({ tool: 'restart_app', tier: 'T1', args: { app: 'shop' }, preview: { title: 't', lines: [] } as any, source: 'mcp' });
    c.policy.approvals.decide(other.id, { approved: true, by: 'user', channel: 'dashboard' });
    await expect(runApprovedAppAction(c, other.id)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

const series = (pairs: [number, number][]) => ({ result: [{ values: pairs.map(([t, v]) => [t, String(v)]) }] });

describe('logLevel', () => {
  it('classifies errors, warnings and the rest', () => {
    expect(logLevel('Error: Cannot read property id of undefined', 'stdout')).toBe('error');
    expect(logLevel('anything', 'stderr')).toBe('error');
    expect(logLevel('Database connection pool warning', 'stdout')).toBe('warn');
    expect(logLevel('(node:1) DeprecationWarning: Buffer()', 'stdout')).toBe('warn');
    expect(logLevel('GET /api/users 200 120ms', 'stdout')).toBe('info');
  });
});

describe('shapeLogs', () => {
  const raw = [
    { type: 'stdout', datetime: '2026-10-22T10:00:00Z', message: 'GET /products 200 12ms' },
    { type: 'stdout', datetime: '2026-10-22T10:00:05Z', message: 'Error: DATABASE_URL is not defined' },
    { type: 'stdout', datetime: '2026-10-22T10:00:06Z', message: 'Error: DATABASE_URL is not defined' },
    { type: 'stdout', datetime: '2026-10-22T10:00:07Z', message: 'pool warning: 9 of 10 used' },
    { type: 'stdout', datetime: '2026-10-22T10:00:08Z', message: '' },
  ];

  it('returns newest first with levels, counts for the whole window, and the top error pattern', () => {
    const r = shapeLogs(raw, {});
    expect(r.lines.map((l) => l.level)).toEqual(['warn', 'error', 'error', 'info']);
    expect(r.lines[0].at).toBe(Date.parse('2026-10-22T10:00:07Z'));
    expect(r.counts).toEqual({ error: 2, warn: 1, info: 1 });
    expect(r.topErrors[0]).toMatchObject({ count: 2, sample: 'Error: DATABASE_URL is not defined' });
  });

  it('filters by level and text without changing the counts', () => {
    expect(shapeLogs(raw, { level: 'error' }).lines).toHaveLength(2);
    expect(shapeLogs(raw, { q: 'products' }).lines.map((l) => l.message)).toEqual(['GET /products 200 12ms']);
    expect(shapeLogs(raw, { level: 'error' }).counts.info).toBe(1);
  });

  it('caps the number of lines and says so', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ type: 'stdout', datetime: new Date(1e12 + i * 1000).toISOString(), message: `line ${i}` }));
    const r = shapeLogs(many, { limit: 10 });
    expect(r.lines).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.lines[0].message).toBe('line 49');
  });

  it('treats a non-array response as no logs', () => {
    expect(shapeLogs({ error: 'x' }, {}).lines).toEqual([]);
  });
});

describe('downsample', () => {
  it('keeps short series and reduces long ones to buckets of the maximum', () => {
    const short = [{ t: 1, v: 1 }, { t: 2, v: 2 }];
    expect(downsample(short, 10)).toEqual(short);
    const long = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: i % 7 === 0 ? 100 : 1 }));
    const d = downsample(long, 100);
    expect(d.length).toBeLessThanOrEqual(100);
    expect(Math.max(...d.map((p) => p.v))).toBe(100);
  });
});

describe('shapeMetrics', () => {
  it('converts memory to MB, attaches plan limits, and reports each missing series as unavailable', () => {
    const m = shapeMetrics(
      {
        cpu: series([[1000, 0.2], [1060, 0.4]]),
        memory: series([[1000, 100 * 1024 * 1024], [1060, 210 * 1024 * 1024]]),
        rx: undefined,
        tx: series([[1000, 2048]]),
        summary: { disksUsage: [{ name: 'data', usage: 250, size: 1000 }] },
      },
      { ramGB: 0.5, cpu: 0.5 },
    );
    expect(m.cpu).toMatchObject({ last: 0.4, limit: 0.5 });
    expect(m.memory).toMatchObject({ last: 210, limit: 512 });
    expect(m.memory.points?.[0]).toEqual({ t: 1_000_000, v: 100 });
    expect(m.networkIn.unavailable).toMatch(/لیارا/);
    expect(m.networkOut.last).toBe(2048);
    expect(m.disks).toEqual([{ name: 'data', usedRatio: 0.25 }]);
  });

  it('says unavailable instead of drawing an empty chart', () => {
    const m = shapeMetrics({ cpu: { result: [] }, memory: undefined, rx: undefined, tx: undefined, summary: undefined }, {});
    expect(m.cpu.unavailable).toBeTruthy();
    expect(m.memory.unavailable).toBeTruthy();
    expect(m.disks).toEqual([]);
  });
});

describe('shapeReleases', () => {
  it('marks the current release and which ones can be rolled back to', () => {
    const r = shapeReleases({
      currentRelease: 'r3',
      releases: [
        { _id: 'r1', state: 'FAILED', createdAt: '2026-10-21T08:00:00Z', failReason: 'build failed' },
        { _id: 'r3', state: 'READY', createdAt: '2026-10-21T10:00:00Z' },
        { _id: 'r2', state: 'READY', createdAt: '2026-10-21T09:00:00Z' },
      ],
    });
    expect(r.map((x) => [x.id, x.current, x.canRollback])).toEqual([['r3', true, false], ['r2', false, true], ['r1', false, false]]);
    expect(r[2].failReason).toBe('build failed');
  });
});

describe('guards', () => {
  it('accepts only Liara-style app names in URLs', () => {
    expect(validAppName('shop-api')).toBe(true);
    expect(validAppName('../me')).toBe(false);
    expect(validAppName('Shop')).toBe(false);
  });

  it('offers only reversible app actions as direct buttons', () => {
    expect(DIRECT_ACTIONS).toEqual(['restart_app', 'turn_on_app', 'turn_off_app', 'rollback']);
    expect(Object.keys(RANGES)).toEqual(['1h', '24h', '7d']);
  });
});
