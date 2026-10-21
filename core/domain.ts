// Domain setup: which DNS records the user needs, where to set them (IRNIC or
// another registrar), and whether they are already visible on the public internet.
import { promises as dnsPromises } from 'node:dns';

export interface DnsRecord {
  type: 'ALIAS' | 'CNAME' | 'TXT';
  name: string;
  value: string;
  purpose: string;
}

// Second-level public suffixes common for Iranian and other users.
const TWO_LEVEL_TLDS = new Set(['co.ir', 'ac.ir', 'org.ir', 'id.ir', 'gov.ir', 'sch.ir', 'net.ir', 'co.uk', 'org.uk', 'com.tr', 'com.au']);

export function splitDomain(domain: string): { zone: string; name: string; apex: boolean } {
  const parts = domain.toLowerCase().replace(/\.$/, '').split('.');
  const suffixLen = TWO_LEVEL_TLDS.has(parts.slice(-2).join('.')) ? 3 : 2;
  const zone = parts.slice(-suffixLen).join('.');
  const name = parts.slice(0, -suffixLen).join('.') || '@';
  return { zone, name, apex: name === '@' };
}

// Built from Liara's `GET /v1/domains/{id}/check` response (CNameRecord, verificationCode).
export function requiredRecords(domain: string, check: { CNameRecord?: string; verificationCode?: string }): DnsRecord[] {
  const { name, apex } = splitDomain(domain);
  const records: DnsRecord[] = [];
  if (check.CNameRecord) {
    records.push({
      type: apex ? 'ALIAS' : 'CNAME',
      name,
      value: check.CNameRecord,
      purpose: 'هدایت دامنه به برنامه در لیارا',
    });
  }
  if (check.verificationCode) {
    records.push({ type: 'TXT', name, value: check.verificationCode, purpose: 'تأیید مالکیت دامنه برای لیارا' });
  }
  return records;
}

export function registrarHint(domain: string): string {
  const { zone } = splitDomain(domain);
  return zone.endsWith('.ir')
    ? 'دامنه‌های .ir در پنل ایرنیک (nic.ir) مدیریت می‌شوند: وارد nic.ir شوید ← دامنه‌ها ← ' + zone + ' ← تغییر سرورهای نام (DNS).'
    : 'وارد پنل شرکتی شوید که دامنه را از آن خریده‌اید و بخش DNS یا Nameservers را باز کنید.';
}

export interface Resolver {
  resolveCname(host: string): Promise<string[]>;
  resolveTxt(host: string): Promise<string[][]>;
  resolveNs(host: string): Promise<string[]>;
}

export interface PublicDnsResult {
  records: (DnsRecord & { visible: boolean; found: string[] })[];
  nameservers: string[];
  usesExpectedNameservers?: boolean;
}

const clean = (s: string) => s.toLowerCase().replace(/\.$/, '');

// Uses public resolvers so the answer matches what visitors see, not a local cache.
export function publicResolver(): Resolver {
  const r = new dnsPromises.Resolver({ timeout: 4000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return r;
}

export async function checkPublicDns(domain: string, records: DnsRecord[], resolver: Resolver = publicResolver(), expectedNameservers?: string[]): Promise<PublicDnsResult> {
  const { zone } = splitDomain(domain);
  const fqdn = (name: string) => (name === '@' ? zone : `${name}.${zone}`);
  const safe = async <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

  const checked = await Promise.all(records.map(async (rec) => {
    const host = fqdn(rec.name);
    let found: string[] = [];
    if (rec.type === 'TXT') found = (await safe(resolver.resolveTxt(host), [] as string[][])).map((t) => t.join(''));
    // ALIAS is flattened by the DNS provider, so a public lookup may return A records only; CNAME is checked directly.
    else found = await safe(resolver.resolveCname(host), [] as string[]);
    const visible = found.some((f) => clean(f) === clean(rec.value));
    return { ...rec, visible, found };
  }));

  const nameservers = (await safe(resolver.resolveNs(zone), [] as string[])).map(clean).sort();
  const result: PublicDnsResult = { records: checked, nameservers };
  if (expectedNameservers?.length) {
    const want = new Set(expectedNameservers.map(clean));
    result.usesExpectedNameservers = nameservers.length > 0 && nameservers.every((n) => want.has(n));
  }
  return result;
}
