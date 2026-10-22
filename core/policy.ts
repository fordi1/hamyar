// Human-in-the-loop enforcement: risk tiers, the shared approval store, rate limits
// and an append-only audit log. This is code, not a prompt: a model cannot talk its
// way past it. Approvals live in ApprovalStore (core/approvals.ts) so the MCP server,
// the dashboard and the terminal approve the same requests.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApprovalStore, maskSecrets } from './approvals.js';
import { OperationStore } from './operations.js';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';
export type Mode = 'observe' | 'review' | 'auto-safe';

export class PolicyError extends Error {
  constructor(public explanation: string) {
    super(explanation);
  }
}

export interface AuditEntry {
  tool: string;
  tier: Tier;
  args: Record<string, unknown>;
  outcome: 'previewed' | 'approved' | 'executed' | 'failed' | 'rejected' | 'blocked' | 'revoked';
  approvedBy?: string;
  approvalId?: string;
  detail?: string;
}

export class Policy {
  readonly mode: Mode;
  readonly approvals: ApprovalStore;
  readonly operations: OperationStore;
  private auditPath: string;
  private now: () => number;

  constructor(opts: { mode?: Mode; auditPath?: string; approvalsPath?: string; now?: () => number } = {}) {
    this.mode = opts.mode ?? 'review';
    this.auditPath = opts.auditPath ?? 'audit.jsonl';
    this.now = opts.now ?? Date.now;
    const approvalsPath = opts.approvalsPath ?? join(dirname(this.auditPath), '.hamyar', 'approvals.json');
    this.approvals = new ApprovalStore({ path: approvalsPath, now: this.now });
    this.operations = new OperationStore({ path: join(dirname(approvalsPath), 'operations.json') });
  }

  static fromEnv(root = '.'): Policy {
    const mode = (process.env.HAMYAR_MODE as Mode) || 'review';
    return new Policy({
      mode: ['observe', 'review', 'auto-safe'].includes(mode) ? mode : 'review',
      auditPath: process.env.HAMYAR_AUDIT_PATH || join(root, 'audit.jsonl'),
      approvalsPath: process.env.HAMYAR_STATE_DIR ? join(process.env.HAMYAR_STATE_DIR, 'approvals.json') : join(root, '.hamyar', 'approvals.json'),
    });
  }

  needsApproval(tier: Tier): boolean {
    if (tier === 'T0') return false;
    if (tier === 'T1') return this.mode !== 'auto-safe';
    return true;
  }

  assertAllowed(tool: string, tier: Tier): void {
    if (tier === 'T3') throw new PolicyError('عملیات حذف (برنامه، دیسک، دیتابیس یا دامنه) عمداً در همیار وجود ندارد؛ لطفاً خودتان از کنسول لیارا انجام دهید.');
    if (tier !== 'T0' && this.mode === 'observe') {
      throw new PolicyError(`همیار در حالت «فقط مشاهده» است و «${tool}» را اجرا نمی‌کند. برای اجرا، حالت را به «بازبینی» تغییر دهید.`);
    }
  }

  // Kill switch: every pending or approved-but-unused request becomes revoked.
  revokeAll(reason = 'لغو با دکمه‌ی توقف'): number {
    const n = this.approvals.revokeAll(reason);
    if (n) this.audit({ tool: '*', tier: 'T2', args: {}, outcome: 'revoked', detail: `${n} درخواست لغو شد: ${reason}` });
    return n;
  }

  // Counted from the shared audit log, so MCP and dashboard processes share one budget.
  assertRate(tool: string, app?: string): void {
    const now = this.now();
    const executed = this.recent(500).filter((e) => e.outcome === 'executed');
    const count = (pred: (e: AuditEntry) => boolean, windowMs: number) => executed.filter((e) => now - Date.parse(e.at) < windowMs && pred(e)).length;

    if (['deploy', 'launch_app'].includes(tool) && count((e) => ['deploy', 'launch_app'].includes(e.tool), 10 * 60_000) >= 3) {
      throw new PolicyError('در ۱۰ دقیقه‌ی اخیر ۳ دیپلوی انجام شده؛ برای جلوگیری از اشتباه زنجیره‌ای، کمی صبر کنید.');
    }
    if (tool === 'restart_app' && count((e) => e.tool === 'restart_app' && e.args?.app === app, 5 * 60_000) >= 1) {
      throw new PolicyError('این برنامه در ۵ دقیقه‌ی اخیر ری‌استارت شده؛ ری‌استارت پشت‌سرهم مشکل را حل نمی‌کند.');
    }
    if (count(() => true, 60 * 60_000) >= 10) {
      throw new PolicyError('در یک ساعت اخیر ۱۰ تغییر انجام شده؛ سقف ایمنی پر شده است.');
    }
  }

  audit(entry: AuditEntry): void {
    const line = { at: new Date(this.now()).toISOString(), mode: this.mode, ...entry, args: maskSecrets(entry.args) };
    mkdirSync(dirname(this.auditPath), { recursive: true });
    appendFileSync(this.auditPath, JSON.stringify(line) + '\n');
  }

  recent(limit = 20): (AuditEntry & { at: string })[] {
    if (!existsSync(this.auditPath)) return [];
    return readFileSync(this.auditPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l));
  }
}
