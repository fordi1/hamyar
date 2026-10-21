import { describe, expect, it } from 'vitest';
import { normalizeLogs, normalizeSeries, normalizeReleases, normalizeEvents, toMs } from './collect.js';

describe('toMs', () => {
  it('accepts seconds, milliseconds and ISO strings', () => {
    expect(toMs(1704028315)).toBe(1704028315000);
    expect(toMs(1704028315000)).toBe(1704028315000);
    expect(toMs('2024-01-01T00:00:00.000Z')).toBe(Date.UTC(2024, 0, 1));
    expect(toMs('1704028315')).toBe(1704028315000);
  });
});

describe('normalizeLogs', () => {
  it('maps the documented Logs schema', () => {
    const logs = normalizeLogs([
      { type: 'stdout', datetime: '2026-10-21T10:00:00Z', message: 'GET / 200 5ms\n' },
      { type: 'stderr', datetime: '2026-10-21T10:00:01Z', message: '[error] boom' },
    ]);
    expect(logs).toEqual([
      { at: Date.parse('2026-10-21T10:00:00Z'), message: 'GET / 200 5ms', type: 'stdout' },
      { at: Date.parse('2026-10-21T10:00:01Z'), message: '[error] boom', type: 'stderr' },
    ]);
  });
});

describe('normalizeSeries', () => {
  it('takes the max across applets for each timestamp (Reports schema)', () => {
    const series = normalizeSeries({
      end: 0,
      result: [
        { applet: 'a', values: [[1700000000, '100'], [1700000060, '200']] },
        { applet: 'b', values: [[1700000000, '150']] },
      ],
    });
    expect(series).toEqual([
      { t: 1700000000000, v: 150 },
      { t: 1700000060000, v: 200 },
    ]);
  });

  it('returns an empty list on unexpected shapes', () => {
    expect(normalizeSeries(undefined)).toEqual([]);
    expect(normalizeSeries({ result: 'x' })).toEqual([]);
  });
});

describe('normalizeReleases', () => {
  it('sorts newest first and keeps state and port', () => {
    const r = normalizeReleases({
      currentRelease: 'r2',
      releases: [
        { _id: 'r1', state: 'READY', createdAt: '2026-10-21T09:00:00Z', port: 3000 },
        { _id: 'r2', state: 'READY', createdAt: '2026-10-21T10:00:00Z', port: 3000 },
      ],
    });
    expect(r.current).toBe('r2');
    expect(r.list.map((x) => x.id)).toEqual(['r2', 'r1']);
  });
});

describe('normalizeEvents', () => {
  it('flattens the events data/values structure into text lines', () => {
    const events = normalizeEvents({
      data: [{ metaData: { type: 'app' }, values: [['1704028315000000000', 'Container OOMKilled']] }],
    });
    expect(events[0].text).toContain('OOMKilled');
    expect(events[0].at).toBe(1704028315000);
  });
});
