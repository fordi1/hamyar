import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, envDiff, runAction, readEnvFile } from './actions.js';
import { LiaraError } from './liara-client.js';
import { Policy } from './policy.js';

describe('envDiff', () => {
  it('merges updates into the full current set and reports changes without values', () => {
    const d = envDiff(
      [{ key: 'A', value: '1' }, { key: 'B', value: '2' }],
      [{ key: 'B', value: '3' }, { key: 'C', value: '4' }],
    );
    expect(d.merged).toEqual([{ key: 'A', value: '1' }, { key: 'B', value: '3' }, { key: 'C', value: '4' }]);
    expect(d.added).toEqual(['C']);
    expect(d.changed).toEqual(['B']);
    expect(d.unchanged).toEqual(['A']);
  });

  it('treats an identical value as unchanged', () => {
    expect(envDiff([{ key: 'A', value: '1' }], [{ key: 'A', value: '1' }]).changed).toEqual([]);
  });
});

describe('readEnvFile', () => {
  it('reads only the requested keys from a local .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hamyar-envfile-'));
    const path = join(dir, '.env');
    writeFileSync(path, 'DATABASE_URL="postgres://u:p@h/db"\nOTHER=x\n# c\n');
    expect(readEnvFile(path, ['DATABASE_URL'])).toEqual([{ key: 'DATABASE_URL', value: 'postgres://u:p@h/db' }]);
    expect(() => readEnvFile(path, ['MISSING'])).toThrow(/MISSING/);
  });
});

function fakeClient(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      getApp: async () => ({ _id: 'id1', project_id: 'shop', planID: 'small-g2', envs: [{ key: 'A', value: '1' }] }),
      restart: async (name: string) => { calls.push(`restart:${name}`); return {}; },
      updateEnvs: async (name: string, vars: any[]) => { calls.push(`envs:${name}:${vars.map((v) => v.key).join(',')}`); return {}; },
      ...overrides,
    } as any,
  };
}

function policy(mode: 'review' | 'auto-safe' | 'observe' = 'review') {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-a-'));
  return new Policy({ mode, auditPath: join(dir, 'audit.jsonl'), approvalsPath: join(dir, 'approvals.json') });
}

