import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plansText } from './ops.js';
import { Policy } from './policy.js';

const client = {
  balance: async () => 2_000_000,
  appPlans: async () => ({
    'small-g2': { available: true, RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, price: 659.72, displayPrice: 475000 },
    'ir-small': { available: true, RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, price: 1319.44 },
    'mini-g2': { available: false, RAM: { amount: 0.25 }, CPU: { amount: 0.25 }, price: 300 },
  }),
  bundlePlans: async () => ({
    'small-g2': {
      basic: { available: true, price: 381.94, displayPrice: 275000, rollback: true, zeroDowntime: false, maxLogsRetention: 7 },
      pro: { available: true, price: 1145.83, displayPrice: 825000, rollback: true, zeroDowntime: true, maxLogsRetention: 60 },
    },
  }),
} as any;

const ctx = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hamyar-ops-'));
  return { client, policy: new Policy({ mode: 'review', auditPath: join(dir, 'a.jsonl'), approvalsPath: join(dir, 'ap.json') }), boards: new Map() };
};

describe('plansText (list_plans)', () => {
  it('lists every plan the account can buy with feature plans and the full monthly price', async () => {
    const t = await plansText(ctx());
    expect(t).toMatch(/small-g2/);
    expect(t).toMatch(/basic/);
    expect(t).toMatch(/pro/);
    // 475,000 + 275,000 for the default feature plan
    expect(t).toMatch(/۷۵۰٬۰۰۰/);
    // older plans are not offered for new apps
    expect(t).not.toMatch(/ir-small/);
    expect(t).not.toMatch(/mini-g2/);
    expect(t).toMatch(/bundlePlanID/);
    expect(t).toMatch(/۲٬۰۰۰٬۰۰۰/);
  });
});
