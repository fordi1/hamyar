import { describe, expect, it } from 'vitest';
import { clusterLogs, templateOf } from './cluster.js';

describe('templateOf', () => {
  it('replaces numbers, ids and quoted values with placeholders', () => {
    expect(templateOf('[db] SELECT * FROM prices WHERE product_id = 17')).toBe('[db] SELECT * FROM prices WHERE product_id = <n>');
    expect(templateOf('GET /products 200 3376ms')).toBe('GET /products <n> <n>ms');
    expect(templateOf('user 6f1c2e9a-1b2c-4d5e-8f90-123456789abc logged in')).toBe('user <id> logged in');
    expect(templateOf('release 65a1f0c2b3d4e5f6a7b8c9d0 failed')).toBe('release <id> failed');
  });
});

describe('clusterLogs', () => {
  it('groups lines by template, counts them and keeps samples, biggest first', () => {
    const logs = [
      { at: 1000, message: '[db] SELECT * FROM prices WHERE product_id = 1' },
      { at: 2000, message: '[db] SELECT * FROM prices WHERE product_id = 2' },
      { at: 3000, message: '[db] SELECT * FROM prices WHERE product_id = 3' },
      { at: 4000, message: 'Broken Shop listening on port 3000' },
    ];
    const clusters = clusterLogs(logs);
    expect(clusters[0]).toMatchObject({ count: 3, firstAt: 1000, lastAt: 3000 });
    expect(clusters[0].samples).toHaveLength(2);
    expect(clusters[1].count).toBe(1);
  });

  it('marks error clusters', () => {
    const clusters = clusterLogs([
      { at: 1, message: '[error] GET /: Error: DATABASE_URL is not set' },
      { at: 2, message: 'GET / 200 5ms' },
    ]);
    expect(clusters.find((c) => c.template.includes('DATABASE_URL'))?.isError).toBe(true);
    expect(clusters.find((c) => c.template.startsWith('GET'))?.isError).toBe(false);
  });
});
