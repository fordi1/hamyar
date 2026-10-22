import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Policy } from './policy.js';
import { analyzeSource, cancelDeploy, requestDeploy, startDeploy, WizardError } from './wizard.js';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-wiz-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { express: '4' }, scripts: { start: 'node server.js' } }));
  writeFileSync(join(dir, 'server.js'), "const u = process.env.DATABASE_URL; const p = process.env.PORT || 3000; app.get('/health', () => {}); app.listen(p)");
  return dir;
}

const PLANS = {
  'small-g1': { available: true, RAM: { amount: 0.25 }, CPU: { amount: 0.25 }, price: 333.33, displayPrice: 240000 },
  'small-g2': { available: true, RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, price: 659.72, displayPrice: 475000 },
  'medium-g2': { available: true, RAM: { amount: 1 }, CPU: { amount: 1 }, price: 1319.44, displayPrice: 950000 },
};

function liara(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      appPlans: async () => PLANS,
      balance: async () => 1_000_000,
      listApps: async () => [{ project_id: 'blog' }],
      createApp: async (b: any) => { calls.push(`create:${b.name}:${b.planID}`); return {}; },
      updateEnvs: async (name: string, vars: any[]) => { calls.push(`envs:${name}:${vars.map((v) => `${v.key}=${v.value}`).join(',')}`); return {}; },
      uploadSource: async () => { calls.push('upload'); throw Object.assign(new Error('x'), { explanation: 'آپلود ناموفق' }); },
      ...overrides,
    } as any,
  };
}

function setup(overrides?: Record<string, any>) {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-wp-'));
  const policy = new Policy({ mode: 'review', auditPath: join(dir, 'audit.jsonl'), approvalsPath: join(dir, 'approvals.json') });
  const l = liara(overrides);
  return { ctx: { client: l.client, policy }, calls: l.calls, auditPath: join(dir, 'audit.jsonl'), approvalsPath: join(dir, 'approvals.json') };
}

describe('analyzeSource', () => {
  it('returns detection, required env vars and three real plans with the recommendation marked', async () => {
    const { ctx } = setup();
    const a = await analyzeSource(ctx, project(), 'My Shop');
    expect(a.app).toBe('my-shop');
    expect(a.detection.platform).toBe('node');
    expect(a.healthPath).toBe('/health');
    expect(a.env.required.map((e) => e.name)).toEqual(['DATABASE_URL']);
    expect(a.plans.map((p) => [p.id, p.role])).toEqual([['small-g1', 'cheaper'], ['small-g2', 'recommended'], ['medium-g2', 'bigger']]);
    expect(a.plans[1].affordable).toBe(true);
    expect(a.existingApps).toEqual(['blog']);
  });

  it('marks plans the balance cannot carry for a day', async () => {
    const { ctx } = setup({ balance: async () => 10_000 });
    const a = await analyzeSource(ctx, project(), 'shop');
    expect(a.plans.find((p) => p.role === 'recommended')?.affordable).toBe(false);
  });
});

describe('requestDeploy', () => {
  it('files one approval request whose preview names the env keys but holds no values', async () => {
    const { ctx, approvalsPath } = setup();
    const r = await requestDeploy(ctx, { dir: project(), app: 'shop', planID: 'small-g2', keys: ['DATABASE_URL'] });
    expect(r.keys).toEqual(['DATABASE_URL']);
    expect(r.preview.title).toContain('shop');
    expect(r.preview.lines.join(' ')).toMatch(/DATABASE_URL/);
    expect(ctx.policy.approvals.get(r.id)?.status).toBe('pending');
    expect(readFileSync(approvalsPath, 'utf8')).not.toMatch(/postgres/);
  });

  it('refuses a bad name, an app the user already has, an unknown plan, and an empty balance', async () => {
    const { ctx } = setup();
    const dir = project();
    await expect(requestDeploy(ctx, { dir, app: 'Shop!', planID: 'small-g2', keys: [] })).rejects.toThrow(WizardError);
    await expect(requestDeploy(ctx, { dir, app: 'blog', planID: 'small-g2', keys: [] })).rejects.toThrow(/blog/);
    await expect(requestDeploy(ctx, { dir, app: 'shop', planID: 'nope', keys: [] })).rejects.toThrow(/پلن/);
    const poor = setup({ balance: async () => 0 });
    await expect(requestDeploy(poor.ctx, { dir, app: 'shop', planID: 'small-g2', keys: [] })).rejects.toThrow(/موجودی/);
  });
});

describe('startDeploy', () => {
  it('runs only for a pending wizard request, applies the typed values, and never stores them', async () => {
    const { ctx, calls, auditPath, approvalsPath } = setup();
    const r = await requestDeploy(ctx, { dir: project(), app: 'shop', planID: 'small-g2', keys: ['DATABASE_URL'] });
    const events: string[] = [];
    const result = await startDeploy(ctx, r.id, { DATABASE_URL: 'postgres://u:secret@h/db' }, (e) => events.push(e.phase));
    expect(calls).toEqual(['create:shop:small-g2', 'envs:shop:DATABASE_URL=postgres://u:secret@h/db', 'upload']);
    expect(result.status).toBe('failed');
    expect(events[0]).toBe('PREPARING');
    expect(ctx.policy.approvals.get(r.id)?.status).toBe('approved');
    for (const file of [auditPath, approvalsPath]) expect(readFileSync(file, 'utf8')).not.toMatch(/secret@/);
    const outcomes = ctx.policy.recent().map((e) => e.outcome);
    expect(outcomes).toContain('approved');
    expect(outcomes).toContain('failed');
  });

  it('refuses missing values, a second start, and a request that was not pending', async () => {
    const { ctx, calls } = setup();
    const r = await requestDeploy(ctx, { dir: project(), app: 'shop', planID: 'small-g2', keys: ['DATABASE_URL'] });
    await expect(startDeploy(ctx, r.id, {}, () => {})).rejects.toThrow(/DATABASE_URL/);
    expect(calls).toEqual([]);
    await startDeploy(ctx, r.id, { DATABASE_URL: 'x' }, () => {});
    await expect(startDeploy(ctx, r.id, { DATABASE_URL: 'x' }, () => {})).rejects.toThrow(WizardError);
    await expect(startDeploy(ctx, 'NOPE00', {}, () => {})).rejects.toThrow(WizardError);
  });

  it('cannot start a request that came from Claude Code or another tool', async () => {
    const { ctx } = setup();
    const other = ctx.policy.approvals.request({ tool: 'restart_app', tier: 'T1', args: { app: 'shop' }, preview: { title: 't', lines: [] } as any, source: 'mcp' });
    await expect(startDeploy(ctx, other.id, {}, () => {})).rejects.toThrow(WizardError);
  });
});

describe('cancelDeploy', () => {
  it('revokes the pending request so it can no longer run', async () => {
    const { ctx } = setup();
    const r = await requestDeploy(ctx, { dir: project(), app: 'shop', planID: 'small-g2', keys: [] });
    cancelDeploy(ctx, r.id, 'ویرایش تنظیمات');
    expect(ctx.policy.approvals.get(r.id)?.status).toBe('revoked');
    await expect(startDeploy(ctx, r.id, {}, () => {})).rejects.toThrow(WizardError);
  });
});
