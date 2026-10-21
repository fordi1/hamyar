import { describe, expect, it } from 'vitest';
import { runDetectors, type Hypothesis } from './detectors.js';
import * as fx from './fixtures.js';

const byId = (hs: Hypothesis[]) => Object.fromEntries(hs.map((h) => [h.id, h]));

describe('healthy app', () => {
  it('validates nothing', () => {
    const hs = runDetectors(fx.healthy());
    expect(hs.filter((h) => h.status === 'validated')).toEqual([]);
  });

  it('actively rules out memory, cpu and slowness with evidence', () => {
    const h = byId(runDetectors(fx.healthy()));
    expect(h['memory'].status).toBe('invalidated');
    expect(h['cpu'].status).toBe('invalidated');
    expect(h['slow'].status).toBe('invalidated');
    expect(h['memory'].contradicting.length).toBeGreaterThan(0);
  });
});

describe('missing env var', () => {
  const h = byId(runDetectors(fx.missingEnv()));

  it('validates missing-env and names the variable', () => {
    expect(h['missing-env'].status).toBe('validated');
    expect(h['missing-env'].title).toContain('DATABASE_URL');
    expect(h['missing-env'].confidence).toBeGreaterThan(0.8);
  });

  it('proposes setting the variable as an approval-gated fix', () => {
    const fix = h['missing-env'].fixes[0];
    expect(fix.action).toBe('set_env');
    expect(fix.tier).toBe('T2');
    expect(fix.args).toEqual({ key: 'DATABASE_URL' });
  });

  it('points at the code location', () => {
    expect(h['missing-env'].codeHint?.file).toBe('server.js');
    expect(h['missing-env'].codeHint?.line).toBe(39);
  });

  it('treats the 500s as a symptom', () => {
    expect(h['http-errors'].category).toBe('symptom');
  });
});

describe('memory leak', () => {
  const h = byId(runDetectors(fx.memoryLeak()));

  it('validates memory with the OOM event and the growth trend', () => {
    expect(h['memory'].status).toBe('validated');
    expect(h['memory'].title).toMatch(/نشت حافظه/);
    const text = h['memory'].supporting.map((e) => e.summary).join(' ');
    expect(text).toMatch(/OOM/);
  });

  it('offers restart now, a bigger plan, and a code fix', () => {
    const actions = h['memory'].fixes.map((f) => f.action);
    expect(actions).toEqual(expect.arrayContaining(['restart', 'resize', 'code_fix']));
    expect(h['memory'].fixes.find((f) => f.action === 'resize')?.args).toEqual({ planID: 'medium-g2' });
  });

  it('rules out CPU', () => {
    expect(h['cpu'].status).toBe('invalidated');
  });
});

describe('slow endpoint with N+1 queries', () => {
  const h = byId(runDetectors(fx.slowNPlusOne()));

  it('validates slowness and spots the repeated query', () => {
    expect(h['slow'].status).toBe('validated');
    const text = h['slow'].supporting.map((e) => e.summary).join(' ');
    expect(text).toMatch(/N\+1/);
    expect(text).toContain('/products');
  });

  it('suggests a code fix, not a bigger plan, because CPU and RAM are fine', () => {
    expect(h['slow'].fixes[0].action).toBe('code_fix');
    expect(h['cpu'].status).toBe('invalidated');
    expect(h['memory'].status).toBe('invalidated');
  });
});

describe('bad release', () => {
  const h = byId(runDetectors(fx.badRelease()));

  it('validates bad-release and offers rollback to the previous release', () => {
    expect(h['bad-release'].status).toBe('validated');
    const fix = h['bad-release'].fixes.find((f) => f.action === 'rollback');
    expect(fix?.args).toEqual({ releaseID: 'r2' });
    expect(fix?.tier).toBe('T2');
  });

  it('gives the stack location of the new error', () => {
    expect(h['http-errors'].codeHint).toMatchObject({ file: 'server.js', line: 84 });
  });

  it('does not blame a missing env var', () => {
    expect(h['missing-env']?.status ?? 'invalidated').not.toBe('validated');
  });
});

describe('other causes', () => {
  it('detects a port mismatch', () => {
    const h = byId(runDetectors(fx.portMismatch()));
    expect(h['port'].status).toBe('validated');
    expect(h['port'].title).toContain('8080');
  });

  it('detects a blocked package registry during build', () => {
    const h = byId(runDetectors(fx.blockedRegistry()));
    expect(h['build'].status).toBe('validated');
    expect(h['build'].title).toMatch(/مسدود/);
    expect(h['build'].fixes[0].action).toBe('build_location');
  });

  it('detects an app that is turned off', () => {
    const h = byId(runDetectors(fx.appOff()));
    expect(h['app-off'].status).toBe('validated');
    expect(h['app-off'].fixes[0]).toMatchObject({ action: 'turn_on', tier: 'T1' });
  });
});
