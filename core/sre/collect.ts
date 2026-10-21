// Gathers one Snapshot of an app from the Liara API, in parallel, read-only.
// Every endpoint is optional: a failure becomes a "gap" the user is told about,
// never a crash of the investigation.
import type { LiaraClient } from '../liara-client.js';
import { probe } from '../deployer.js';
import { appUrl } from '../deployer.js';
import { scanEnv } from '../env-scan.js';
import { toPlanList } from '../plan-advisor.js';
import type { Point, ReleaseInfo, Snapshot } from './snapshot.js';

// Seconds, milliseconds, nanoseconds (Loki-style event timestamps) or ISO strings → ms.
export function toMs(value: unknown): number {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) return Date.parse(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  if (n > 1e17) return Math.round(n / 1e6);
  if (n > 1e14) return Math.round(n / 1e3);
  if (n > 1e11) return Math.round(n);
  return Math.round(n * 1000);
}

export function normalizeLogs(raw: any): Snapshot['logs'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => ({ at: toMs(l.datetime), message: String(l.message ?? '').replace(/\s+$/, ''), type: l.type }))
    .filter((l) => l.message);
}

export function normalizeSeries(raw: any): Point[] {
  const result = raw?.result;
  if (!Array.isArray(result)) return [];
  const byTime = new Map<number, number>();
  for (const series of result) {
    for (const pair of series?.values ?? []) {
      const t = toMs(pair[0]);
      const v = Number(pair[1]);
      if (Number.isFinite(t) && Number.isFinite(v)) byTime.set(t, Math.max(byTime.get(t) ?? -Infinity, v));
    }
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

export function normalizeReleases(raw: any): { current?: string; list: ReleaseInfo[] } {
  const list: ReleaseInfo[] = (raw?.releases ?? []).map((r: any) => ({
    id: r._id,
    state: r.state,
    createdAt: toMs(r.createdAt),
    port: r.port,
    failReason: r.failReason,
  }));
  list.sort((a, b) => b.createdAt - a.createdAt);
  return { current: raw?.currentRelease, list };
}

export function normalizeEvents(raw: any): Snapshot['events'] {
  const out: Snapshot['events'] = [];
  for (const group of raw?.data ?? []) {
    for (const row of group?.values ?? []) {
      if (Array.isArray(row)) out.push({ at: toMs(row[0]), text: row.slice(1).join(' ') });
      else out.push({ text: JSON.stringify(row) });
    }
  }
  return out;
}

export interface CollectOptions {
  windowMinutes?: number;
  // local project folder, to compare the env vars the code reads with Liara's
  projectDir?: string;
  probePath?: string;
  probeCount?: number;
}

export async function collectSnapshot(client: LiaraClient, app: string, opts: CollectOptions = {}): Promise<Snapshot> {
  const now = Date.now();
  const windowStart = now - (opts.windowMinutes ?? 30) * 60_000;
  const since = Math.floor(windowStart / 1000);
  const gaps: string[] = [];

  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err: any) {
      gaps.push(`${label}: ${err?.explanation ?? err?.message ?? err}`);
      return undefined;
    }
  };

  const url = appUrl(app) + (opts.probePath ?? '/');
  const [info, plans, releases, logs, events, applets, memory, cpu, summary, probed] = await Promise.all([
    safe('app details', () => client.getApp(app)),
    safe('plans', () => client.appPlans()),
    safe('releases', () => client.releases(app, 5)),
    safe('logs', () => client.logs(app, since)),
    safe('events', () => client.events(app, since, Math.floor(now / 1000))),
    safe('applets', () => client.applets(app)),
    safe('memory metrics', () => client.metrics(app, 'memory', since)),
    safe('cpu metrics', () => client.metrics(app, 'cpu', since)),
    safe('metrics summary', () => client.metricsSummary(app)),
    safe('HTTP probe', () => probe(url, opts.probeCount ?? 5)),
  ]);

  const plan = info?.planID && plans ? toPlanList({ [info.planID]: { ...plans[info.planID], available: true } })[0] : undefined;
  const rel = normalizeReleases(releases);

  const snapshot: Snapshot = {
    app,
    collectedAt: now,
    windowStart,
    appInfo: {
      status: info?.status,
      scale: info?.scale,
      planID: info?.planID,
      planRamGB: plan?.ramGB,
      planCpu: plan?.cpu,
      envNames: (info?.envs ?? []).map((e: any) => e.key),
      platform: info?.type,
    },
    releases: rel.list,
    currentReleaseId: rel.current ?? rel.list[0]?.id,
    logs: normalizeLogs(logs),
    events: normalizeEvents(events),
    applets: (applets?.applets ?? []).map((a: any) => ({ state: a.state, reason: a.reason, at: toMs(a.timestamp) })),
    memoryBytes: normalizeSeries(memory),
    cpuCores: normalizeSeries(cpu),
    disks: (summary?.disksUsage ?? []).map((d: any) => ({ name: d.name, usedRatio: Number(d.usage) / Number(d.size) || 0 })),
    probe: probed ? { ...probed, url } : undefined,
    codeEnv: opts.projectDir ? scanEnv(opts.projectDir, (info?.envs ?? []).map((e: any) => e.key)) : undefined,
    availablePlans: plans ? toPlanList(plans) : undefined,
    gaps,
  };

  // The last failed build's output, for registry / build-location problems.
  const failed = rel.list.find((r) => r.state === 'FAILED');
  if (failed && failed.createdAt >= windowStart) {
    const build = await safe('build logs', () => client.buildLogs(failed.id));
    snapshot.buildLines = build?.buildOutput?.map((o) => o.line) ?? [];
  }
  return snapshot;
}
