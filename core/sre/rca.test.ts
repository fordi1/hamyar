import { describe, expect, it } from 'vitest';
import { buildBoard, boardToPrompt } from './rca.js';
import { runDetectors } from './detectors.js';
import { createRedactor } from '../redact.js';
import * as fx from './fixtures.js';

const board = (s: ReturnType<typeof fx.healthy>) => buildBoard(s, runDetectors(s));

describe('buildBoard root cause', () => {
  it.each([
    ['missingEnv', 'missing-env'],
    ['memoryLeak', 'memory'],
    ['slowNPlusOne', 'slow'],
    ['badRelease', 'bad-release'],
    ['portMismatch', 'port'],
    ['blockedRegistry', 'build'],
    ['appOff', 'app-off'],
  ] as const)('%s → %s', (scenario, expected) => {
    const b = board(fx[scenario]());
    expect(b.verdict).toBe('problem');
    expect(b.root?.id).toBe(expected);
  });

  it('reports a healthy app as healthy with rejected hypotheses', () => {
    const b = board(fx.healthy());
    expect(b.verdict).toBe('healthy');
    expect(b.root).toBeUndefined();
    expect(b.rejected.map((h) => h.id)).toEqual(expect.arrayContaining(['memory', 'cpu', 'slow']));
  });

  it('never makes a symptom the root cause', () => {
    const b = board(fx.missingEnv());
    expect(b.symptoms.map((h) => h.id)).toContain('http-errors');
    expect(b.root?.category).toBe('cause');
  });

  it('prefers the earlier cause when confidences are close', () => {
    const s = fx.badRelease();
    const hs = runDetectors(s);
    // fake a second, later, equally confident cause
    const later = { ...hs.find((h) => h.id === 'bad-release')!, id: 'cpu' as const, title: 'cpu', startedAt: s.collectedAt - 60_000 };
    const b = buildBoard(s, [...hs, later]);
    expect(b.root?.id).toBe('bad-release');
    expect(b.contributing.map((h) => h.id)).toContain('cpu');
  });
});

describe('evidence and fixes', () => {
  it('numbers every evidence item E1, E2, … across the board', () => {
    const b = board(fx.memoryLeak());
    const ids = b.evidence.map((e) => e.id);
    expect(ids[0]).toBe('E1');
    expect(new Set(ids).size).toBe(ids.length);
    expect(b.root?.supporting.every((e) => e.id?.startsWith('E'))).toBe(true);
  });

  it('lists the root cause fixes first', () => {
    const b = board(fx.badRelease());
    expect(b.fixes[0]).toMatchObject({ action: 'rollback', from: 'bad-release' });
  });

  it('carries the code location for the coding agent', () => {
    expect(board(fx.badRelease()).codeHint).toMatchObject({ file: 'server.js', line: 84 });
  });
});

describe('boardToPrompt', () => {
  it('cites evidence ids and masks secrets', () => {
    const s = fx.missingEnv();
    s.logs.push({ at: fx.NOW, message: 'connecting to postgres://shop:hunter2@db:5432/shop' });
    const b = buildBoard(s, runDetectors(s));
    const text = boardToPrompt(b, createRedactor());
    expect(text).toContain('E1');
    expect(text).toContain('missing-env');
    expect(text).not.toContain('hunter2');
  });
});
