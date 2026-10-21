// Turns detector output into the hypothesis board the user sees:
// one root cause, contributing causes, symptoms, rejected hypotheses, numbered
// evidence and an ordered fix list. The LLM only explains this board; it never
// decides the root cause itself.
import type { Snapshot } from './snapshot.js';
import type { CodeHint, Evidence, FixOption, Hypothesis, HypothesisId } from './detectors.js';
import type { Redactor } from '../redact.js';
import { clusterLogs } from './cluster.js';

export interface Board {
  app: string;
  createdAt: number;
  verdict: 'problem' | 'healthy' | 'unclear';
  root?: Hypothesis;
  contributing: Hypothesis[];
  symptoms: Hypothesis[];
  inconclusive: Hypothesis[];
  rejected: Hypothesis[];
  fixes: (FixOption & { from: HypothesisId })[];
  codeHint?: CodeHint;
  evidence: Evidence[];
  gaps: string[];
  snapshot: Snapshot;
}

// Two causes this close in confidence are ordered by which one started first.
const CLOSE = 0.15;

function orderCauses(causes: Hypothesis[]): Hypothesis[] {
  return [...causes].sort((a, b) => {
    if (Math.abs(a.confidence - b.confidence) <= CLOSE && a.startedAt !== undefined && b.startedAt !== undefined && a.startedAt !== b.startedAt) {
      return a.startedAt - b.startedAt;
    }
    return b.confidence - a.confidence;
  });
}

export function buildBoard(snapshot: Snapshot, hypotheses: Hypothesis[]): Board {
  const byConfidence = [...hypotheses].sort((a, b) => b.confidence - a.confidence);
  const validated = byConfidence.filter((h) => h.status === 'validated');
  const causes = orderCauses(validated.filter((h) => h.category === 'cause'));
  const symptoms = validated.filter((h) => h.category === 'symptom');
  const root = causes[0];
  const inconclusive = byConfidence.filter((h) => h.status === 'inconclusive');
  const rejected = byConfidence.filter((h) => h.status === 'invalidated');

  // Number evidence in display order, so the root cause's evidence is E1.
  const evidence: Evidence[] = [];
  for (const h of [...causes, ...symptoms, ...inconclusive, ...rejected]) {
    for (const e of [...h.supporting, ...h.contradicting]) {
      e.id = `E${evidence.length + 1}`;
      evidence.push(e);
    }
  }

  let verdict: Board['verdict'] = 'healthy';
  if (root || symptoms.length) verdict = 'problem';
  else if (inconclusive.length || (snapshot.probe && !snapshot.probe.healthy)) verdict = 'unclear';

  const fixSources = [root, ...causes.slice(1), ...symptoms].filter((h): h is Hypothesis => Boolean(h));
  const seen = new Set<string>();
  const fixes: Board['fixes'] = [];
  for (const h of fixSources) {
    for (const f of h.fixes) {
      const key = f.action + JSON.stringify(f.args ?? {});
      if (!seen.has(key)) {
        seen.add(key);
        fixes.push({ ...f, from: h.id });
      }
    }
  }

  const codeHint = root?.codeHint ?? symptoms.find((h) => h.codeHint)?.codeHint;

  return {
    app: snapshot.app,
    createdAt: snapshot.collectedAt,
    verdict,
    root,
    contributing: causes.slice(1),
    symptoms,
    inconclusive,
    rejected,
    fixes,
    codeHint,
    evidence,
    gaps: snapshot.gaps,
    snapshot,
  };
}

// Compact, redacted text for the LLM: the board plus the top log patterns.
export function boardToPrompt(board: Board, redactor: Redactor): string {
  const h = (x: Hypothesis) =>
    `- [${x.status}] ${x.id} (${x.category}, confidence ${x.confidence}): ${x.title}\n` +
    [...x.supporting.map((e) => `    + ${e.id}: ${e.summary}`), ...x.contradicting.map((e) => `    - ${e.id}: ${e.summary}`)].join('\n');

  const s = board.snapshot;
  const patterns = clusterLogs(s.logs)
    .slice(0, 8)
    .map((c) => `- ${c.count}× ${c.isError ? '[error] ' : ''}${c.template.slice(0, 160)}`)
    .join('\n');

  const text = [
    `App: ${board.app} | plan ${s.appInfo.planID ?? '?'} (${s.appInfo.planRamGB ?? '?'} GB RAM, ${s.appInfo.planCpu ?? '?'} CPU) | platform ${s.appInfo.platform ?? '?'}`,
    s.probe ? `Probe ${s.probe.url}: ok ${Math.round(s.probe.okRatio * 100)}%, p50 ${s.probe.p50}ms, p95 ${s.probe.p95}ms` : 'Probe: not available',
    `Verdict: ${board.verdict}; root cause: ${board.root?.id ?? 'none'}`,
    'Hypotheses:',
    ...[board.root, ...board.contributing, ...board.symptoms, ...board.inconclusive, ...board.rejected].filter((x): x is Hypothesis => Boolean(x)).map(h),
    board.codeHint ? `Code location: ${board.codeHint.file}:${board.codeHint.line} — ${board.codeHint.message}` : '',
    'Fix options (in order):',
    ...board.fixes.map((f, i) => `${i + 1}. [${f.tier}] ${f.action} ${f.args ? JSON.stringify(f.args) : ''} — ${f.title}`),
    'Top log patterns:',
    patterns || '- (no logs)',
    board.gaps.length ? `Data not available: ${board.gaps.join('; ')}` : '',
  ].filter(Boolean).join('\n');

  return redactor.mask(text);
}
