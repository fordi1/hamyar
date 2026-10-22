import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperationStore, resumeOperations } from './operations.js';
import type { VerifyDeps } from './deployer.js';

function store() {
  const path = join(mkdtempSync(join(tmpdir(), 'hamyar-ops-')), 'operations.json');
  return { s: new OperationStore({ path }), path };
}

describe('OperationStore', () => {
  it('records state changes and the release id, and keeps them across instances', () => {
    const { s, path } = store();
    const op = s.start({ tool: 'deploy', app: 'shop', approvalId: 'ABC123' });
    s.event(op.id, { phase: 'PREPARING' });
    s.event(op.id, { phase: 'BUILDING', message: 'r-77' });
    const reloaded = new OperationStore({ path }).get(op.id)!;
    expect(reloaded).toMatchObject({ state: 'BUILDING', releaseID: 'r-77', approvalId: 'ABC123', finished: false });
    expect(reloaded.events.map((e) => e.phase)).toEqual(['PREPARING', 'BUILDING']);
  });

  it('lists active operations and finishes them with an outcome', () => {
    const { s } = store();
    const a = s.start({ tool: 'deploy', app: 'shop' });
    const b = s.start({ tool: 'restart_app', app: 'shop' });
    s.finish(b.id, 'DONE', 'ری‌استارت شد');
    expect(s.active().map((o) => o.id)).toEqual([a.id]);
    expect(s.get(b.id)).toMatchObject({ state: 'DONE', finished: true, summary: 'ری‌استارت شد' });
  });
});

describe('resumeOperations after a restart', () => {
  const deps: VerifyDeps = { probe: async () => ({ samples: [{ status: 200, ms: 20 }], okRatio: 1, p50: 20, p95: 20, healthy: true }), sleep: async () => {}, rounds: 1 };

  it('resumes a deploy that already has a release id and verifies it', async () => {
    const { s } = store();
    const op = s.start({ tool: 'deploy', app: 'shop' });
    s.event(op.id, { phase: 'BUILDING', message: 'r-9' });
    const client = {
      buildLogs: async () => ({ release: { state: 'READY' }, buildOutput: [] }),
      releases: async () => ({ currentRelease: 'r-9' }),
    } as any;
    await resumeOperations(s, client, deps);
    expect(s.get(op.id)).toMatchObject({ state: 'VERIFIED_HEALTHY', finished: true });
  });

  it('marks operations that cannot be resumed as interrupted, with an explanation', async () => {
    const { s } = store();
    const op = s.start({ tool: 'deploy', app: 'shop' });
    s.event(op.id, { phase: 'UPLOADING' });
    await resumeOperations(s, {} as any, deps);
    expect(s.get(op.id)).toMatchObject({ state: 'INTERRUPTED', finished: true });
    expect(s.get(op.id)?.summary).toMatch(/قطع شد/);
  });
});
