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
    expect(events.map((e) => e.phase)).toEqual(['BUILDING', 'BUILDING', 'DEPLOYING']);
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

// ---------- deploySource state machine ----------
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploySource, verifyDeployment, type VerifyDeps } from './deployer.js';

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-deploy-'));
  writeFileSync(join(dir, 'server.js'), 'require("http").createServer().listen(3000)');
  return dir;
}

function liara(releaseState: string, currentRelease = 'r-new') {
  const created: any[] = [];
  return {
    created,
    client: {
      uploadSource: async () => 'src1',
      createRelease: async (_app: string, body: any) => { created.push(body); return 'r-new'; },
      buildLogs: async () => ({ release: { state: releaseState, failReason: releaseState === 'FAILED' ? 'npm ERR' : undefined }, buildOutput: [] }),
      releases: async () => ({ currentRelease }),
    } as any,
  };
}

const probes = (status: number, ms = 40): VerifyDeps => ({
  probe: async () => summarizeProbe([{ status, ms }, { status, ms }, { status, ms }]),
  sleep: async () => {},
  rounds: 3,
});

const input = (dir: string) => ({ app: 'shop', dir, platform: 'node', port: 3000, healthPath: '/health', healthCheck: { command: 'CMD curl --fail http://localhost:3000/health || exit 1', interval: 30, timeout: 15, retries: 2, startPeriod: 5 } });

describe('deploySource', () => {
  it('reports VERIFIED_HEALTHY only after verification passes and Liara serves the new release', async () => {
    const { client } = liara('READY');
    const events: DeployEvent[] = [];
    const r = await deploySource(client, input(projectDir()), (e) => events.push(e), probes(200));
    expect(r.state).toBe('VERIFIED_HEALTHY');
    expect(r.verification).toMatchObject({ okRatio: 1, rounds: 3, url: 'https://shop.liara.run/health' });
    expect(events.map((e) => e.phase)).toEqual(['PREPARING', 'UPLOADING', 'BUILDING', 'VERIFYING', 'VERIFIED_HEALTHY']);
  });

  it('a READY release whose site fails our probes is HEALTH_FAILED, not success', async () => {
    const { client } = liara('READY');
    const r = await deploySource(client, input(projectDir()), () => {}, probes(500));
    expect(r.state).toBe('HEALTH_FAILED');
    expect(r.verification?.reason).toMatch(/موفق/);
  });

  it('a READY release that Liara does not serve yet is HEALTH_FAILED', async () => {
    const { client } = liara('READY', 'r-old');
    const r = await deploySource(client, input(projectDir()), () => {}, probes(200));
    expect(r.state).toBe('HEALTH_FAILED');
    expect(r.verification?.reason).toContain('r-old');
  });

  it('maps Liara UNHEALTHY to HEALTH_FAILED and FAILED to FAILED without probing', async () => {
    let probed = 0;
    const deps: VerifyDeps = { ...probes(200), probe: async () => { probed++; return summarizeProbe([]); } };
    expect((await deploySource(liara('UNHEALTHY').client, input(projectDir()), () => {}, deps)).state).toBe('HEALTH_FAILED');
    expect((await deploySource(liara('FAILED').client, input(projectDir()), () => {}, deps)).state).toBe('FAILED');
    expect((await deploySource(liara('CANCELED').client, input(projectDir()), () => {}, deps)).state).toBe('CANCELED');
    expect(probed).toBe(0);
  });

  it('sends the health check with the command split on spaces, like the Liara CLI', async () => {
    const { client, created } = liara('READY');
    await deploySource(client, input(projectDir()), () => {}, probes(200));
    expect(created[0].healthCheck.command).toEqual(['CMD', 'curl', '--fail', 'http://localhost:3000/health', '||', 'exit', '1']);
    expect(created[0].healthCheck).toMatchObject({ interval: 30, timeout: 15, retries: 2, startPeriod: 5 });
  });
});

describe('verifyDeployment warm-up', () => {
  // Real case 2026-10-22: Liara marked the release ready at 10:35:03, the app logged its first line at
  // 10:35:21, and three rounds 10 s apart all missed it.
  const ok = summarizeProbe([{ status: 200, ms: 10 }]);
  const down = summarizeProbe([{ status: 0, ms: 3000 }]);

  it('waits for the first answer of a cold-starting app before the measured rounds', async () => {
    let calls = 0;
    const deps: VerifyDeps = { probe: async () => (++calls <= 3 ? down : ok), sleep: async () => {}, rounds: 3, warmupMs: 60_000, warmupIntervalMs: 5_000 };
    const r = await verifyDeployment({ releases: async () => ({ currentRelease: 'r1' }) } as any, 'shop', 'r1', '/health', deps);
    expect(r.healthy).toBe(true);
    expect(r.verification.okRatio).toBe(1);
    expect(r.verification.warmupMs).toBe(15_000);
  });

  it('fails with a clear reason when the app never answers within the warm-up', async () => {
    const deps: VerifyDeps = { probe: async () => down, sleep: async () => {}, rounds: 3, warmupMs: 20_000, warmupIntervalMs: 5_000 };
    const r = await verifyDeployment({ releases: async () => ({ currentRelease: 'r1' }) } as any, 'shop', 'r1', '/health', deps);
    expect(r.healthy).toBe(false);
    expect(r.verification.reason).toMatch(/۲۰ ثانیه/);
  });
});

describe('verifyDeployment', () => {
  it('probes the given path in several rounds', async () => {
    const urls: string[] = [];
    const deps: VerifyDeps = { probe: async (u) => { urls.push(u); return summarizeProbe([{ status: 200, ms: 10 }]); }, sleep: async () => {}, rounds: 3 };
    const { healthy } = await verifyDeployment({ releases: async () => ({ currentRelease: 'r1' }) } as any, 'shop', 'r1', '/health', deps);
    expect(healthy).toBe(true);
    expect(urls).toEqual(Array(3).fill('https://shop.liara.run/health'));
  });
});
