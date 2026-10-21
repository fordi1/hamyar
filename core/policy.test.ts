import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Policy, PolicyError } from './policy.js';

function policy(mode: 'observe' | 'review' | 'auto-safe' = 'review', start = 1_000_000) {
  let now = start;
  const auditPath = join(mkdtempSync(join(tmpdir(), 'hamyar-audit-')), 'audit.jsonl');
  const p = new Policy({ mode, auditPath, now: () => now });
  return { p, auditPath, advance: (ms: number) => (now += ms) };
}

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

describe('confirm tokens', () => {
  it('accepts a token only for the exact same tool and arguments, once', () => {
    const { p } = policy();
    const { token } = p.issue('resize_plan', { app: 'shop', planID: 'medium-g2' });
    expect(() => p.consume('resize_plan', { app: 'shop', planID: 'pro-g2' }, token)).toThrow(/آرگومان/);
    expect(() => p.consume('restart_app', { app: 'shop', planID: 'medium-g2' }, token)).toThrow();
    expect(() => p.consume('resize_plan', { planID: 'medium-g2', app: 'shop' }, token)).not.toThrow();
    expect(() => p.consume('resize_plan', { app: 'shop', planID: 'medium-g2' }, token)).toThrow(/استفاده شده/);
  });

  it('binds nested argument values too', () => {
    const { p } = policy();
    const { token } = p.issue('set_env', { app: 'shop', variables: [{ key: 'A', value: '1' }] });
    expect(() => p.consume('set_env', { app: 'shop', variables: [{ key: 'A', value: '2' }] }, token)).toThrow(/آرگومان/);
    expect(() => p.consume('set_env', { app: 'shop', variables: [{ value: '1', key: 'A' }] }, token)).not.toThrow();
  });

  it('expires after 10 minutes', () => {
    const { p, advance } = policy();
    const { token } = p.issue('restart_app', { app: 'shop' });
    advance(10 * 60_000 + 1);
    expect(() => p.consume('restart_app', { app: 'shop' }, token)).toThrow(/منقضی/);
  });

  it('rejects unknown tokens', () => {
    const { p } = policy();
    expect(() => p.consume('restart_app', { app: 'shop' }, 'nope')).toThrow(PolicyError);
  });

  it('revokeAll invalidates outstanding tokens (kill switch)', () => {
    const { p } = policy();
    const { token } = p.issue('restart_app', { app: 'shop' });
    p.revokeAll();
    expect(() => p.consume('restart_app', { app: 'shop' }, token)).toThrow();
  });
});

describe('rate limits', () => {
  it('allows at most 3 deploys per 10 minutes', () => {
    const { p, advance } = policy();
    for (let i = 0; i < 3; i++) p.assertRate('deploy', 'shop');
    expect(() => p.assertRate('deploy', 'shop')).toThrow(/دیپلوی/);
    advance(10 * 60_000 + 1);
    expect(() => p.assertRate('deploy', 'shop')).not.toThrow();
  });

  it('allows one restart per app every 5 minutes', () => {
    const { p } = policy();
    p.assertRate('restart_app', 'shop');
    expect(() => p.assertRate('restart_app', 'shop')).toThrow(/ری‌استارت/);
    expect(() => p.assertRate('restart_app', 'other')).not.toThrow();
  });

  it('caps write actions at 10 per hour', () => {
    const { p } = policy();
    for (let i = 0; i < 10; i++) p.assertRate('set_env', `app${i}`);
    expect(() => p.assertRate('set_env', 'app99')).toThrow(/ساعت/);
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
