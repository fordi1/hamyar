import { describe, expect, it } from 'vitest';
import { renderPostmortem } from './postmortem.js';
import { buildBoard } from './rca.js';
import { runDetectors } from './detectors.js';
import { evaluate, criteriaFor } from './verify.js';
import { summarizeProbe } from '../deployer.js';
import * as fx from './fixtures.js';

describe('renderPostmortem', () => {
  const s = fx.missingEnv();
  const board = buildBoard(s, runDetectors(s));
  const before = summarizeProbe([{ status: 500, ms: 20 }]);
  const after = summarizeProbe([{ status: 200, ms: 40 }]);
  const md = renderPostmortem({
    board,
    actions: [{ at: fx.NOW + 60_000, action: 'set_env', tier: 'T2', title: 'تنظیم متغیر DATABASE_URL روی لیارا', approvedBy: 'user', result: 'ok' }],
    verify: evaluate(criteriaFor('missing-env'), before, after),
  });

  it('has the root cause with cited evidence', () => {
    expect(md).toContain('متغیر محیطی DATABASE_URL تنظیم نشده');
    expect(md).toMatch(/E\d/);
  });

  it('lists the approved actions and the before/after table', () => {
    expect(md).toContain('تأیید');
    expect(md).toContain('| درخواست‌های موفق |');
    expect(md).toContain('✅');
  });

  it('lists rejected hypotheses', () => {
    expect(md).toContain('رد شد');
  });
});
