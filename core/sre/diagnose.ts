// One call for the whole investigation: collect → detect → board.
// Also renders the board as Persian text for terminals and MCP clients.
import type { LiaraClient } from '../liara-client.js';
import { collectSnapshot, type CollectOptions } from './collect.js';
import { runDetectors, type Hypothesis } from './detectors.js';
import { buildBoard, type Board } from './rca.js';
import type { Snapshot } from './snapshot.js';

export async function diagnose(client: LiaraClient, app: string, opts: CollectOptions = {}): Promise<Board> {
  const snapshot = await collectSnapshot(client, app, opts);
  return boardFromSnapshot(snapshot);
}

export function boardFromSnapshot(snapshot: Snapshot): Board {
  return buildBoard(snapshot, runDetectors(snapshot));
}

const fa = (n: number) => n.toLocaleString('fa-IR');
const STATUS = { validated: '✅ تأیید شد', invalidated: '❌ رد شد', inconclusive: '❔ نامشخص' } as const;

function renderHypothesis(h: Hypothesis): string {
  const head = `${STATUS[h.status]}  ${h.title}  (اطمینان ${fa(Math.round(h.confidence * 100))}٪${h.category === 'symptom' ? '، نشانه' : ''})`;
  const ev = [...h.supporting.map((e) => `     + ${e.id} ${e.summary}`), ...h.contradicting.map((e) => `     − ${e.id} ${e.summary}`)];
  return [head, ...ev].join('\n');
}

export function renderBoard(board: Board): string {
  const out: string[] = [];
  const verdict = { problem: '🔴 مشکل پیدا شد', healthy: '🟢 سالم', unclear: '🟡 نامشخص' }[board.verdict];
  out.push(`\n🩺 بررسی ${board.app}: ${verdict}`);
  const p = board.snapshot.probe;
  if (p) out.push(`   تست مستقیم: ${fa(Math.round(p.okRatio * 100))}٪ موفق، p95=${fa(p.p95)}ms`);

  if (board.root) out.push(`\n🎯 علت اصلی:\n   ${renderHypothesis(board.root)}`);
  for (const h of board.contributing) out.push(`\n➕ عامل دیگر:\n   ${renderHypothesis(h)}`);
  for (const h of board.symptoms) out.push(`\n🩹 نشانه:\n   ${renderHypothesis(h)}`);
  if (board.inconclusive.length) out.push(`\n❔ بررسی‌شده ولی نامشخص:\n   ${board.inconclusive.map(renderHypothesis).join('\n   ')}`);
  if (board.rejected.length) out.push(`\n🚫 رد شده:\n   ${board.rejected.map(renderHypothesis).join('\n   ')}`);
  if (board.codeHint) out.push(`\n📍 محل مشکل در کد: ${board.codeHint.file}:${board.codeHint.line}`);

  if (board.fixes.length) {
    out.push('\n🛠️ راه‌حل‌ها (به ترتیب پیشنهاد):');
    const tierLabel = { T1: 'با یک تأیید', T2: 'نیاز به تأیید + پیش‌نمایش', code: 'تغییر کد', manual: 'کار دستی در کنسول' };
    board.fixes.forEach((f, i) => out.push(`   ${fa(i + 1)}. ${f.title}  [${tierLabel[f.tier]}]\n      اثر: ${f.effect} | ریسک: ${f.risk} | قطعی: ${f.downtime}`));
  }
  if (board.gaps.length) out.push(`\n⚠️ داده‌هایی که در دسترس نبود:\n   ${board.gaps.join('\n   ')}`);
  return out.join('\n');
}