describe('runAction', () => {
  it('files an approval request first and executes only after a human decision', async () => {
    const { client, calls } = fakeClient();
    const p = policy();
    const first = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' });
    expect(first.status).toBe('needs_approval');
    expect(calls).toEqual([]);
    if (first.status !== 'needs_approval') return;
    expect(first.preview.title).toContain('shop');

    p.approvals.decide(first.approvalId, { approved: true, by: 'user', channel: 'dashboard' });
    const second = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' }, { approvalId: first.approvalId });
    expect(second.status).toBe('done');
    expect(calls).toEqual(['restart:shop']);
    expect(p.recent().map((e) => [e.outcome, e.approvedBy])).toEqual([['previewed', undefined], ['executed', 'user (dashboard)']]);
  });

  it('does not execute when the model calls again with the id but no human approved', async () => {
    const { client, calls } = fakeClient();
    const p = policy();
    const first = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' }, undefined, undefined, 'mcp');
    if (first.status !== 'needs_approval') throw new Error('expected approval request');
    const again = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' }, { approvalId: first.approvalId });
    expect(again).toMatchObject({ status: 'blocked' });
    expect(calls).toEqual([]);
  });

  it('does not execute a rejected request', async () => {
    const { client, calls } = fakeClient();
    const p = policy();
    const first = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' });
    if (first.status !== 'needs_approval') throw new Error('expected approval request');
    p.approvals.decide(first.approvalId, { approved: false, by: 'user', channel: 'terminal', reason: 'الان نه' });
    const again = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' }, { approvalId: first.approvalId });
    expect(again.status).toBe('blocked');
    expect(calls).toEqual([]);
  });

  it('runs T0-free low-risk actions directly in auto-safe mode', async () => {
    const { client, calls } = fakeClient();
    const r = await runAction({ client, policy: policy('auto-safe') }, 'restart_app', { app: 'shop' });
    expect(r.status).toBe('done');
    expect(calls).toEqual(['restart:shop']);
  });

  it('blocks changes in observe mode and records it', async () => {
    const { client, calls } = fakeClient();
    const p = policy('observe');
    const r = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' });
    expect(r.status).toBe('blocked');
    expect(calls).toEqual([]);
    expect(p.recent()[0].outcome).toBe('blocked');
  });

  it('set_env merges with existing variables and never puts values in the preview', async () => {
    const { client, calls } = fakeClient();
    const p = policy();
    const args = { app: 'shop', variables: [{ key: 'DATABASE_URL', value: 'postgres://u:secret@h/db' }] };
    const first = await runAction({ client, policy: p }, 'set_env', args);
    if (first.status !== 'needs_approval') throw new Error('expected preview');
    expect(JSON.stringify(first.preview)).not.toContain('secret');
    expect(first.preview.lines.join(' ')).toContain('DATABASE_URL');
    p.approvals.decide(first.approvalId, { approved: true, by: 'user', channel: 'dashboard' });
    await runAction({ client, policy: p }, 'set_env', args, { approvalId: first.approvalId });
    expect(calls).toEqual(['envs:shop:A,DATABASE_URL']);
  });

  it('reports Liara failures with the Persian explanation', async () => {
    const err = Object.assign(new Error('x'), { explanation: 'موجودی حساب لیارا کافی نیست' });
    const { client } = fakeClient({ restart: async () => { throw err; } });
    const r = await runAction({ client, policy: policy('auto-safe') }, 'restart_app', { app: 'shop' });
    expect(r).toMatchObject({ status: 'failed', error: 'موجودی حساب لیارا کافی نیست' });
  });

  it('refuses unknown tools', async () => {
    const { client } = fakeClient();
    const r = await runAction({ client, policy: policy() }, 'delete_app', { app: 'shop' });
    expect(r.status).toBe('blocked');
  });
});

describe('launch_app', () => {
  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'hamyar-launch-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }));
    writeFileSync(join(dir, 'server.js'), "const u = process.env.DATABASE_URL; app.get('/health', () => {}); app.listen(process.env.PORT || 3000)");
    return dir;
  }
  const liara = (overrides: Record<string, any> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      client: {
        appPlans: async () => ({ 'small-g2': { available: true, RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, price: 659.72, displayPrice: 475000 } }),
        balance: async () => 1_000_000,
        createApp: async (b: any) => { calls.push(`create:${b.name}`); return {}; },
        updateEnvs: async (name: string, vars: any[]) => { calls.push(`envs:${name}:${vars.map((v) => v.key).join(',')}`); return {}; },
        uploadSource: async () => { calls.push('upload'); throw Object.assign(new Error('x'), { explanation: 'آپلود ناموفق' }); },
        ...overrides,
      } as any,
    };
  };

  it('warns in the preview when the code needs env vars that were not provided', async () => {
    const { client } = liara();
    const p = policy();
    const r = await runAction({ client, policy: p }, 'launch_app', { app: 'shop', dir: project(), planID: 'small-g2' });
    if (r.status !== 'needs_approval') throw new Error('expected approval');
    expect(r.preview.lines.join(' ')).toMatch(/DATABASE_URL/);
    expect(r.preview.cost).toMatch(/۴۷۵٬۰۰۰/);
  });

  it('sets env vars after creating the app and before the deploy, and reports a failure after creation honestly', async () => {
    const { client, calls } = liara();
    const p = policy();
    const args = { app: 'shop', dir: project(), planID: 'small-g2', variables: [{ key: 'DATABASE_URL', value: 'postgres://u:p@h/db' }] };
    const first = await runAction({ client, policy: p }, 'launch_app', args);
    if (first.status !== 'needs_approval') throw new Error('expected approval');
    p.approvals.decide(first.approvalId, { approved: true, by: 'user', channel: 'dashboard' });
    const r = await runAction({ client, policy: p }, 'launch_app', args, { approvalId: first.approvalId });
    expect(calls).toEqual(['create:shop', 'envs:shop:DATABASE_URL', 'upload']);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.error).toMatch(/ساخته شد ولی دیپلوی کامل نشد.*هزینه/);
  });
});

