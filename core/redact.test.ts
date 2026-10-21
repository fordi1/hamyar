import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact.js';

describe('redactor', () => {
  it('masks JWTs, bearer tokens, connection-string passwords, emails and IPs', () => {
    const r = createRedactor();
    const out = r.mask(
      'auth Bearer abc.def.ghi token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySUQiOjF9.sig_123 ' +
        'db postgres://admin:hunter2@10.0.0.5:5432/shop mail ali@example.com',
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('ali@example.com');
    expect(out).not.toContain('10.0.0.5');
    expect(out).toContain('postgres://admin:');
  });

  it('masks known secret values such as the app env values', () => {
    const r = createRedactor(['s3cr3t-value']);
    expect(r.mask('config loaded with s3cr3t-value ok')).toBe('config loaded with [SECRET_1] ok');
  });

  it('gives the same placeholder to the same value and can restore it', () => {
    const r = createRedactor();
    const masked = r.mask('from ali@example.com to ali@example.com');
    expect(masked).toBe('from [EMAIL_1] to [EMAIL_1]');
    expect(r.unmask(masked)).toBe('from ali@example.com to ali@example.com');
  });

  it('ignores very short known values to avoid masking common words', () => {
    const r = createRedactor(['1', 'on']);
    expect(r.mask('port 1 is on')).toBe('port 1 is on');
  });
});
