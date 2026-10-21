// Ships a local folder to an existing Liara app: pack → upload → release →
// follow the build → probe the live URL. Approval and app creation happen in the
// caller (policy layer); this module only does the mechanics and reports progress.
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LiaraClient } from './liara-client.js';
import { packProject } from './pack.js';

export type DeployPhase = 'packing' | 'uploading' | 'queued' | 'building' | 'deploying' | 'ready' | 'failed' | 'probing' | 'done';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        onEvent({ phase: 'failed', line: out.line });
        return { state: 'FAILED', failReason: out.line, lastLines };
      }
      onEvent({ phase: 'building', line: out.line });
    }
    if (buildOutput.length) since = buildOutput[buildOutput.length - 1].createdAt;

    switch (release?.state) {
      case 'READY':
        onEvent({ phase: 'ready' });
        return { state: 'READY', lastLines };
      case 'FAILED':
      case 'CANCELED':
      case 'TIMEDOUT':
      case 'UNHEALTHY':
        onEvent({ phase: 'failed', message: release.failReason ?? release.state });
        return { state: release.state, failReason: release.failReason, lastLines };
      case 'DEPLOYING':
        if (!announcedDeploying) {
          announcedDeploying = true;
          onEvent({ phase: 'deploying' });
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
  healthCheck?: unknown;
}

export interface DeployResult {
  releaseID: string;
  release: ReleaseResult;
  url: string;
  probe?: ProbeSummary;
}

export async function deploySource(client: LiaraClient, input: DeployInput, onEvent: (e: DeployEvent) => void = () => {}): Promise<DeployResult> {
  onEvent({ phase: 'packing' });
  const pack = await packProject(input.dir, input.platform);
  onEvent({ phase: 'uploading', message: `${pack.fileCount} files, ${Math.ceil(pack.sizeBytes / 1024)} KB` });

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
    ...(input.healthCheck ? { healthCheck: input.healthCheck } : {}),
  });
  onEvent({ phase: 'queued', message: releaseID });

  const release = await waitForRelease(client, releaseID, onEvent);
  const url = appUrl(input.app);
  if (release.state !== 'READY') return { releaseID, release, url };

  onEvent({ phase: 'probing', message: url });
  const result = await probe(url);
  onEvent({ phase: 'done' });
  return { releaseID, release, url, probe: result };
}
