// Ships a local folder to an existing Liara app and reports an explicit state:
// PREPARING → UPLOADING → BUILDING → DEPLOYING → VERIFYING → VERIFIED_HEALTHY | HEALTH_FAILED,
// or FAILED / CANCELED. A release that Liara marks READY is not "healthy" until
// our own checks pass. ANALYZING and AWAITING_APPROVAL happen in the caller.
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LiaraClient } from './liara-client.js';
import { packProject } from './pack.js';

export type DeployPhase =
  | 'ANALYZING' | 'AWAITING_APPROVAL' | 'PREPARING' | 'UPLOADING' | 'BUILDING' | 'DEPLOYING'
  | 'VERIFYING' | 'VERIFIED_HEALTHY' | 'HEALTH_FAILED' | 'FAILED' | 'CANCELED';

export interface DeployEvent {
  phase: DeployPhase;
  message?: string;
  line?: string;
}

export type ReleaseState = 'READY' | 'FAILED' | 'UNHEALTHY' | 'CANCELED' | 'TIMEDOUT';

export interface ReleaseResult {
  state: ReleaseState;
  failReason?: string;
  lastLines: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Mirrors Liara CLI src/services/build-logs.ts: any STDERR line means the build failed.
export async function waitForRelease(
  client: Pick<LiaraClient, 'buildLogs'>,
  releaseID: string,
  onEvent: (e: DeployEvent) => void,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<ReleaseResult> {
  const interval = opts.intervalMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  const lastLines: string[] = [];
  let since: string | undefined;
  let announcedDeploying = false;

  while (Date.now() < deadline) {
    let response;
    try {
      response = await client.buildLogs(releaseID, since);
    } catch {
      await sleep(interval);
      continue;
    }
    const { release, buildOutput } = response;

    for (const out of buildOutput) {
      lastLines.push(out.line);
      if (lastLines.length > 50) lastLines.shift();
      if (out.stream !== 'STDOUT') {
        onEvent({ phase: 'FAILED', line: out.line });
        return { state: 'FAILED', failReason: out.line, lastLines };
      }
      onEvent({ phase: 'BUILDING', line: out.line });
    }
    if (buildOutput.length) since = buildOutput[buildOutput.length - 1].createdAt;

    switch (release?.state) {
      case 'READY':
        return { state: 'READY', lastLines };
      case 'FAILED':
      case 'CANCELED':
      case 'TIMEDOUT':
      case 'UNHEALTHY':
        onEvent({ phase: release.state === 'CANCELED' ? 'CANCELED' : 'FAILED', message: release.failReason ?? release.state });
        return { state: release.state, failReason: release.failReason, lastLines };
      case 'DEPLOYING':
        if (!announcedDeploying) {
          announcedDeploying = true;
          onEvent({ phase: 'DEPLOYING' });
        }
        break;
    }
    await sleep(interval);
  }
  return { state: 'TIMEDOUT', failReason: 'build did not finish in time', lastLines };
}

export interface ProbeSample {
  status: number;
  ms: number;
  error?: string;
}

export interface ProbeSummary {
  samples: ProbeSample[];
  okRatio: number;
  p50: number;
  p95: number;
  healthy: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export function summarizeProbe(samples: ProbeSample[]): ProbeSummary {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 400).length;
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const okRatio = samples.length ? ok / samples.length : 0;
  const p50 = percentile(times, 0.5);
  const p95 = percentile(times, 0.95);
  // healthy = at most one failure in five and p95 under 2 s
  return { samples, okRatio, p50, p95, healthy: okRatio >= 0.8 && p95 < 2000 };
}

export async function probe(url: string, count = 5, timeoutMs = 10_000): Promise<ProbeSummary> {
  const samples: ProbeSample[] = [];
  for (let i = 0; i < count; i++) {
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      await res.arrayBuffer();
      samples.push({ status: res.status, ms: Date.now() - started });
    } catch (err: any) {
      samples.push({ status: 0, ms: Date.now() - started, error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err) });
    }
  }
  return summarizeProbe(samples);
}

export const appUrl = (app: string) => `https://${app}.liara.run`;

export interface DeployInput {
  app: string;
  dir: string;
  platform: string;
  port: number;
  message?: string;
  // liara.json-style healthCheck; the command string is split on spaces like the CLI does
  healthCheck?: { command: string; interval: number; timeout: number; retries: number; startPeriod: number };
  // path our own verification probes, e.g. /health
  healthPath?: string;
}

export type FinalState = 'VERIFIED_HEALTHY' | 'HEALTH_FAILED' | 'FAILED' | 'CANCELED';

export interface Verification {
  url: string;
  rounds: number;
  okRatio: number;
  p95: number;
  // the release Liara serves after the deploy; if it is not ours, the old one is still live
  currentRelease?: string;
  // how long the app took to answer for the first time after the release went live
  warmupMs?: number;
  reason?: string;
}

