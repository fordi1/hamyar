import { describe, expect, it } from 'vitest';
import { criteriaFor, evaluate, mergeProbes } from './verify.js';
import { summarizeProbe } from '../deployer.js';

const probeOf = (status: number, ms: number, n = 5) => summarizeProbe(Array.from({ length: n }, () => ({ status, ms })));

describe('criteriaFor', () => {
  it('asks a slow endpoint to get at least twice as fast and under 1 s', () => {
    const c = criteriaFor('slow', probeOf(200, 3400));
    expect(c.maxP95Ms).toBe(1000);
    expect(c.minOkRatio).toBe(0.95);
  });

  it('uses general health targets for error fixes', () => {
    expect(criteriaFor('missing-env', probeOf(500, 20))).toMatchObject({ minOkRatio: 0.95, maxP95Ms: 2000 });
  });
});

describe('evaluate', () => {
  it('passes when the fix brings success rate and latency within targets', () => {
    const r = evaluate(criteriaFor('missing-env'), probeOf(500, 20), probeOf(200, 40));
    expect(r.passed).toBe(true);
    expect(r.rows.map((x) => x.ok)).toEqual([true, true]);
    expect(r.rows[0]).toMatchObject({ before: '۰٪', after: '۱۰۰٪' });
  });

  it('fails and says which target was missed', () => {
    const r = evaluate(criteriaFor('slow', probeOf(200, 3400)), probeOf(200, 3400), probeOf(200, 1800));
    expect(r.passed).toBe(false);
    expect(r.rows.find((x) => !x.ok)?.metric).toMatch(/p95/);
  });
});

describe('mergeProbes', () => {
  it('combines several probe rounds into one summary', () => {
    const merged = mergeProbes([probeOf(200, 100, 2), probeOf(500, 100, 2)]);
    expect(merged.samples).toHaveLength(4);
    expect(merged.okRatio).toBe(0.5);
  });
});
