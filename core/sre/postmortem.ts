// Persian incident report (markdown) built from the board, the actions that were
// approved and executed, and the verification numbers.
import type { Board } from './rca.js';
import type { Hypothesis } from './detectors.js';
import type { VerifyResult } from './verify.js';

export interface ActionRecord {
  at: number;
  action: string;
  tier: string;
  title: string;
  approvedBy?: string;
  result: 'ok' | 'failed' | 'rejected';
  detail?: string;
}

export interface PostmortemInput {
  board: Board;
  actions: ActionRecord[];
  verify?: VerifyResult;
  // optional LLM explanation, already unmasked
  explanation?: string;
}

const time = (t?: number) =>
  t ? new Date(t).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' }) : '—';
const fa = (n: number) => n.toLocaleString('fa-IR');

const evidenceList = (h: Hypothesis) =>
  [...h.supporting.map((e) => `  - ✔️ ${e.id}: ${e.summary}`), ...h.contradicting.map((e) => `  - ✖️ ${e.id}: ${e.summary}`)].join('\n');

export function renderPostmortem({ board, actions, verify, explanation }: PostmortemInput): string {
  const lines: string[] = [];
  lines.push(`# گزارش حادثه — ${board.app}`, '');
  lines.push(`**زمان بررسی:** ${time(board.createdAt)}  `);
  lines.push(`**نتیجه:** ${verify ? (verify.passed ? '✅ مشکل برطرف شد' : '⚠️ مشکل هنوز کامل برطرف نشده') : board.root ? '🔎 علت پیدا شد، اقدامی انجام نشده' : 'علت قطعی پیدا نشد'}`, '');

  lines.push('## خلاصه', '');
  if (board.root) {
    lines.push(`علت اصلی: **${board.root.title}** (اطمینان ${fa(Math.round(board.root.confidence * 100))}٪).`, '');
    lines.push(evidenceList(board.root), '');
  } else {
    lines.push('هیچ علتی با اطمینان کافی تأیید نشد.', '');
  }
  if (explanation) lines.push(explanation, '');
  if (board.codeHint) lines.push(`محل مشکل در کد: \`${board.codeHint.file}:${board.codeHint.line}\``, '');

  if (board.contributing.length || board.symptoms.length) {
    lines.push('## عوامل و نشانه‌های دیگر', '');
    for (const h of [...board.contributing, ...board.symptoms]) lines.push(`- ${h.title} (${h.category === 'symptom' ? 'نشانه' : 'عامل کمکی'})`);
    lines.push('');
  }

  if (board.rejected.length) {
    lines.push('## فرضیه‌هایی که رد شد', '');
    for (const h of board.rejected) {
      lines.push(`- ~~${h.title}~~ — رد شد: ${h.contradicting.map((e) => `${e.id}: ${e.summary}`).join('؛ ')}`);
    }
    lines.push('');
  }

  lines.push('## خط زمانی', '');
  const timeline: { at?: number; text: string }[] = [];
  if (board.root?.startedAt) timeline.push({ at: board.root.startedAt, text: `شروع مشکل: ${board.root.title}` });
  timeline.push({ at: board.createdAt, text: 'بررسی توسط همیار' });
  for (const a of actions) {
    const who = a.approvedBy ? ` — تأیید: ${a.approvedBy}` : '';
    const result = a.result === 'ok' ? 'انجام شد' : a.result === 'rejected' ? 'رد شد توسط کاربر' : `ناموفق${a.detail ? `: ${a.detail}` : ''}`;
    timeline.push({ at: a.at, text: `${a.title} [${a.tier}] — ${result}${who}` });
  }
  timeline.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
  for (const t of timeline) lines.push(`- ${time(t.at)}: ${t.text}`);
  lines.push('');

  if (verify) {
    lines.push('## بررسی نتیجه', '');
    lines.push('| معیار | قبل | بعد | هدف | وضعیت |', '|---|---|---|---|---|');
    for (const r of verify.rows) lines.push(`| ${r.metric} | ${r.before} | ${r.after} | ${r.target} | ${r.ok ? '✅' : '❌'} |`);
    lines.push('');
  }

  const prevention: Record<string, string> = {
    'missing-env': 'متغیرهای لازم را در .env.example ثبت کنید تا همیار قبل از هر دیپلوی کمبودشان را گزارش دهد.',
    memory: 'مصرف حافظه را بعد از هر دیپلوی پایش کنید و حافظه‌ی کش‌ها را محدود کنید.',
    slow: 'برای کوئری‌های تکراری از JOIN یا WHERE IN استفاده کنید و ایندکس مناسب بسازید.',
    'bad-release': 'healthCheck را در liara.json فعال نگه دارید تا نسخه‌ی خراب جایگزین نسخه‌ی سالم نشود.',
    port: 'پورت را از متغیر PORT بخوانید.',
    build: 'build.location را در liara.json ثبت کنید.',
  };
  if (board.root && prevention[board.root.id]) lines.push('## پیشگیری', '', `- ${prevention[board.root.id]}`, '');

  if (board.gaps.length) lines.push('## محدودیت داده‌ها', '', ...board.gaps.map((g) => `- ${g}`), '');
  return lines.join('\n');
}
