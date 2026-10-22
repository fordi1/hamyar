import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore, ApprovalError } from './approvals.js';

function store(start = 1_000_000) {
  let now = start;
  const path = join(mkdtempSync(join(tmpdir(), 'hamyar-approvals-')), 'approvals.json');
  const s = new ApprovalStore({ path, now: () => now });
  return { s, path, advance: (ms: number) => (now += ms) };
}

const preview = { title: 'ری‌استارت shop', lines: [], risk: 'کم', downtime: 'چند ثانیه', undo: '—' };
const request = (s: ApprovalStore, args: Record<string, unknown> = { app: 'shop' }) =>
  s.request({ tool: 'restart_app', tier: 'T1', args, preview, source: 'mcp' });

describe('ApprovalStore', () => {
  it('creates a pending request with a short human-typeable id', () => {
    const { s } = store();
    const r = request(s);
    expect(r.status).toBe('pending');
    expect(r.id).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(s.list({ status: 'pending' }).map((x) => x.id)).toEqual([r.id]);
  });

  it('cannot be consumed while pending: knowing the id is not approval', () => {
    const { s } = store();
    const r = request(s);
    expect(() => s.consume(r.id, 'restart_app', { app: 'shop' })).toThrow(/هنوز تأیید نشده/);
  });

  it('executes once after a human decision, then refuses replay', () => {
    const { s } = store();
    const r = request(s);
    s.decide(r.id, { approved: true, by: 'user', channel: 'dashboard' });
    expect(() => s.consume(r.id, 'restart_app', { app: 'shop' })).not.toThrow();
    expect(s.get(r.id)?.status).toBe('used');
    expect(() => s.consume(r.id, 'restart_app', { app: 'shop' })).toThrow(/استفاده شده/);
  });

  it('binds the approval to the exact tool and arguments, including nested values', () => {
    const { s } = store();
    const r = s.request({ tool: 'set_env', tier: 'T2', args: { app: 'shop', variables: [{ key: 'A', value: '1' }] }, preview, source: 'dashboard' });
    s.decide(r.id, { approved: true, by: 'user', channel: 'dashboard' });
    expect(() => s.consume(r.id, 'set_env', { app: 'shop', variables: [{ key: 'A', value: '2' }] })).toThrow(/آرگومان/);
    expect(() => s.consume(r.id, 'restart_app', { app: 'shop', variables: [{ key: 'A', value: '1' }] })).toThrow();
    expect(() => s.consume(r.id, 'set_env', { variables: [{ value: '1', key: 'A' }], app: 'shop' })).not.toThrow();
  });

  it('records a rejection with its reason and never executes it', () => {
    const { s } = store();
    const r = request(s);
    s.decide(r.id, { approved: false, by: 'user', channel: 'terminal', reason: 'الان نه' });
    expect(s.get(r.id)).toMatchObject({ status: 'rejected', reason: 'الان نه', channel: 'terminal' });
    expect(() => s.consume(r.id, 'restart_app', { app: 'shop' })).toThrow(/رد/);
  });

  it('expires after the TTL, also for approved-but-unused requests', () => {
    const { s, advance } = store();
    const a = request(s);
    const b = request(s, { app: 'other' });
    s.decide(b.id, { approved: true, by: 'user', channel: 'dashboard' });
    advance(10 * 60_000 + 1);
    expect(s.get(a.id)?.status).toBe('expired');
    expect(() => s.consume(b.id, 'restart_app', { app: 'other' })).toThrow(/منقضی/);
  });

  it('cannot decide twice', () => {
    const { s } = store();
    const r = request(s);
    s.decide(r.id, { approved: false, by: 'user', channel: 'dashboard' });
    expect(() => s.decide(r.id, { approved: true, by: 'user', channel: 'dashboard' })).toThrow(ApprovalError);
  });

  it('revokes every pending request (kill switch)', () => {
    const { s } = store();
    const a = request(s);
    const b = request(s, { app: 'b' });
    s.decide(b.id, { approved: true, by: 'user', channel: 'dashboard' });
    expect(s.revokeAll('توقف')).toBe(2);
    expect(s.get(a.id)?.status).toBe('revoked');
    expect(() => s.consume(b.id, 'restart_app', { app: 'b' })).toThrow(/لغو/);
  });

  it('is shared through the file: another process instance sees and decides it', () => {
    const { s, path } = store();
    const r = request(s);
    const other = new ApprovalStore({ path, now: () => 1_000_000 });
    other.decide(r.id, { approved: true, by: 'user', channel: 'terminal' });
    expect(() => s.consume(r.id, 'restart_app', { app: 'shop' })).not.toThrow();
  });

  it('never writes secret argument values to disk', () => {
    const { s, path } = store();
    s.request({ tool: 'set_env', tier: 'T2', args: { app: 'shop', variables: [{ key: 'DATABASE_URL', value: 'postgres://u:hunter2@h/db' }] }, preview, source: 'dashboard' });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('DATABASE_URL');
  });
});
