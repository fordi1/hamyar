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
