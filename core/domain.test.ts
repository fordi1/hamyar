import { describe, expect, it } from 'vitest';
import { requiredRecords, registrarHint, splitDomain, checkPublicDns, type Resolver } from './domain.js';

describe('splitDomain', () => {
  it('separates the record name from the zone, including two-level TLDs', () => {
    expect(splitDomain('shop.ir')).toEqual({ zone: 'shop.ir', name: '@', apex: true });
    expect(splitDomain('www.shop.ir')).toEqual({ zone: 'shop.ir', name: 'www', apex: false });
    expect(splitDomain('api.shop.co.ir')).toEqual({ zone: 'shop.co.ir', name: 'api', apex: false });
    expect(splitDomain('shop.co.uk')).toEqual({ zone: 'shop.co.uk', name: '@', apex: true });
  });
});

describe('requiredRecords', () => {
  it('uses ALIAS on the apex and CNAME on a subdomain, pointing at the Liara target', () => {
    expect(requiredRecords('shop.ir', { CNameRecord: 'broken-shop.liara.run' })[0]).toMatchObject({ type: 'ALIAS', name: '@', value: 'broken-shop.liara.run' });
    expect(requiredRecords('www.shop.ir', { CNameRecord: 'broken-shop.liara.run' })[0]).toMatchObject({ type: 'CNAME', name: 'www', value: 'broken-shop.liara.run' });
  });

  it('adds the ownership TXT record when Liara returns a verification code', () => {
    const records = requiredRecords('shop.ir', { CNameRecord: 'x.liara.run', verificationCode: 'liara-verify-123' });
    expect(records.find((r) => r.type === 'TXT')).toMatchObject({ value: 'liara-verify-123' });
  });
});

describe('registrarHint', () => {
  it('points .ir domains to the IRNIC panel', () => {
    expect(registrarHint('shop.ir')).toMatch(/nic\.ir/);
    expect(registrarHint('shop.com')).not.toMatch(/nic\.ir/);
  });
});

describe('checkPublicDns', () => {
  const resolver = (data: Partial<Record<keyof Resolver, Record<string, any>>>): Resolver => ({
    resolveCname: async (h) => { const v = data.resolveCname?.[h]; if (!v) throw Object.assign(new Error('x'), { code: 'ENODATA' }); return v; },
    resolveTxt: async (h) => { const v = data.resolveTxt?.[h]; if (!v) throw Object.assign(new Error('x'), { code: 'ENODATA' }); return v; },
    resolveNs: async (h) => { const v = data.resolveNs?.[h]; if (!v) throw Object.assign(new Error('x'), { code: 'ENODATA' }); return v; },
  });

  it('marks a CNAME as visible when it points at the expected target', async () => {
    const records = requiredRecords('www.shop.ir', { CNameRecord: 'broken-shop.liara.run' });
    const result = await checkPublicDns('www.shop.ir', records, resolver({ resolveCname: { 'www.shop.ir': ['broken-shop.liara.run'] } }));
    expect(result.records[0].visible).toBe(true);
  });

  it('reports a wrong target and the current nameservers', async () => {
    const records = requiredRecords('www.shop.ir', { CNameRecord: 'broken-shop.liara.run' });
    const result = await checkPublicDns('www.shop.ir', records, resolver({
      resolveCname: { 'www.shop.ir': ['old-host.example.com'] },
      resolveNs: { 'shop.ir': ['ns1.registrar.ir', 'ns2.registrar.ir'] },
    }));
    expect(result.records[0]).toMatchObject({ visible: false, found: ['old-host.example.com'] });
    expect(result.nameservers).toEqual(['ns1.registrar.ir', 'ns2.registrar.ir']);
  });

  it('detects that the zone already uses Liara nameservers', async () => {
    const result = await checkPublicDns('shop.ir', [], resolver({ resolveNs: { 'shop.ir': ['ns1.liara.ir', 'ns2.liara.ir'] } }), ['ns1.liara.ir', 'ns2.liara.ir']);
    expect(result.usesExpectedNameservers).toBe(true);
  });
});