describe('rollback', () => {
  const releases = [
    { _id: 'r3', state: 'READY', createdAt: '2026-10-21T10:00:00Z', port: 3000, projectType: 'node', sourceID: 's3' },
    { _id: 'r2', state: 'READY', createdAt: '2026-10-21T09:00:00Z', port: 3000, projectType: 'node', sourceID: 's2' },
    { _id: 'r1', state: 'FAILED', createdAt: '2026-10-21T08:00:00Z', port: 3000, projectType: 'node' },
  ];
  const healthyDeps = { probe: async () => ({ samples: [{ status: 200, ms: 20 }], okRatio: 1, p50: 20, p95: 20, healthy: true }), sleep: async () => {}, rounds: 1 };
  function liara(rollback: () => Promise<unknown>, current = 'r3') {
    const calls: string[] = [];
    let served = current;
    return {
      calls,
      client: {
        releases: async () => ({ currentRelease: served, releases }),
        rollback: async (_a: string, id: string) => { calls.push(`rollback:${id}`); await rollback(); served = id; return {}; },
        createRelease: async (_a: string, body: any) => { calls.push(`release:${body.sourceID}`); served = 'r4'; return 'r4'; },
        buildLogs: async () => ({ release: { state: 'READY' }, buildOutput: [] }),
      } as any,
    };
  }
  const notFound = () => Promise.reject(new LiaraError(404, '/rollback', {}, 'not found'));

  it('refuses a target that is missing, current, or not healthy', async () => {
    const { client } = liara(async () => {});
    for (const [id, msg] of [['r9', /پیدا نشد/], ['r3', /نسخه‌ی فعلی/], ['r1', /امن نیست/]] as const) {
      await expect(ACTIONS.rollback.execute(client, { app: 'shop', releaseID: id }, () => {}, healthyDeps)).rejects.toMatchObject({ explanation: expect.stringMatching(msg) });
    }
  });

  it('uses native rollback and verifies that Liara now serves the target', async () => {
    const { client, calls } = liara(async () => {});
    const r: any = await ACTIONS.rollback.execute(client, { app: 'shop', releaseID: 'r2' }, () => {}, healthyDeps);
    expect(calls).toEqual(['rollback:r2']);
    expect(r).toMatchObject({ method: 'native', state: 'VERIFIED_HEALTHY', previous: 'r3' });
  });

  it('falls back to redeploying the target release source when the native endpoint is missing', async () => {
    const { client, calls } = liara(notFound);
    const r: any = await ACTIONS.rollback.execute(client, { app: 'shop', releaseID: 'r2' }, () => {}, healthyDeps);
    expect(calls).toEqual(['rollback:r2', 'release:s2']);
    expect(r).toMatchObject({ method: 'redeploy', state: 'VERIFIED_HEALTHY', releaseID: 'r4' });
  });

  it('explains the alternative when neither native rollback nor the release source is available', async () => {
    const saved = releases[1].sourceID;
    delete (releases[1] as any).sourceID;
    const { client } = liara(notFound);
    await expect(ACTIONS.rollback.execute(client, { app: 'shop', releaseID: 'r2' }, () => {}, healthyDeps)).rejects.toMatchObject({ explanation: expect.stringMatching(/دوباره deploy/) });
    releases[1].sourceID = saved;
  });

  it('does not hide other Liara errors behind the fallback', async () => {
    const { client, calls } = liara(() => Promise.reject(new LiaraError(500, '/rollback', {}, 'server error')));
    await expect(ACTIONS.rollback.execute(client, { app: 'shop', releaseID: 'r2' }, () => {}, healthyDeps)).rejects.toBeInstanceOf(LiaraError);
    expect(calls).toEqual(['rollback:r2']);
  });
});
