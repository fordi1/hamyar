// Shapes Liara's raw logs, metrics and releases for the dashboard's app pages.
// Pure functions: a series Liara did not return becomes `unavailable` with a reason,
// never an empty or invented chart.
import { runAction, type ActionResult } from './actions.js';
import type { LiaraClient } from './liara-client.js';
import type { Policy } from './policy.js';
import { clusterLogs, isErrorLine } from './sre/cluster.js';
import { normalizeLogs, normalizeReleases, normalizeSeries } from './sre/collect.js';
import type { Point } from './sre/snapshot.js';

export const RANGES = { '1h': 3600, '24h': 86_400, '7d': 604_800 } as const;
export type Range = keyof typeof RANGES;

// Reversible app operations the app page may request directly (each still needs approval).
export const DIRECT_ACTIONS = ['restart_app', 'turn_on_app', 'turn_off_app', 'rollback'] as const;

export const validAppName = (name: string) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(name);

// ---------- direct app actions ----------

type Ctx = { client: LiaraClient; policy: Policy };
type DirectAction = (typeof DIRECT_ACTIONS)[number];

// A button on the app page: files an approval request (marked `direct` so the dashboard
// runs it once a human approves; nothing else waits for it).
export async function requestAppAction(ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<ActionResult> {
  if (!DIRECT_ACTIONS.includes(tool as DirectAction)) throw new Error(`«${tool}» از این صفحه قابل اجرا نیست.`);
  const app = String(args.app ?? '');
  if (!validAppName(app)) throw new Error('نام برنامه معتبر نیست.');
  const clean: Record<string, unknown> = { app, direct: true };
  if (tool === 'rollback') {
    if (typeof args.releaseID !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(args.releaseID)) throw new Error('نسخه‌ی مقصد برای بازگشت مشخص نیست.');
    clean.releaseID = args.releaseID;
  }
  return runAction(ctx, tool, clean, undefined, () => {}, 'dashboard');
}

// Called right after the human approved a direct request in the dashboard.
export async function runApprovedAppAction(ctx: Ctx, id: string): Promise<ActionResult> {
  const record = ctx.policy.approvals.get(id);
  if (!record || record.source !== 'dashboard' || !record.args.direct || !DIRECT_ACTIONS.includes(record.tool as DirectAction)) {
    throw new Error('این درخواست از صفحه‌ی برنامه ثبت نشده است.');
  }
  if (record.status !== 'approved') throw new Error('این درخواست تأیید نشده یا قبلاً اجرا شده است.');
  const result = await runAction(ctx, record.tool, record.args, { approvalId: id }, () => {}, 'dashboard');
  if (result.status === 'blocked') throw new Error(result.error);
  return result;
}

// ---------- logs ----------

export type LogLevel = 'error' | 'warn' | 'info';

const WARN_RE = /\b(warn|warning|deprecated|deprecationwarning)\b|\[warn\]/i;

export function logLevel(message: string, type?: string): LogLevel {
  if (isErrorLine(message, type)) return 'error';
  if (WARN_RE.test(message) || /Warning\b/.test(message)) return 'warn';
  return 'info';
}

export interface ShapedLogs {
  lines: { at: number; level: LogLevel; message: string }[];
  counts: Record<LogLevel, number>;
  topErrors: { template: string; count: number; lastAt: number; sample: string }[];
  truncated: boolean;
}

export function shapeLogs(raw: unknown, opts: { level?: LogLevel; q?: string; limit?: number }): ShapedLogs {
  const all = normalizeLogs(raw)
    .map((l) => ({ at: l.at, level: logLevel(l.message, l.type), message: l.message, type: l.type }))
    .sort((a, b) => b.at - a.at);
  const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0 };
  for (const l of all) counts[l.level]++;
  const q = opts.q?.trim().toLowerCase();
  const matching = all.filter((l) => (!opts.level || l.level === opts.level) && (!q || l.message.toLowerCase().includes(q)));
  const limit = opts.limit ?? 300;
  const topErrors = clusterLogs(all.filter((l) => l.level === 'error'))
    .slice(0, 3)
    .map((c) => ({ template: c.template, count: c.count, lastAt: c.lastAt, sample: c.samples[0] ?? '' }));
  return {
    lines: matching.slice(0, limit).map(({ at, level, message }) => ({ at, level, message })),
    counts,
    topErrors,
    truncated: matching.length > limit,
  };
}

// ---------- metrics ----------

// Bucket maxima keep spikes visible when a week of points is drawn in a small chart.
export function downsample(points: Point[], max = 240): Point[] {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / max);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size);
    out.push(bucket.reduce((a, b) => (b.v > a.v ? b : a)));
  }
  return out;
}

export interface MetricSeries {
  points?: Point[];
  last?: number;
  limit?: number;
  unavailable?: string;
}

const NO_DATA = 'لیارا برای این بازه داده‌ای برنگرداند.';

function series(raw: unknown, scale = 1, limit?: number): MetricSeries {
  const points = normalizeSeries(raw).map((p) => ({ t: p.t, v: p.v * scale }));
  if (!points.length) return { unavailable: NO_DATA };
  return { points: downsample(points), last: Math.round(points[points.length - 1].v * 100) / 100, ...(limit ? { limit } : {}) };
}

export function shapeMetrics(
  raw: { cpu: unknown; memory: unknown; rx: unknown; tx: unknown; summary: any },
  plan: { ramGB?: number; cpu?: number },
) {
  const MB = 1 / 1024 / 1024;
  return {
    cpu: series(raw.cpu, 1, plan.cpu),
    memory: series(raw.memory, MB, plan.ramGB ? plan.ramGB * 1024 : undefined),
    networkIn: series(raw.rx),
    networkOut: series(raw.tx),
    disks: (raw.summary?.disksUsage ?? [])
      .map((d: any) => ({ name: String(d.name ?? ''), usedRatio: Number(d.usage) / Number(d.size) }))
      .filter((d: { usedRatio: number }) => Number.isFinite(d.usedRatio)),
  };
}

// ---------- releases ----------

export function shapeReleases(raw: unknown) {
  const { current, list } = normalizeReleases(raw);
  return list.map((r) => ({
    id: r.id,
    state: r.state,
    createdAt: r.createdAt,
    failReason: r.failReason,
    current: r.id === current,
    // the same rule rollback enforces server-side: an existing, healthy, non-current release
    canRollback: r.state === 'READY' && r.id !== current,
  }));
}
