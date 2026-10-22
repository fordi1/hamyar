import { describe, expect, it } from 'vitest';
import { SessionStore, LoginLimiter, checkMutationRequest, SECURITY_HEADERS, passwordProblem } from './security.js';

describe('SessionStore', () => {
  it('expires after idle time and after the absolute lifetime', () => {
    let now = 0;
    const s = new SessionStore({ idleMs: 1000, maxMs: 5000, now: () => now });
    const id = s.create();
    now = 900;
    expect(s.valid(id)).toBe(true); // touching refreshes idle time
    now = 1800;
    expect(s.valid(id)).toBe(true);
    now = 2900;
    expect(s.valid(id)).toBe(false); // idle > 1000
    const b = s.create();
    for (now = 3000; now <= 8200; now += 800) s.valid(b);
    expect(s.valid(b)).toBe(false); // older than 5000 even though active
  });

  it('destroys a session on logout and rejects unknown ids', () => {
    const s = new SessionStore();
    const id = s.create();
    s.destroy(id);
    expect(s.valid(id)).toBe(false);
    expect(s.valid('nope')).toBe(false);
    expect(s.valid(undefined)).toBe(false);
  });
});

describe('LoginLimiter', () => {
  it('blocks an address after 5 failures in 15 minutes, then recovers', () => {
    let now = 0;
    const l = new LoginLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) l.fail('1.2.3.4');
    expect(l.blocked('1.2.3.4')).toBe(true);
    expect(l.blocked('5.6.7.8')).toBe(false);
    now = 15 * 60_000 + 1;
    expect(l.blocked('1.2.3.4')).toBe(false);
  });

  it('clears failures after a successful login', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail('a');
    l.succeed('a');
    l.fail('a');
    expect(l.blocked('a')).toBe(false);
  });
});

describe('checkMutationRequest', () => {
  const req = (headers: Record<string, string>) => ({ method: 'POST', headers: { host: 'hamyar.liara.run', ...headers } });

  it('accepts same-origin JSON', () => {
    expect(checkMutationRequest(req({ origin: 'https://hamyar.liara.run', 'content-type': 'application/json' }))).toBeUndefined();
  });

  it('rejects another origin (CSRF)', () => {
    expect(checkMutationRequest(req({ origin: 'https://evil.example', 'content-type': 'application/json' }))).toMatch(/origin/i);
  });

  it('rejects non-JSON bodies, which plain HTML forms can send cross-site', () => {
    expect(checkMutationRequest(req({ origin: 'https://hamyar.liara.run', 'content-type': 'application/x-www-form-urlencoded' }))).toMatch(/JSON/);
  });

  it('ignores safe methods', () => {
    expect(checkMutationRequest({ method: 'GET', headers: { host: 'x' } })).toBeUndefined();
  });
});

describe('security headers and password policy', () => {
  it('sends a strict CSP with no third-party origins', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("default-src 'self'");
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['Content-Security-Policy']).not.toMatch(/https?:\/\//);
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });

  it('refuses short dashboard passwords', () => {
    expect(passwordProblem('short')).toMatch(/۱۲/);
    expect(passwordProblem('a-long-enough-pass')).toBeUndefined();
  });
});
