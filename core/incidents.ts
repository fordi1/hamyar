// Incident history (screens D and G). A diagnose that finds a problem opens an incident
// for the app, or adds to the one still open; verify attaches its before/after result and
// closes it when the targets are met. Approvals and executions are not copied here: the
// audit log is the single record of those, merged in when an incident is shown.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HypothesisSummary {
  id: string;
  title: string;
  status: string;
  category: string;
  confidence: number;
  // evidence ids (E1, E2…) are missing only when the board had no numbered evidence
  supporting: { id?: string; kind: string; summary: string }[];
  contradicting: { id?: string; kind: string; summary: string }[];
}

export interface DiagnosisInput {
  app: string;
  at: number;
  source: 'dashboard' | 'mcp';
  verdict: 'problem' | 'healthy' | 'unclear';
  probe?: { url: string; okRatio: number; p95: number };
  root?: HypothesisSummary;
  others: HypothesisSummary[];
  inconclusive: HypothesisSummary[];
  rejected: HypothesisSummary[];
  fixes: { title: string; tier: string; action: string; effect?: string }[];
  codeHint?: { file: string; line: number; message?: string };
  gaps: string[];
  // the most frequent error patterns in the investigated window
  logs: { count: number; sample: string }[];
}

export interface VerificationRow {
  metric: string;
  before: string;
  after: string;
  target: string;
  ok: boolean;
}

export type IncidentStatus = 'open' | 'resolved' | 'closed';
export type Severity = 'critical' | 'degraded' | 'unclear';

export interface Incident extends Omit<DiagnosisInput, 'at' | 'source'> {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: Severity;
  source: DiagnosisInput['source'];
  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  diagnoses: number;
  events: { at: number; kind: 'trigger' | 'evidence' | 'diagnosis' | 'verify' | 'closed'; text: string }[];
  verifications: { at: number; passed: boolean; rows: VerificationRow[] }[];
}

const fa = (n: number) => n.toLocaleString('fa-IR');
const SOURCE = { dashboard: 'درخواست از داشبورد همیار', mcp: 'درخواست از Claude Code' };

function severityOf(d: DiagnosisInput): Severity {
  if (d.probe && d.probe.okRatio < 0.9) return 'critical';
  return d.verdict === 'problem' ? 'degraded' : 'unclear';
}

function titleOf(d: DiagnosisInput): string {
  if (d.root) return d.root.title;
  if (d.probe && d.probe.okRatio < 0.9) return `سایت ${d.app} خطا می‌دهد؛ علت قطعی پیدا نشد`;
  return `مشکل ${d.app}؛ علت قطعی پیدا نشد`;
}

function diagnosisText(d: DiagnosisInput): string {
  if (d.verdict === 'healthy') return 'بررسی دوباره: برنامه سالم بود (همه‌ی فرضیه‌ها رد شدند).';
  const root = d.root ? `علت: ${d.root.title} (اطمینان ${fa(Math.round(d.root.confidence * 100))}٪)` : 'علت قطعی پیدا نشد';
  return `${root}؛ ${fa(d.rejected.length)} فرضیه رد شد${d.inconclusive.length ? `، ${fa(d.inconclusive.length)} نامشخص` : ''}${d.fixes[0] ? `. راه‌حل اول: ${d.fixes[0].title}` : ''}`;
}

export function hypothesisLabel(h: HypothesisSummary, group: 'root' | 'other' | 'inconclusive' | 'rejected'): string {
  if (group === 'rejected') return 'رد شد';
  if (group === 'inconclusive') return 'نامشخص';
  if (group === 'root') return h.confidence >= 0.8 ? 'علت تأییدشده' : 'علت محتمل';
  return h.category === 'symptom' ? 'نشانه' : 'علت محتمل';
}

export class IncidentStore {
  private path: string;
  private now: () => number;

