import { describe, expect, it } from 'vitest';
import { defaultBundle, deployablePlans, planCatalog, recommendPlan, toBundleList, toPlanList } from './plan-advisor.js';

// Subset of the real `GET /v1/me` → plans.projectBundlePlans['small-g2'] (2026-10-22).
const BUNDLES = {
  free: { available: false, price: 0, displayPrice: 0, rollback: false, zeroDowntime: false, maxLogsRetention: 0.05, maxReleaseRetention: 1 },
  basic: { available: true, price: 381.94, displayPrice: 275000, rollback: true, zeroDowntime: false, maxLogsRetention: 7, maxReleaseRetention: 10 },
  standard: { available: true, price: 659.72, displayPrice: 475000, rollback: true, zeroDowntime: true, maxLogsRetention: 30, maxReleaseRetention: 10 },
  pro: { available: true, price: 1145.83, displayPrice: 825000, rollback: true, zeroDowntime: true, maxLogsRetention: 60, maxReleaseRetention: 10 },
};

describe('feature bundle plans', () => {
  it('lists the available bundles of a plan with their prices and features', () => {
    const list = toBundleList({ 'small-g2': BUNDLES }, 'small-g2');
    expect(list.map((b) => b.id)).toEqual(['basic', 'standard', 'pro']);
    expect(list[0]).toMatchObject({ id: 'basic', hourly: 381.94, monthly: 275000, rollback: true, zeroDowntime: false, logsDays: 7 });
    expect(toBundleList({}, 'small-g2')).toEqual([]);
  });

  it('defaults to the cheapest bundle that can roll back', () => {
    expect(defaultBundle(toBundleList({ 'small-g2': BUNDLES }, 'small-g2'))?.id).toBe('basic');
    const noRollback = { a: { available: true, price: 1, displayPrice: 720, rollback: false } };
    expect(defaultBundle(toBundleList({ 'x-g2': noRollback }, 'x-g2'))?.id).toBe('a');
    expect(defaultBundle([])).toBeUndefined();
  });

  it('recommends only g2 plans, like the Liara CLI (other plans need no bundle and are not offered)', () => {
    expect(deployablePlans(RAW).map((p) => p.id)).toEqual(['small-g2', 'medium-g2', 'standard-base-g2', 'standard-plus-g2']);
  });
});

describe('planCatalog', () => {
  const bundles = { 'small-g2': BUNDLES, 'medium-g2': BUNDLES };

  it('lists every plan a new app can be created on, with its feature plans, full price and whether it fits', () => {
    const c = planCatalog(RAW, bundles, 0.5);
    // older plans (ir-small) are listed by Liara, but its create endpoint only takes bundlePlanID
    // free/basic/standard/pro (real API 2026-10-22) and the CLI offers only g2 plans
    expect(c.map((p) => p.id)).toEqual(['small-g2', 'medium-g2', 'standard-base-g2', 'standard-plus-g2']);
    const small = c.find((p) => p.id === 'small-g2')!;
    expect(small).toMatchObject({ generation: 'g2', fits: true, defaultBundle: 'basic', totalMonthly: 750000 });
    expect(small.bundles.map((b) => b.id)).toEqual(['basic', 'standard', 'pro']);
    expect(c.some((p) => p.id === 'ir-small')).toBe(false);
  });

  it('marks plans with less memory than the project needs', () => {
    const c = planCatalog(RAW, bundles, 1);
    expect(c.find((p) => p.id === 'small-g2')?.fits).toBe(false);
    expect(c.find((p) => p.id === 'medium-g2')?.fits).toBe(true);
  });

  it('can leave out plans the account turned out not to be allowed to buy', () => {
    expect(planCatalog(RAW, bundles, 0.5, { blocked: ['g2'] })).toEqual([]);
    expect(planCatalog(RAW, bundles, 0.5, { blocked: ['small-g2'] }).some((p) => p.id === 'small-g2')).toBe(false);
  });
});

// Subset of the real `GET /v1/me` → plans.projects payload (2026-10-21).
const RAW = {
  free: { available: false, region: 'iran', price: 0, RAM: { amount: 0.125 }, CPU: { amount: 0.125 } },
  'ir-small': { available: true, region: 'iran', price: 1319.44, RAM: { amount: 0.5 }, CPU: { amount: 0.5 } },
  'mini-g2': { available: false, region: 'iran', displayPrice: 275000, price: 381.94, RAM: { amount: 0.25 }, CPU: { amount: 0.25 } },
  'small-g2': { available: true, region: 'iran', displayPrice: 475000, price: 659.72, RAM: { amount: 0.5 }, CPU: { amount: 0.5 } },
  'medium-g2': { available: true, region: 'iran', displayPrice: 825000, price: 1145.83, RAM: { amount: 1 }, CPU: { amount: 1 } },
  'standard-base-g2': { available: true, region: 'iran', displayPrice: 1475000, price: 2048.61, RAM: { amount: 2 }, CPU: { amount: 1 } },
  'standard-plus-g2': { available: true, region: 'iran', displayPrice: 2650000, price: 3680.55, RAM: { amount: 4 }, CPU: { amount: 2 } },
  'database-control-panel': { available: false, price: 0, RAM: { amount: 1 }, CPU: { amount: 0.5 } },
};

describe('toPlanList', () => {
  it('keeps only available app plans and computes the monthly price', () => {
    const plans = toPlanList(RAW);
    expect(plans.map((p) => p.id)).toEqual(['small-g2', 'medium-g2', 'ir-small', 'standard-base-g2', 'standard-plus-g2']);
    expect(plans.find((p) => p.id === 'small-g2')?.monthly).toBe(475000);
    // no displayPrice → hourly × 720
    expect(plans.find((p) => p.id === 'ir-small')?.monthly).toBe(950000);
  });
});

describe('recommendPlan', () => {
  const plans = toPlanList(RAW);

  it('picks the cheapest plan with enough RAM for a small node app', () => {
    const r = recommendPlan({ platform: 'node', dependencies: ['express'] }, plans);
    expect(r.plan.id).toBe('small-g2');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('gives next and django more memory', () => {
    expect(recommendPlan({ platform: 'next', dependencies: ['next'] }, plans).plan.id).toBe('medium-g2');
    expect(recommendPlan({ platform: 'django', dependencies: [] }, plans).plan.id).toBe('medium-g2');
  });

  it('bumps RAM for heavy dependencies and says why', () => {
    const r = recommendPlan({ platform: 'node', dependencies: ['express', 'puppeteer'] }, plans);
    expect(r.plan.id).toBe('standard-base-g2');
    expect(r.reasons.join(' ')).toContain('puppeteer');
  });

  it('sizes from observed memory when the app is already running', () => {
    // 0.9 GB used → needs ≥ 0.9 / 0.7 ≈ 1.29 GB
    const r = recommendPlan({ platform: 'node', dependencies: [], observedMemoryGB: 0.9 }, plans);
    expect(r.plan.id).toBe('standard-base-g2');
  });

  it('offers a bigger alternative', () => {
    const r = recommendPlan({ platform: 'node', dependencies: [] }, plans);
    expect(r.bigger?.id).toBe('medium-g2');
  });

  it('falls back to the biggest plan when nothing is big enough', () => {
    const r = recommendPlan({ platform: 'node', dependencies: [], observedMemoryGB: 50 }, plans);
    expect(r.plan.id).toBe('standard-plus-g2');
    expect(r.reasons.join(' ')).toMatch(/بزرگ‌ترین/);
  });
});
