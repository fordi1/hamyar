// Persistent, shared approval requests. A request is created by the agent side
// (MCP or dashboard) and can only be decided through a trusted human channel:
// the dashboard (authenticated session), MCP elicitation, or an interactive terminal.
// The id is not a credential: knowing it never authorizes anything.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tier } from './policy.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked' | 'used';
export type ApprovalChannel = 'dashboard' | 'mcp-elicitation' | 'terminal';

export interface ApprovalPreview {
  title: string;
  lines: string[];
  risk: string;
  downtime: string;
  undo: string;
  cost?: string;
}

export interface ApprovalRecord {
  id: string;
  tool: string;
  tier: Tier;
  // secret-looking values masked; the hash below binds the real arguments
  args: Record<string, unknown>;
  argsHash: string;
  salt: string;
  preview: ApprovalPreview;
  source: 'mcp' | 'dashboard';
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  channel?: ApprovalChannel;
  reason?: string;
}

export class ApprovalError extends Error {
  constructor(public explanation: string) {
    super(explanation);
  }
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SECRET_KEYS = /value|password|secret|token|url$/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as any)[k])]));
  }
  return value;
}

export function maskSecrets(value: unknown, key = ''): unknown {
  if (key && key !== 'key' && SECRET_KEYS.test(key)) return '***';
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecrets(v, k)]));
  return value;
}

// Salted so the stored hash cannot be used to guess a secret value offline.
const hashArgs = (args: Record<string, unknown>, salt: string) =>
  createHmac('sha256', salt).update(JSON.stringify(canonical(args))).digest('hex');

export class ApprovalStore {
  private path: string;
  private now: () => number;
  private ttlMs: number;

  constructor(opts: { path: string; now?: () => number; ttlMs?: number }) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
  }

  private read(): ApprovalRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return [];
    }
  }

  // Atomic replace so another process never reads a half-written file.
  private write(records: ApprovalRecord[]) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    // keep the file small: drop finished records older than a day
    const cutoff = this.now() - 24 * 60 * 60_000;
    writeFileSync(tmp, JSON.stringify(records.filter((r) => r.status === 'pending' || r.createdAt > cutoff), null, 1));
    renameSync(tmp, this.path);
  }

  private refresh(records: ApprovalRecord[]): boolean {
    let changed = false;
    for (const r of records) {
      if ((r.status === 'pending' || r.status === 'approved') && this.now() > r.expiresAt) {
        r.status = 'expired';
        changed = true;
      }
    }
    return changed;
  }

  private update<T>(fn: (records: ApprovalRecord[]) => T): T {
    const records = this.read();
    this.refresh(records);
    const result = fn(records);
    this.write(records);
    return result;
  }

  private newId(records: ApprovalRecord[]): string {
    for (;;) {
      const bytes = randomBytes(6);
      const id = [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
      if (!records.some((r) => r.id === id)) return id;
    }
  }

  request(input: { tool: string; tier: Tier; args: Record<string, unknown>; preview: ApprovalPreview; source: 'mcp' | 'dashboard' }): ApprovalRecord {
    return this.update((records) => {
      const salt = randomBytes(16).toString('hex');
      const record: ApprovalRecord = {
        id: this.newId(records),
        tool: input.tool,
        tier: input.tier,
        args: maskSecrets(input.args) as Record<string, unknown>,
        argsHash: hashArgs(input.args, salt),
        salt,
        preview: input.preview,
        source: input.source,
        status: 'pending',
        createdAt: this.now(),
        expiresAt: this.now() + this.ttlMs,
      };
      records.push(record);
      return record;
    });
  }

  get(id: string): ApprovalRecord | undefined {
    const records = this.read();
    if (this.refresh(records)) this.write(records);
    return records.find((r) => r.id === id.toUpperCase());
  }

  list(filter: { status?: ApprovalStatus } = {}): ApprovalRecord[] {
    const records = this.read();
    if (this.refresh(records)) this.write(records);
    return records.filter((r) => !filter.status || r.status === filter.status).sort((a, b) => b.createdAt - a.createdAt);
  }

  // Only trusted human channels call this (dashboard session, elicitation answer, TTY prompt).
  decide(id: string, d: { approved: boolean; by: string; channel: ApprovalChannel; reason?: string }): ApprovalRecord {
    return this.update((records) => {
      const r = records.find((x) => x.id === id.toUpperCase());
      if (!r) throw new ApprovalError('این درخواست تأیید پیدا نشد.');
      if (r.status === 'expired') throw new ApprovalError('این درخواست منقضی شده است (بیش از ۱۰ دقیقه).');
      if (r.status !== 'pending') throw new ApprovalError(`این درخواست قبلاً بررسی شده است (${r.status}).`);
      r.status = d.approved ? 'approved' : 'rejected';
      r.decidedAt = this.now();
      r.decidedBy = d.by;
      r.channel = d.channel;
      if (d.reason) r.reason = d.reason.slice(0, 500);
      return { ...r };
    });
  }

  // Executing side: succeeds once, only for an approved request with identical arguments.
  consume(id: string, tool: string, args: Record<string, unknown>): ApprovalRecord {
    return this.update((records) => {
      const r = records.find((x) => x.id === id.toUpperCase());
      if (!r) throw new ApprovalError('این درخواست تأیید پیدا نشد.');
      switch (r.status) {
        case 'pending':
          throw new ApprovalError('این درخواست هنوز تأیید نشده است؛ انسان باید در داشبورد یا ترمینال تأییدش کند.');
        case 'rejected':
          throw new ApprovalError(`این درخواست رد شده است${r.reason ? `: ${r.reason}` : ''}.`);
        case 'expired':
          throw new ApprovalError('این درخواست منقضی شده است؛ پیش‌نمایش جدید بگیرید.');
        case 'revoked':
          throw new ApprovalError('این درخواست با دکمه‌ی توقف لغو شده است.');
        case 'used':
          throw new ApprovalError('این تأیید قبلاً استفاده شده است؛ برای اجرای دوباره، درخواست جدید بدهید.');
      }
      if (r.tool !== tool) throw new ApprovalError(`این تأیید برای «${r.tool}» است، نه «${tool}».`);
      if (r.argsHash !== hashArgs(args, r.salt)) throw new ApprovalError('آرگومان‌ها با چیزی که انسان تأیید کرد فرق دارند؛ درخواست جدید بدهید.');
      r.status = 'used';
      return { ...r };
    });
  }

  revokeAll(reason: string, filter: (r: ApprovalRecord) => boolean = () => true): number {
    return this.update((records) => {
      let n = 0;
      for (const r of records) {
        if ((r.status === 'pending' || r.status === 'approved') && filter(r)) {
          r.status = 'revoked';
          r.reason = reason;
          r.decidedAt = this.now();
          n++;
        }
      }
      return n;
    });
  }
}