  constructor(opts: { path: string; now?: () => number }) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
  }

  private read(): Incident[] {
    if (!existsSync(this.path)) return [];
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(data) ? data.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private write(list: Incident[]) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list.slice(-100), null, 1));
    renameSync(tmp, this.path);
  }

  list(): Incident[] {
    return this.read().sort((a, b) => b.openedAt - a.openedAt);
  }

  get(id: string): Incident | undefined {
    return this.read().find((i) => i.id === id);
  }

  openFor(app: string): Incident | undefined {
    return this.read().find((i) => i.app === app && i.status === 'open');
  }

  recordDiagnosis(d: DiagnosisInput): Incident | undefined {
    const list = this.read();
    const now = this.now();
    const open = list.find((i) => i.app === d.app && i.status === 'open');
    if (!open) {
      if (d.verdict === 'healthy') return undefined;
      const { at: _at, source, ...rest } = d;
      const incident: Incident = {
        ...rest,
        id: randomBytes(4).toString('hex').toUpperCase(),
        title: titleOf(d),
        status: 'open',
        severity: severityOf(d),
        source,
        openedAt: now,
        updatedAt: now,
        diagnoses: 1,
        verifications: [],
        events: [
          { at: now, kind: 'trigger', text: `${SOURCE[source]}${d.probe ? ` · بررسی زنده: ${fa(Math.round(d.probe.okRatio * 100))}٪ درخواست موفق، p95 ${fa(d.probe.p95)}ms` : ''}` },
          { at: now, kind: 'evidence', text: `جمع‌آوری مدرک: لاگ، رویدادها، CPU/RAM، نسخه‌ها و بررسی زنده${d.gaps.length ? ` (در دسترس نبود: ${d.gaps.join('، ')})` : ''}` },
          { at: now, kind: 'diagnosis', text: diagnosisText(d) },
        ],
      };
      list.push(incident);
      this.write(list);
      return incident;
    }
    open.diagnoses++;
    open.updatedAt = now;
    open.events.push({ at: now, kind: 'diagnosis', text: diagnosisText(d) });
    // a healthy re-check is noted but keeps the board that explained the incident
    if (d.verdict !== 'healthy') {
      const { at: _at, source: _source, ...rest } = d;
      Object.assign(open, rest, { title: titleOf(d), severity: severityOf(d) });
    }
    this.write(list);
    return open;
  }

  recordVerification(app: string, v: { passed: boolean; rows: VerificationRow[] }): Incident | undefined {
    const list = this.read();
    const open = list.find((i) => i.app === app && i.status === 'open');
    if (!open) return undefined;
    const now = this.now();
    open.verifications.push({ at: now, passed: v.passed, rows: v.rows });
    open.events.push({ at: now, kind: 'verify', text: v.passed ? 'بررسی بعد از رفع: همه‌ی هدف‌ها برآورده شد' : `بررسی بعد از رفع: ${fa(v.rows.filter((r) => !r.ok).length)} هدف هنوز برآورده نشده` });
    open.updatedAt = now;
    if (v.passed) {
      open.status = 'resolved';
      open.closedAt = now;
      open.events.push({ at: now, kind: 'closed', text: 'حادثه بسته شد: رفع با اندازه‌گیری تأیید شد' });
    }
    this.write(list);
    return open;
  }

  close(id: string, reason: string): Incident | undefined {
    const list = this.read();
    const inc = list.find((i) => i.id === id && i.status === 'open');
    if (!inc) return undefined;
    const now = this.now();
    inc.status = 'closed';
    inc.closedAt = now;
    inc.updatedAt = now;
    inc.events.push({ at: now, kind: 'closed', text: `کاربر حادثه را بدون تأیید رفع بست${reason ? `: ${reason}` : ''}` });
    this.write(list);
    return inc;
  }
}

// ---------- report ----------

export interface AuditRow {
  at: number;
  tool: string;
  outcome: string;
  approvedBy?: string;
  detail?: string;
}

