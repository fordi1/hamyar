// Dashboard security primitives, kept pure so they can be tested without a server:
// expiring sessions, login brute-force limiting, CSRF / origin checks, response headers.
import { randomBytes } from 'node:crypto';

export class SessionStore {
  private sessions = new Map<string, { created: number; seen: number }>();
  private idleMs: number;
  private maxMs: number;
  private now: () => number;

  constructor(opts: { idleMs?: number; maxMs?: number; now?: () => number } = {}) {
    this.idleMs = opts.idleMs ?? 60 * 60_000;
    this.maxMs = opts.maxMs ?? 8 * 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  create(): string {
    const id = randomBytes(24).toString('hex');
    this.sessions.set(id, { created: this.now(), seen: this.now() });
    return id;
  }

  // Valid sessions are touched, so activity keeps them alive up to the absolute lifetime.
  valid(id: string | undefined): boolean {
    if (!id) return false;
    const s = this.sessions.get(id);
    if (!s) return false;
    const now = this.now();
    if (now - s.seen > this.idleMs || now - s.created > this.maxMs) {
      this.sessions.delete(id);
      return false;
    }
    s.seen = now;
    return true;
  }

  destroy(id: string | undefined) {
    if (id) this.sessions.delete(id);
  }

  get maxAgeSeconds() {
    return Math.floor(this.maxMs / 1000);
  }
}

export class LoginLimiter {
  private failures = new Map<string, number[]>();
  private now: () => number;
  private windowMs = 15 * 60_000;
  private limit = 5;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private recent(ip: string) {
    const list = (this.failures.get(ip) ?? []).filter((t) => this.now() - t < this.windowMs);
    this.failures.set(ip, list);
    return list;
  }

  blocked(ip: string): boolean {
    return this.recent(ip).length >= this.limit;
  }

  fail(ip: string) {
    this.recent(ip).push(this.now());
  }

  succeed(ip: string) {
    this.failures.delete(ip);
  }
}

// State-changing requests must be same-origin JSON: browsers cannot send a cross-site
// JSON request without a CORS preflight, which this server never grants.
// `allowZip`: the upload route also takes application/zip, which, like JSON, a cross-site
// form cannot send without a CORS preflight.
export function checkMutationRequest(req: { method?: string; headers: Record<string, string | string[] | undefined> }, opts: { allowZip?: boolean } = {}): string | undefined {
  if (!req.method || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return undefined;
  const origin = req.headers.origin as string | undefined;
  const host = req.headers.host as string | undefined;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'invalid origin';
    }
    if (originHost !== host) return 'cross-origin request refused (origin)';
  }
  const type = String(req.headers['content-type'] ?? '');
  if (opts.allowZip && type.startsWith('application/zip')) return undefined;
  if (!type.startsWith('application/json')) return 'requests that change state must send JSON';
  return undefined;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function passwordProblem(password: string): string | undefined {
  if (password.length < 12) return 'رمز داشبورد باید حداقل ۱۲ کاراکتر باشد (HAMYAR_DASHBOARD_PASSWORD).';
  return undefined;
}
