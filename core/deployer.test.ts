import { describe, expect, it } from 'vitest';
import { waitForRelease, summarizeProbe, type DeployEvent } from './deployer.js';

// Fake client that replays build-log responses in order.
function fakeClient(responses: { release: any; buildOutput: any[] }[]) {
  let i = 0;
  return {
    buildLogs: async () => responses[Math.min(i++, responses.length - 1)],
  } as any;
}

const line = (text: string, stream = 'STDOUT') => ({ line: text, stream, createdAt: String(Date.now()) });

describe('waitForRelease', () => {
  it('follows BUILDING → DEPLOYING → READY and reports phases', async () => {
    const events: DeployEvent[] = [];
    const client = fakeClient([
      { release: { state: 'BUILDING' }, buildOutput: [line('npm install'), line('added 60 packages')] },
      { release: { state: 'DEPLOYING' }, buildOutput: [] },
      { release: { state: 'READY' }, buildOutput: [] },
    ]);
    const result = await waitForRelease(client, 'r1', (e) => events.push(e), { intervalMs: 1 });
    expect(result.state).toBe('READY');
    expect(events.map((e) => e.phase)).toEqual(['building', 'building', 'deploying', 'ready']);
    expect(result.lastLines).toContain('added 60 packages');
  });

  it('stops on a build error line and keeps the error', async () => {
    const client = fakeClient([
      { release: { state: 'BUILDING' }, buildOutput: [line('npm ERR! 403 Forbidden registry.npmjs.org', 'STDERR')] },
    ]);
    const result = await waitForRelease(client, 'r1', () => {}, { intervalMs: 1 });
    expect(result.state).toBe('FAILED');
    expect(result.failReason).toContain('403');
  });

  it('reports UNHEALTHY releases', async () => {
    const client = fakeClient([{ release: { state: 'UNHEALTHY' }, buildOutput: [] }]);
    expect((await waitForRelease(client, 'r1', () => {}, { intervalMs: 1 })).state).toBe('UNHEALTHY');
  });

  it('times out', async () => {
    const client = fakeClient([{ release: { state: 'BUILDING' }, buildOutput: [] }]);
    const result = await waitForRelease(client, 'r1', () => {}, { intervalMs: 1, timeoutMs: 20 });
    expect(result.state).toBe('TIMEDOUT');
  });
});

describe('summarizeProbe', () => {
  it('computes success and latency percentiles', () => {
    const s = summarizeProbe([
      { status: 200, ms: 100 }, { status: 200, ms: 120 }, { status: 200, ms: 140 },
      { status: 500, ms: 90 }, { status: 200, ms: 900 },
    ]);
    expect(s.okRatio).toBe(0.8);
    expect(s.p50).toBe(120);
    expect(s.p95).toBe(900);
    // one failure in five is still healthy
    expect(s.healthy).toBe(true);
  });

  it('is unhealthy with two failures or a slow p95', () => {
    expect(summarizeProbe([{ status: 500, ms: 10 }, { status: 500, ms: 10 }, { status: 200, ms: 10 }, { status: 200, ms: 10 }, { status: 200, ms: 10 }]).healthy).toBe(false);
    expect(summarizeProbe([{ status: 200, ms: 3000 }, { status: 200, ms: 3000 }]).healthy).toBe(false);
  });

  it('counts network errors as failures', () => {
    const s = summarizeProbe([{ status: 0, ms: 5000, error: 'timeout' }, { status: 200, ms: 50 }]);
    expect(s.okRatio).toBe(0.5);
  });
});