const TOOL_FA: Record<string, string> = {
  restart_app: 'ری‌استارت', turn_on_app: 'روشن کردن', turn_off_app: 'خاموش کردن', set_env: 'تنظیم متغیرها', resize_plan: 'تغییر پلن',
  rollback: 'بازگشت به نسخه‌ی قبلی', deploy: 'انتشار نسخه‌ی جدید', launch_app: 'ساخت و دیپلوی', add_domain: 'اتصال دامنه', enable_ssl: 'فعال‌سازی SSL',
};
const OUTCOME_FA: Record<string, string> = { approved: 'تأیید شد', rejected: 'رد شد', executed: 'اجرا شد', failed: 'ناموفق', blocked: 'مسدود شد', revoked: 'لغو شد' };
const time = (ms: number) => new Date(ms).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
const who = (s?: string) => (s ? s.replace(/^user\b/, 'کاربر').replace('(dashboard)', '(داشبورد)').replace('(mcp-elicitation)', '(Claude Code)').replace('(terminal)', '(ترمینال)') : '');

export function renderIncidentReport(inc: Incident, actions: AuditRow[]): string {
  const out: string[] = [];
  const statusText = inc.status === 'resolved' ? '✅ برطرف شد (با اندازه‌گیری تأیید شد)' : inc.status === 'closed' ? 'بسته شد بدون تأیید رفع' : '🔎 هنوز باز است';
  out.push(`# گزارش حادثه — ${inc.app}`, '');
  out.push(`**عنوان:** ${inc.title}  `, `**وضعیت:** ${statusText}  `, `**شروع:** ${time(inc.openedAt)}${inc.closedAt ? `  \n**پایان:** ${time(inc.closedAt)}` : ''}`, '');

  out.push('## علت', '');
  if (inc.root) {
    out.push(`**${hypothesisLabel(inc.root, 'root')}:** ${inc.root.title} — اطمینان ${fa(Math.round(inc.root.confidence * 100))}٪`, '');
    for (const e of inc.root.supporting) out.push(`- ${e.id ?? '—'}: ${e.summary}`);
    for (const e of inc.root.contradicting) out.push(`- ${e.id ?? '—'} (خلاف): ${e.summary}`);
    if (inc.codeHint) out.push(`- محل در کد: ${inc.codeHint.file}:${inc.codeHint.line}`);
    out.push('');
  } else {
    out.push('هیچ علتی با اطمینان کافی تأیید نشد.', '');
  }
  if (inc.rejected.length || inc.inconclusive.length) {
    out.push('## علت‌های دیگری که بررسی شد', '');
    for (const h of inc.rejected) out.push(`- **رد شد:** ${h.title}${h.contradicting[0] ? ` — ${h.contradicting[0].id ?? '—'}: ${h.contradicting[0].summary}` : ''}`);
    for (const h of inc.inconclusive) out.push(`- **نامشخص:** ${h.title} (مدرک کافی نبود)`);
    out.push('');
  }
  if (inc.logs.length) {
    out.push('## لاگ‌های مرتبط', '');
    for (const l of inc.logs) out.push(`- ${fa(l.count)} بار: \`${l.sample.split('\n')[0].slice(0, 160)}\``);
    out.push('');
  }
  out.push('## تصمیم‌ها و اقدام‌ها', '');
  if (!actions.length) out.push('اقدامی ثبت نشده است.');
  for (const a of actions) out.push(`- ${time(a.at)} — ${TOOL_FA[a.tool] ?? a.tool}: ${OUTCOME_FA[a.outcome] ?? a.outcome}${a.approvedBy ? ` · ${who(a.approvedBy)}` : ''}${a.detail ? ` · «${a.detail}»` : ''}`);
  out.push('');
  const last = inc.verifications.at(-1);
  if (last) {
    out.push('## قبل و بعد', '', '| معیار | قبل | بعد | هدف | |', '|---|---|---|---|---|');
    for (const r of last.rows) out.push(`| ${r.metric} | ${r.before} | ${r.after} | ${r.target} | ${r.ok ? '✅' : '❌'} |`);
    out.push('');
  }
  if (inc.gaps.length) out.push(`_داده‌ای که در دسترس نبود: ${inc.gaps.join('، ')}_`);
  return out.join('\n');
}
