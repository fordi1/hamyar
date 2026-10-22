import { describe, expect, it } from 'vitest';
import { domainStatus, validDomain } from './domain-assistant.js';
import type { Resolver } from './domain.js';

function resolver(map: { cname?: Record<string, string[]>; txt?: Record<string, string[][]>; ns?: Record<string, string[]> } = {}): Resolver {
  return {
    resolveCname: async (h) => map.cname?.[h] ?? [],
    resolveTxt: async (h) => map.txt?.[h] ?? [],
    resolveNs: async (h) => map.ns?.[h] ?? ['ns1.registrar.example', 'ns2.registrar.example'],
  };
}

function liara(o: { domain?: any; check?: any; zone?: any; records?: any[] } = {}) {
  return {
    domains: async () => (o.domain ? [o.domain] : []),
    checkDomain: async () => o.check ?? { domain: { status: 'PENDING', CNameRecord: 'shop.liara.run' } },
    dnsZone: async () => o.zone,
    dnsRecords: async () => o.records ?? [],
  } as any;
}

const stepStates = (s: Awaited<ReturnType<typeof domainStatus>>) => s.steps.map((x) => `${x.key}:${x.state}`);

describe('validDomain', () => {
  it('accepts real domain names only', () => {
    expect(validDomain('shop.example.ir')).toBe(true);
    expect(validDomain('example.co.ir')).toBe(true);
    expect(validDomain('localhost')).toBe(false);
    expect(validDomain('http://shop.ir')).toBe(false);
    expect(validDomain('a..ir')).toBe(false);
  });
});

describe('domainStatus', () => {
  it('starts with "add the domain to Liara" when it is not connected yet', async () => {
    const s = await domainStatus(liara(), 'shop', 'shop.ir', { resolver: resolver() });
    expect(s.onLiara).toBe(false);
    expect(s.next).toEqual({ tool: 'add_domain' });
    expect(s.steps[0]).toMatchObject({ key: 'add', state: 'current' });
    expect(s.irnic).toBe(true);
  });

  it('records method: shows the exact records and waits for them on public DNS', async () => {
    const s = await domainStatus(liara({ domain: { _id: 'd1', name: 'www.shop.com', status: 'PENDING' } }), 'shop', 'www.shop.com', { resolver: resolver(), method: 'records' });
    expect(s.records).toEqual([expect.objectContaining({ type: 'CNAME', name: 'www', value: 'shop.liara.run', visible: false })]);
    expect(stepStates(s)).toEqual(['add:done', 'records:manual', 'ssl:todo']);
    expect(s.next).toBeUndefined();
  });

  it('records method: once visible, SSL becomes the next step', async () => {
    const r = resolver({ cname: { 'www.shop.com': ['shop.liara.run.'] } });
    const s = await domainStatus(liara({ domain: { _id: 'd1', name: 'www.shop.com', status: 'OK' } }), 'shop', 'www.shop.com', { resolver: r, method: 'records' });
    expect(stepStates(s)).toEqual(['add:done', 'records:done', 'ssl:current']);
    expect(s.next).toEqual({ tool: 'enable_ssl' });
  });

  it('Liara DNS method: zone, nameserver change at the registrar, records, then SSL', async () => {
    const domain = { _id: 'd1', name: 'shop.ir', status: 'PENDING' };
    const noZone = await domainStatus(liara({ domain }), 'shop', 'shop.ir', { resolver: resolver(), method: 'liara-dns' });
    expect(stepStates(noZone)).toEqual(['add:done', 'zone:current', 'ns:todo', 'dns-records:todo', 'ssl:todo']);
    expect(noZone.next).toEqual({ tool: 'use_liara_dns' });

    const zone = { name: 'shop.ir', status: 'PENDING', nameServers: ['ns1.liara.ir', 'ns2.liara.ir'] };
    const waitingNs = await domainStatus(liara({ domain, zone }), 'shop', 'shop.ir', { resolver: resolver() });
    expect(waitingNs.method).toBe('liara-dns');
    expect(stepStates(waitingNs)).toEqual(['add:done', 'zone:done', 'ns:manual', 'dns-records:todo', 'ssl:todo']);
    expect(waitingNs.liaraDns?.nameServers).toEqual(['ns1.liara.ir', 'ns2.liara.ir']);

    const nsOk = resolver({ ns: { 'shop.ir': ['ns1.liara.ir.', 'ns2.liara.ir.'] } });
    const needRecords = await domainStatus(liara({ domain, zone }), 'shop', 'shop.ir', { resolver: nsOk });
    expect(stepStates(needRecords)).toEqual(['add:done', 'zone:done', 'ns:done', 'dns-records:current', 'ssl:todo']);
    expect(needRecords.next).toEqual({ tool: 'create_dns_records' });

    const done = await domainStatus(liara({ domain: { ...domain, certificatesStatus: 'ACTIVE' }, zone, records: [{ name: '@', type: 'ALIAS' }] }), 'shop', 'shop.ir', { resolver: nsOk });
    expect(stepStates(done)).toEqual(['add:done', 'zone:done', 'ns:done', 'dns-records:done', 'ssl:done']);
    expect(done.next).toBeUndefined();
    expect(done.ready).toBe(true);
  });

  it('uses ALIAS for the apex and tells the user why', async () => {
    const s = await domainStatus(liara({ domain: { _id: 'd1', name: 'shop.com' } }), 'shop', 'shop.com', { resolver: resolver(), method: 'records' });
    expect(s.records[0].type).toBe('ALIAS');
    expect(s.notes.join(' ')).toMatch(/ALIAS/);
  });
});
