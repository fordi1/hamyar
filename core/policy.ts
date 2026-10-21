// Human-in-the-loop enforcement. Risk tiers, single-use confirm tokens bound to
// the exact tool + arguments, rate limits and an append-only audit log.
// This is code, not a prompt: a model cannot talk its way past it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

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
  outcome: 'previewed' | 'executed' | 'failed' | 'rejected' | 'blocked';
  approvedBy?: string;
  detail?: string;
}

interface Issued {
  tool: string;
  argsHash: string;
  expiresAt: number;
  used: boolean;
}

const TOKEN_TTL = 10 * 60_000;
// Argument names whose values are secrets and must never be written to the audit log.
const SECRET_KEYS = /value|password|secret|token|key_value|url$/i;

// Key order must not matter, at any depth.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as any)[k])]));
  }
  return value;
}

function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
}

function mask(value: unknown, key = ''): unknown {
  if (key && key !== 'key' && SECRET_KEYS.test(key)) return '***';
  if (Array.isArray(value)) return value.map((v) => mask(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
  return value;
}

const maskArgs = (args: Record<string, unknown>) => mask(args) as Record<string, unknown>;

export class Policy {
  readonly mode: Mode;
  private tokens = new Map<string, Issued>();
  private history: { tool: string; app?: string; at: number }[] = [];
  private auditPath: string;
  private now: () => number;

  constructor(opts: { mode?: Mode; auditPath?: string; now?: () => number } = {}) {
    this.mode = opts.mode ?? 'review';
    this.auditPath = opts.auditPath ?? 'audit.jsonl';
    this.now = opts.now ?? Date.now;
  }

  static fromEnv(): Policy {
    const mode = (process.env.HAMYAR_MODE as Mode) || 'review';
    return new Policy({ mode: ['observe', 'review', 'auto-safe'].includes(mode) ? mode : 'review', auditPath: process.env.HAMYAR_AUDIT_PATH });
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

  issue(tool: string, args: Record<string, unknown>): { token: string; expiresAt: number } {
    const token = randomBytes(4).toString('hex');
    const expiresAt = this.now() + TOKEN_TTL;
    this.tokens.set(token, { tool, argsHash: hashArgs(args), expiresAt, used: false });
    return { token, expiresAt };
  }

  consume(tool: string, args: Record<string, unknown>, token: string): void {
    const t = this.tokens.get(token);
    if (!t) throw new PolicyError('کد تأیید نامعتبر است؛ اول پیش‌نمایش را بگیرید و بعد از تأیید کاربر اجرا کنید.');
    if (t.used) throw new PolicyError('این کد تأیید قبلاً استفاده شده است؛ برای اجرای دوباره، پیش‌نمایش جدید بگیرید.');
    if (this.now() > t.expiresAt) throw new PolicyError('کد تأیید منقضی شده است (بیش از ۱۰ دقیقه)؛ پیش‌نمایش جدید بگیرید.');
    if (t.tool !== tool) throw new PolicyError(`این کد تأیید برای «${t.tool}» صادر شده، نه «${tool}».`);
    if (t.argsHash !== hashArgs(args)) throw new PolicyError('آرگومان‌ها با چیزی که کاربر تأیید کرد فرق دارند؛ پیش‌نمایش جدید بگیرید.');
    t.used = true;
  }

  revokeAll(): void {
    this.tokens.clear();
  }

  assertRate(tool: string, app?: string): void {
    const now = this.now();
    const count = (pred: (h: { tool: string; app?: string; at: number }) => boolean, windowMs: number) =>
      this.history.filter((h) => now - h.at < windowMs && pred(h)).length;

    if (['deploy', 'launch_app'].includes(tool) && count((h) => ['deploy', 'launch_app'].includes(h.tool), 10 * 60_000) >= 3) {
      throw new PolicyError('در ۱۰ دقیقه‌ی اخیر ۳ دیپلوی انجام شده؛ برای جلوگیری از اشتباه زنجیره‌ای، کمی صبر کنید.');
    }
    if (tool === 'restart_app' && count((h) => h.tool === 'restart_app' && h.app === app, 5 * 60_000) >= 1) {
      throw new PolicyError('این برنامه در ۵ دقیقه‌ی اخیر ری‌استارت شده؛ ری‌استارت پشت‌سرهم مشکل را حل نمی‌کند.');
    }
    if (count(() => true, 60 * 60_000) >= 10) {
      throw new PolicyError('در یک ساعت اخیر ۱۰ تغییر انجام شده؛ سقف ایمنی پر شده است.');
    }
    this.history.push({ tool, app, at: now });
  }

  audit(entry: AuditEntry): void {
    const line = { at: new Date(this.now()).toISOString(), mode: this.mode, ...entry, args: maskArgs(entry.args) };
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
