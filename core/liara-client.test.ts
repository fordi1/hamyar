import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiaraClient } from './liara-client.js';

// /v1/billing as Liara returns it when a teamID is sent: both the personal and the team balance.
const billing = { user: { balance: 0, minCreditAmount: 20000 }, team: { balance: 2_000_000, minCreditAmount: 20000 } };

function stubFetch(body: unknown) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe('LiaraClient errors', () => {
  it('explains in Persian when Liara will not create an app on a g2 plan for this account', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ statusCode: 400, message: 'g2_plan_unavailable' }), { status: 400 }));
    const c = new LiaraClient({ token: 't', teamId: 'team1' });
    await expect(c.createApp({ name: 'shop', planID: 'small-g2', platform: 'node', bundlePlanID: 'basic' })).rejects.toMatchObject({
      explanation: expect.stringMatching(/g2.*پلن دیگر/),
    });
  });
});

describe('LiaraClient.uploadSource', () => {
  it('sends the archive as application/gzip (Liara refuses an untyped file: "Allowed types: gzip, zip")', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'hamyar-up-')), 'source.tar.gz');
    writeFileSync(path, 'x');
    let sent: FormData | undefined;
    vi.stubGlobal('fetch', async (_url: URL, init: any) => {
      sent = init.body;
      return new Response(JSON.stringify({ sourceID: 's1' }), { status: 200 });
    });
    expect(await new LiaraClient({ token: 't' }).uploadSource('shop', path)).toBe('s1');
    const file = sent?.get('file') as File;
    expect(file.type).toBe('application/gzip');
    expect(file.name).toBe('source.tar.gz');
  });
});

describe('LiaraClient.logs', () => {
  it('reads the v2 logs endpoint the CLI uses and flattens it to {type, datetime, message}', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          data: [
            { metaData: { releaseId: 'r1' }, values: [['1792665454463000000', JSON.stringify({ _entry: 'GET /health 200 3ms', type: 'stdout' })]] },
            { metaData: { releaseId: 'r1' }, values: [['1792665455000000000', JSON.stringify({ _entry: 'Error: boom', type: 'stderr' })], ['1792665456000000000', 'plain text line']] },
          ],
        }),
        { status: 200 },
      );
    });
    const lines = await new LiaraClient({ token: 't' }).logs('shop', 1792665000);
    expect(urls[0]).toContain('/v2/projects/shop/logs');
    expect(urls[0]).toContain('start=1792665000');
    expect(urls[0]).toContain('direction=forward');
    expect(lines).toEqual([
      { type: 'stdout', datetime: new Date(1792665454463).toISOString(), message: 'GET /health 200 3ms' },
      { type: 'stderr', datetime: new Date(1792665455000).toISOString(), message: 'Error: boom' },
      { type: 'stdout', datetime: new Date(1792665456000).toISOString(), message: 'plain text line' },
    ]);
  });
});

describe('LiaraClient.logs paging', () => {
  it('keeps reading from the last line until a short page, without duplicating the boundary second', async () => {
    const starts: string[] = [];
    // nanosecond timestamps as Liara sends them (19 digits)
    const page = (fromSec: number, n: number) =>
      Array.from({ length: n }, (_, i) => [`${fromSec + Math.floor(i / 2)}00000000${i % 2}`, JSON.stringify({ _entry: `line ${fromSec}-${i}`, type: 'stdout' })]);
    vi.stubGlobal('fetch', async (url: URL) => {
      const start = Number(new URL(String(url)).searchParams.get('start'));
      starts.push(String(start));
      // 100 lines per page, the third page is short
      const T = 1792665000;
      const values = start === T ? page(T, 100) : start === T + 49 ? page(T + 49, 100) : page(start, 7);
      return new Response(JSON.stringify({ data: [{ metaData: {}, values }] }), { status: 200 });
    });
    const lines = await new LiaraClient({ token: 't' }).logs('shop', 1792665000);
    expect(starts).toEqual(['1792665000', '1792665049', '1792665098']);
    // no line twice, and the newest page is included
    expect(new Set(lines.map((l) => l.message)).size).toBe(lines.length);
    expect(lines.at(-1)?.message).toBe('line 1792665098-6');
  });
});

describe('LiaraClient.balance', () => {
  it('uses the team balance when working for a team (that is what pays for team apps)', async () => {
    const urls = stubFetch(billing);
    const c = new LiaraClient({ token: 't', teamId: 'team1' });
    expect(await c.balance()).toBe(2_000_000);
    expect(urls[0]).toContain('teamID=team1');
  });

  it('uses the personal balance without a team', async () => {
    stubFetch({ user: { balance: 150_000 } });
    expect(await new LiaraClient({ token: 't' }).balance()).toBe(150_000);
  });

  it('falls back to 0 when the field is missing', async () => {
    stubFetch({});
    expect(await new LiaraClient({ token: 't', teamId: 'team1' }).balance()).toBe(0);
  });
});