export interface DeployResult {
  state: FinalState;
  releaseID: string;
  release: ReleaseResult;
  url: string;
  verification?: Verification;
}

export interface VerifyDeps {
  probe: (url: string, count?: number) => Promise<ProbeSummary>;
  sleep: (ms: number) => Promise<void>;
  rounds?: number;
  intervalMs?: number;
  // a release can be marked ready before the app listens (cold start, no zero-downtime deploys)
  warmupMs?: number;
  warmupIntervalMs?: number;
}

const defaultDeps: VerifyDeps = { probe: (u, c) => probe(u, c), sleep, rounds: 3, intervalMs: 10_000, warmupMs: 90_000, warmupIntervalMs: 5_000 };

// Several probe rounds a few seconds apart, plus a check that Liara now serves this release.
export async function verifyDeployment(
  client: Pick<LiaraClient, 'releases'>,
  app: string,
  releaseID: string,
  path = '/',
  deps: VerifyDeps = defaultDeps,
): Promise<{ healthy: boolean; verification: Verification }> {
  const url = appUrl(app) + path;
  const rounds = deps.rounds ?? 3;
  // wait for the first answer before measuring; a cold start must not count as unhealthy
  const warmupMs = deps.warmupMs ?? 0;
  const step = deps.warmupIntervalMs ?? 5_000;
  let waited = 0;
  while (warmupMs > 0) {
    if ((await deps.probe(url, 1)).okRatio > 0) break;
    if (waited >= warmupMs) {
      const verification: Verification = { url, rounds: 0, okRatio: 0, p95: 0, warmupMs: waited };
      verification.reason = `برنامه تا ${Math.round(waited / 1000).toLocaleString('fa-IR')} ثانیه بعد از انتشار به ${path} پاسخ نداد.`;
      return { healthy: false, verification };
    }
    await deps.sleep(step);
    waited += step;
  }
  const samples: ProbeSample[] = [];
  for (let i = 0; i < rounds; i++) {
    if (i) await deps.sleep(deps.intervalMs ?? 10_000);
    samples.push(...(await deps.probe(url, 3)).samples);
  }
  const summary = summarizeProbe(samples);
  const currentRelease = (await client.releases(app, 1).catch(() => undefined))?.currentRelease as string | undefined;
  const verification: Verification = { url, rounds, okRatio: summary.okRatio, p95: summary.p95, currentRelease, ...(warmupMs ? { warmupMs: waited } : {}) };
  if (currentRelease && currentRelease !== releaseID) {
    verification.reason = `لیارا هنوز نسخه‌ی قبلی (${currentRelease}) را سرو می‌کند؛ نسخه‌ی جدید جایگزین نشده است.`;
    return { healthy: false, verification };
  }
  if (!summary.healthy) {
    verification.reason = `فقط ${Math.round(summary.okRatio * 100)}٪ درخواست‌ها موفق بودند (p95=${summary.p95}ms).`;
    return { healthy: false, verification };
  }
  return { healthy: true, verification };
}

export async function deploySource(
  client: LiaraClient,
  input: DeployInput,
  onEvent: (e: DeployEvent) => void = () => {},
  deps: VerifyDeps = defaultDeps,
): Promise<DeployResult> {
  onEvent({ phase: 'PREPARING' });
  const pack = await packProject(input.dir, input.platform);
  onEvent({ phase: 'UPLOADING', message: `${pack.fileCount} files, ${Math.ceil(pack.sizeBytes / 1024)} KB` });

  let sourceID: string;
  try {
    sourceID = await client.uploadSource(input.app, pack.path);
  } finally {
    rmSync(dirname(pack.path), { recursive: true, force: true });
  }

  const releaseID = await client.createRelease(input.app, {
    sourceID,
    port: input.port,
    type: input.platform,
    message: input.message ?? 'Deployed by Hamyar',
    ...(input.healthCheck ? { healthCheck: { ...input.healthCheck, command: input.healthCheck.command.split(' ') } } : {}),
  });
  onEvent({ phase: 'BUILDING', message: releaseID });

  const release = await waitForRelease(client, releaseID, onEvent);
  const url = appUrl(input.app);
  if (release.state === 'CANCELED') return { state: 'CANCELED', releaseID, release, url };
  // Liara's own health check failed: traffic stays on the previous release
  if (release.state === 'UNHEALTHY') {
    onEvent({ phase: 'HEALTH_FAILED', message: release.failReason });
    return { state: 'HEALTH_FAILED', releaseID, release, url };
  }
  if (release.state !== 'READY') return { state: 'FAILED', releaseID, release, url };

  onEvent({ phase: 'VERIFYING', message: url });
  const { healthy, verification } = await verifyDeployment(client, input.app, releaseID, input.healthPath ?? '/', deps);
  const state: FinalState = healthy ? 'VERIFIED_HEALTHY' : 'HEALTH_FAILED';
  onEvent({ phase: state, message: verification.reason });
  return { state, releaseID, release, url, verification };
}
