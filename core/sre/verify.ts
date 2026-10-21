// Success criteria are fixed BEFORE a fix is applied, then the site is measured
// again and compared, so "fixed" is a number, not the agent's opinion.
import { probe, summarizeProbe, type ProbeSummary } from '../deployer.js';
import type { HypothesisId } from './detectors.js';

export interface Criteria {
  minOkRatio: number;
  maxP95Ms: number;
}

export interface VerifyRow {
  metric: string;
  before: string;
  after: string;
  target: string;
  ok: boolean;
}

export interface VerifyResult {
  passed: boolean;
  criteria: Criteria;
  before?: ProbeSummary;
  after: ProbeSummary;
  rows: VerifyRow[];
}

const fa = (n: number) => n.toLocaleString('fa-IR');
const pct = (r: number) => `${fa(Math.round(r * 100))}٪`;

export function criteriaFor(root?: HypothesisId, before?: ProbeSummary): Criteria {
  if (root === 'slow' || root === 'cpu') {
    const halved = before ? Math.round(before.p95 / 2) : 1000;
    return { minOkRatio: 0.95, maxP95Ms: Math.min(1000, halved) };
  }
  return { minOkRatio: 0.95, maxP95Ms: 2000 };
}

export function evaluate(criteria: Criteria, before: ProbeSummary | undefined, after: ProbeSummary): VerifyResult {
  const rows: VerifyRow[] = [
    {
      metric: 'درخواست‌های موفق',
      before: before ? pct(before.okRatio) : '—',
      after: pct(after.okRatio),
      target: `حداقل ${pct(criteria.minOkRatio)}`,
      ok: after.okRatio >= criteria.minOkRatio,
    },
    {
      metric: 'زمان پاسخ (p95)',
      before: before ? `${fa(before.p95)}ms` : '—',
      after: `${fa(after.p95)}ms`,
      target: `کمتر از ${fa(criteria.maxP95Ms)}ms`,
      ok: after.p95 < criteria.maxP95Ms,
    },
  ];
  return { passed: rows.every((r) => r.ok), criteria, before, after, rows };
}

export function mergeProbes(rounds: ProbeSummary[]): ProbeSummary {
  return summarizeProbe(rounds.flatMap((r) => r.samples));
}

// Probes a few rounds apart so a single lucky request can't declare victory.
export async function verifyFix(
  url: string,
  criteria: Criteria,
  before?: ProbeSummary,
  opts: { rounds?: number; intervalMs?: number; perRound?: number } = {},
): Promise<VerifyResult> {
  const rounds: ProbeSummary[] = [];
  const total = opts.rounds ?? 3;
  for (let i = 0; i < total; i++) {
    rounds.push(await probe(url, opts.perRound ?? 5));
    if (i < total - 1) await new Promise((r) => setTimeout(r, opts.intervalMs ?? 10_000));
  }
  return evaluate(criteria, before, mergeProbes(rounds));
}
