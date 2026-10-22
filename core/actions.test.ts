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
    const nets: { _id: string; name: string }[] = [];
    return {
      calls,
      client: {
        appPlans: async () => ({ 'small-g2': { available: true, RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, price: 659.72, displayPrice: 475000 } }),
        balance: async () => 1_000_000,
        bundlePlans: async () => ({ 'small-g2': { basic: { available: true, price: 381.94, displayPrice: 275000, rollback: true, maxLogsRetention: 7 }, pro: { available: true, price: 1145.83, displayPrice: 825000, rollback: true, maxLogsRetention: 60 } } }),
        networks: async () => nets,
        createNetwork: async (name: string) => { calls.push(`network:${name}`); nets.push({ _id: `id-${name}`, name }); return {}; },
        createApp: async (b: any) => { calls.push(`create:${b.name}:${b.planID}:${b.bundlePlanID}`); return {}; },
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
    // server plan 475,000 + feature plan 275,000
    expect(r.preview.cost).toMatch(/۷۵۰٬۰۰۰/);
    expect(r.preview.lines.join(' ')).toMatch(/basic/);
  });

  it('uses the private network the account has, or creates one first (Liara requires a network)', async () => {
    for (const existing of [[], [{ _id: 'n1', name: 'team-net' }]]) {
      const created: any[] = [];
      let list = existing;
      const { client, calls } = liara({
        networks: async () => list,
        createNetwork: async (name: string) => { calls.push(`network:${name}`); list = [{ _id: 'n-new', name }]; return {}; },
        createApp: async (b: any) => { created.push(b); return {}; },
      });
      const p = policy();
      const args = { app: 'shop', dir: project(), planID: 'small-g2' };
      const first = await runAction({ client, policy: p }, 'launch_app', args);
      if (first.status !== 'needs_approval') throw new Error('expected approval');
      expect(first.preview.lines.join(' ')).toMatch(existing.length ? /team-net/ : /hamyar-network.*ساخته می‌شود/);
      p.approvals.decide(first.approvalId, { approved: true, by: 'user', channel: 'dashboard' });
      await runAction({ client, policy: p }, 'launch_app', args, { approvalId: first.approvalId });
      expect(calls.filter((x) => x.startsWith('network:'))).toEqual(existing.length ? [] : ['network:hamyar-network']);
      expect(created[0].network).toBe(existing.length ? 'n1' : 'n-new');
    }
  });

  it('refuses an older plan before anything is created (the API takes only g2 plans with a feature plan)', async () => {
    const { client, calls } = liara({
      appPlans: async () => ({ 'ir-small': { available: true, RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, price: 1319.44 } }),
    });
    const r = await runAction({ client, policy: policy() }, 'launch_app', { app: 'shop', dir: project(), planID: 'ir-small' });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.error).toMatch(/نسل قدیمی/);
    expect(calls).toEqual([]);
  });

  it('sends the chosen feature plan, or the default one, when creating the app', async () => {
    for (const [bundle, expected] of [[undefined, 'basic'], ['pro', 'pro']] as const) {
      const { client, calls } = liara();
      const p = policy();
      const args = { app: 'shop', dir: project(), planID: 'small-g2', ...(bundle ? { bundlePlanID: bundle } : {}) };
      const first = await runAction({ client, policy: p }, 'launch_app', args);
      if (first.status !== 'needs_approval') throw new Error('expected approval');
      p.approvals.decide(first.approvalId, { approved: true, by: 'user', channel: 'dashboard' });
      await runAction({ client, policy: p }, 'launch_app', args, { approvalId: first.approvalId });
      expect(calls.find((x) => x.startsWith('create:'))).toBe(`create:shop:small-g2:${expected}`);
    }
  });

  it('sets env vars after creating the app and before the deploy, and reports a failure after creation honestly', async () => {
    const { client, calls } = liara();
    const p = policy();
    const args = { app: 'shop', dir: project(), planID: 'small-g2', variables: [{ key: 'DATABASE_URL', value: 'postgres://u:p@h/db' }] };
    const first = await runAction({ client, policy: p }, 'launch_app', args);
    if (first.status !== 'needs_approval') throw new Error('expected approval');
    p.approvals.decide(first.approvalId, { approved: true, by: 'user', channel: 'dashboard' });
    const r = await runAction({ client, policy: p }, 'launch_app', args, { approvalId: first.approvalId });
    expect(calls).toEqual(['network:hamyar-network', 'create:shop:small-g2:basic', 'envs:shop:DATABASE_URL', 'upload']);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.error).toMatch(/ساخته شد ولی دیپلوی کامل نشد.*هزینه/);
  });
});

describe('deploy preview', () => {
  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'hamyar-dep-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
    writeFileSync(join(dir, 'server.js'), "app.get('/health', () => {}); app.listen(process.env.PORT || 3000)");
    return dir;
  }
  const bundles = { 'small-g2': { basic: { available: true, price: 381.94, displayPrice: 275000, rollback: true, zeroDowntime: false }, standard: { available: true, price: 659.72, displayPrice: 475000, rollback: true, zeroDowntime: true } } };
  const client = (bundlePlanID: string) => ({
    releases: async () => ({ currentRelease: 'r1' }),
    getApp: async () => ({ planID: 'small-g2', bundlePlanID }),
    bundlePlans: async () => bundles,
  }) as any;

  it('promises no downtime only when the app feature plan has zero-downtime deploys', async () => {
    const basic = await ACTIONS.deploy.preview(client('basic'), { app: 'shop', dir: project() });
    expect(basic.downtime).toMatch(/قطعی کوتاه/);
    expect(basic.downtime).toMatch(/basic/);
    const standard = await ACTIONS.deploy.preview(client('standard'), { app: 'shop', dir: project() });
    expect(standard.downtime).toMatch(/بدون قطعی/);
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
