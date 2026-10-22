import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Policy, PolicyError } from './policy.js';

function policy(mode: 'observe' | 'review' | 'auto-safe' = 'review', start = 1_000_000) {
  let now = start;
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-policy-'));
  const auditPath = join(dir, 'audit.jsonl');
  const p = new Policy({ mode, auditPath, approvalsPath: join(dir, 'approvals.json'), now: () => now });
  return { p, auditPath, dir, advance: (ms: number) => (now += ms) };
}

const executed = (p: Policy, tool: string, app = 'shop') => p.audit({ tool, tier: 'T2', args: { app }, outcome: 'executed' });

describe('approval requirements by mode', () => {
  it('review: T0 runs, T1 and T2 need approval', () => {
    const { p } = policy('review');
    expect(p.needsApproval('T0')).toBe(false);
    expect(p.needsApproval('T1')).toBe(true);
    expect(p.needsApproval('T2')).toBe(true);
  });

  it('auto-safe: T1 runs without approval, T2 still needs it', () => {
    const { p } = policy('auto-safe');
    expect(p.needsApproval('T1')).toBe(false);
    expect(p.needsApproval('T2')).toBe(true);
  });

  it('observe: refuses any change', () => {
    const { p } = policy('observe');
    expect(() => p.assertAllowed('restart_app', 'T1')).toThrow(PolicyError);
    expect(() => p.assertAllowed('get_logs', 'T0')).not.toThrow();
  });

  it('T3 is always refused', () => {
    const { p } = policy('auto-safe');
    expect(() => p.assertAllowed('delete_app', 'T3')).toThrow(/حذف/);
  });
});

describe('kill switch', () => {
  it('revokes pending approvals and audits it', () => {
    const { p } = policy();
    p.approvals.request({ tool: 'restart_app', tier: 'T1', args: { app: 'shop' }, preview: { title: 't', lines: [], risk: '', downtime: '', undo: '' }, source: 'mcp' });
    expect(p.revokeAll()).toBe(1);
    expect(p.recent().at(-1)).toMatchObject({ outcome: 'revoked' });
  });
});

describe('rate limits from the shared audit log', () => {
  it('allows at most 3 deploys per 10 minutes', () => {
    const { p, advance } = policy();
    for (let i = 0; i < 3; i++) executed(p, 'deploy');
    expect(() => p.assertRate('deploy', 'shop')).toThrow(/دیپلوی/);
    advance(10 * 60_000 + 1);
    expect(() => p.assertRate('deploy', 'shop')).not.toThrow();
  });

  it('allows one restart per app every 5 minutes', () => {
    const { p } = policy();
    executed(p, 'restart_app', 'shop');
    expect(() => p.assertRate('restart_app', 'shop')).toThrow(/ری‌استارت/);
    expect(() => p.assertRate('restart_app', 'other')).not.toThrow();
  });

  it('caps write actions at 10 per hour', () => {
    const { p } = policy();
    for (let i = 0; i < 10; i++) executed(p, 'set_env', `app${i}`);
    expect(() => p.assertRate('set_env', 'app99')).toThrow(/ساعت/);
  });

  it('counts executions made by another process writing the same audit log', () => {
    const { p, auditPath, dir } = policy();
    const other = new Policy({ auditPath, approvalsPath: join(dir, 'approvals.json'), now: () => 1_000_000 });
    executed(other, 'restart_app', 'shop');
    expect(() => p.assertRate('restart_app', 'shop')).toThrow(/ری‌استارت/);
  });
});

describe('audit log', () => {
  it('appends JSON lines with secret values masked', () => {
    const { p, auditPath } = policy();
    p.audit({ tool: 'set_env', tier: 'T2', args: { app: 'shop', key: 'DATABASE_URL', value: 'postgres://u:pw@h/db' }, outcome: 'executed', approvedBy: 'user' });
    const line = JSON.parse(readFileSync(auditPath, 'utf8').trim());
    expect(line).toMatchObject({ tool: 'set_env', tier: 'T2', outcome: 'executed', approvedBy: 'user' });
    expect(line.args.value).toBe('***');
    expect(typeof line.at).toBe('string');
  });

  it('masks secret values nested inside lists, such as set_env variables', () => {
    const { p, auditPath } = policy();
    p.audit({ tool: 'set_env', tier: 'T2', args: { app: 'shop', variables: [{ key: 'DATABASE_URL', value: 'postgres://u:pw@h/db' }] }, outcome: 'executed' });
    const raw = readFileSync(auditPath, 'utf8');
    expect(raw).not.toContain('pw@h');
    expect(raw).toContain('DATABASE_URL');
  });

  it('lists recent entries', () => {
    const { p } = policy();
    p.audit({ tool: 'restart_app', tier: 'T1', args: { app: 'shop' }, outcome: 'executed' });
    expect(p.recent()).toHaveLength(1);
  });
});
