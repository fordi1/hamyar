import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncidentStore, hypothesisLabel, renderIncidentReport, type DiagnosisInput } from './incidents.js';

const path = () => join(mkdtempSync(join(tmpdir(), 'hamyar-inc-')), 'incidents.json');

function diagnosis(over: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    app: 'shop',
    at: 1_000_000,
    source: 'dashboard',
    verdict: 'problem',
    probe: { url: 'https://shop.liara.run/products', okRatio: 0, p95: 40 },
    root: { id: 'missing_env', title: 'متغیر DATABASE_URL تنظیم نشده', status: 'validated', category: 'cause', confidence: 0.95, supporting: [{ id: 'E1', kind: 'log', summary: '۳۸ بار DATABASE_URL is not defined' }], contradicting: [] },
    others: [],
    inconclusive: [{ id: 'db', title: 'کندی پایگاه داده', status: 'inconclusive', category: 'cause', confidence: 0.3, supporting: [], contradicting: [] }],
    rejected: [{ id: 'bad_release', title: 'نسخه‌ی بد', status: 'invalidated', category: 'cause', confidence: 0.1, supporting: [], contradicting: [{ id: 'E3', kind: 'release', summary: 'خطاها ۲ ساعت بعد از انتشار شروع شد' }] }],
    fixes: [{ title: 'تنظیم DATABASE_URL', tier: 'T2', action: 'set_env', effect: 'خطای ۵۰۰ رفع می‌شود' }],
    codeHint: { file: 'server.js', line: 39, message: 'process.env.DATABASE_URL' },
    gaps: ['متریک شبکه'],
    logs: [{ count: 38, sample: 'Error: DATABASE_URL is not defined' }],
    ...over,
  };
}

describe('IncidentStore', () => {
  it('opens an incident for a problem and not for a healthy check', () => {
    const s = new IncidentStore({ path: path(), now: () => 1_000_000 });
    expect(s.recordDiagnosis(diagnosis({ verdict: 'healthy', root: undefined }))).toBeUndefined();
    const inc = s.recordDiagnosis(diagnosis())!;
    expect(inc.status).toBe('open');
    expect(inc.severity).toBe('critical');
    expect(inc.title).toContain('DATABASE_URL');
    expect(inc.events.map((e) => e.kind)).toEqual(['trigger', 'evidence', 'diagnosis']);
    expect(s.list()).toHaveLength(1);
  });

  it('adds a later diagnosis to the open incident of the same app instead of opening another', () => {
    let t = 1_000_000;
    const s = new IncidentStore({ path: path(), now: () => t });
    const first = s.recordDiagnosis(diagnosis())!;
    t += 60_000;
    const again = s.recordDiagnosis(diagnosis({ at: t }))!;
    expect(again.id).toBe(first.id);
    expect(again.diagnoses).toBe(2);
    expect(s.recordDiagnosis(diagnosis({ app: 'blog' }))!.id).not.toBe(first.id);
  });

  it('a healthy diagnosis on an open incident is noted but does not close it (only verify closes)', () => {
    const s = new IncidentStore({ path: path(), now: () => 1_000_000 });
    const inc = s.recordDiagnosis(diagnosis())!;
    const after = s.recordDiagnosis(diagnosis({ verdict: 'healthy', root: undefined }))!;
    expect(after.id).toBe(inc.id);
    expect(after.status).toBe('open');
    expect(after.root?.id).toBe('missing_env');
  });

  it('a passing verify resolves the incident; a failing one keeps it open', () => {
    let t = 1_000_000;
    const s = new IncidentStore({ path: path(), now: () => t });
    const inc = s.recordDiagnosis(diagnosis())!;
    t += 1000;
    expect(s.recordVerification('shop', { passed: false, rows: [{ metric: 'نرخ موفق', before: '۰٪', after: '۰٪', target: '≥۹۵٪', ok: false }] })!.status).toBe('open');
    t += 1000;
    const done = s.recordVerification('shop', { passed: true, rows: [{ metric: 'نرخ موفق', before: '۰٪', after: '۱۰۰٪', target: '≥۹۵٪', ok: true }] })!;
    expect(done.id).toBe(inc.id);
    expect(done.status).toBe('resolved');
    expect(done.closedAt).toBe(t);
    expect(done.verifications).toHaveLength(2);
    // a new problem after resolution opens a new incident
    expect(s.recordDiagnosis(diagnosis())!.id).not.toBe(inc.id);
  });

  it('verify without an open incident records nothing', () => {
    const s = new IncidentStore({ path: path() });
    expect(s.recordVerification('shop', { passed: true, rows: [] })).toBeUndefined();
  });

  it('can be closed by the user with a reason, and survives a restart', () => {
    const p = path();
    const s = new IncidentStore({ path: p, now: () => 5 });
    const inc = s.recordDiagnosis(diagnosis())!;
    s.close(inc.id, 'مشکل از سمت سرویس بیرونی بود');
    const reopened = new IncidentStore({ path: p }).get(inc.id)!;
    expect(reopened.status).toBe('closed');
    expect(reopened.events.at(-1)).toMatchObject({ kind: 'closed', text: expect.stringContaining('سرویس بیرونی') });
  });

  it('rates severity from the live probe', () => {
    const s = new IncidentStore({ path: path() });
    expect(s.recordDiagnosis(diagnosis({ app: 'a', probe: { url: 'u', okRatio: 1, p95: 3400 } }))!.severity).toBe('degraded');
    expect(s.recordDiagnosis(diagnosis({ app: 'b', verdict: 'unclear', root: undefined, probe: { url: 'u', okRatio: 1, p95: 100 } }))!.severity).toBe('unclear');
  });
});

describe('hypothesisLabel', () => {
  it('distinguishes confirmed, probable, inconclusive and rejected', () => {
    const d = diagnosis();
    expect(hypothesisLabel(d.root!, 'root')).toBe('علت تأییدشده');
    expect(hypothesisLabel({ ...d.root!, confidence: 0.6 }, 'root')).toBe('علت محتمل');
    expect(hypothesisLabel(d.inconclusive[0], 'inconclusive')).toBe('نامشخص');
    expect(hypothesisLabel(d.rejected[0], 'rejected')).toBe('رد شد');
  });
});

describe('renderIncidentReport', () => {
  it('writes a Persian report with cause, evidence, rejected causes, decisions and verification', () => {
    let t = 1_000_000;
    const s = new IncidentStore({ path: path(), now: () => t });
    s.recordDiagnosis(diagnosis());
    t += 1000;
    const inc = s.recordVerification('shop', { passed: true, rows: [{ metric: 'نرخ موفق', before: '۰٪', after: '۱۰۰٪', target: '≥۹۵٪', ok: true }] })!;
    const md = renderIncidentReport(inc, [
      { at: 1_000_500, tool: 'restart_app', outcome: 'rejected', approvedBy: 'user (dashboard)', detail: 'ری‌استارت کمکی نمی‌کند' },
      { at: 1_000_600, tool: 'set_env', outcome: 'executed', approvedBy: 'user (dashboard)' },
    ]);
    expect(md).toMatch(/# گزارش حادثه/);
    expect(md).toMatch(/DATABASE_URL/);
    expect(md).toMatch(/E1/);
    expect(md).toMatch(/نسخه‌ی بد/);
    expect(md).toMatch(/ری‌استارت کمکی نمی‌کند/);
    expect(md).toMatch(/۱۰۰٪/);
    expect(md).toMatch(/برطرف شد/);
  });
});
