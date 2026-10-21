import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envDiff, runAction, readEnvFile } from './actions.js';
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
  return new Policy({ mode, auditPath: join(mkdtempSync(join(tmpdir(), 'hamyar-a-')), 'audit.jsonl') });
}

describe('runAction', () => {
  it('returns a preview and a token first, and executes only with the token', async () => {
    const { client, calls } = fakeClient();
    const p = policy();
    const first = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' });
    expect(first.status).toBe('needs_approval');
    expect(calls).toEqual([]);
    if (first.status !== 'needs_approval') return;
    expect(first.preview.title).toContain('shop');

    const second = await runAction({ client, policy: p }, 'restart_app', { app: 'shop' }, { token: first.token, approvedBy: 'user' });
    expect(second.status).toBe('done');
    expect(calls).toEqual(['restart:shop']);
    expect(p.recent().map((e) => e.outcome)).toEqual(['previewed', 'executed']);
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
    await runAction({ client, policy: p }, 'set_env', args, { token: first.token });
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
