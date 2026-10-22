// Domain assistant (screen F): the real state of one domain (Liara, Liara DNS, public DNS)
// turned into ordered steps. Steps the user must do at the registrar are marked `manual`;
// Hamyar never claims they are done until public DNS shows it.
import { checkPublicDns, registrarHint, requiredRecords, splitDomain, type DnsRecord, type Resolver } from './domain.js';
import type { LiaraClient } from './liara-client.js';

export type DomainMethod = 'records' | 'liara-dns';
export type StepState = 'done' | 'current' | 'manual' | 'todo';
export type DomainTool = 'add_domain' | 'use_liara_dns' | 'create_dns_records' | 'enable_ssl';

export interface DomainStep {
  key: 'add' | 'records' | 'zone' | 'ns' | 'dns-records' | 'ssl';
  title: string;
  state: StepState;
  detail?: string;
}

export interface DomainStatus {
  domain: string;
  zone: string;
  apex: boolean;
  irnic: boolean;
  method: DomainMethod;
  onLiara: boolean;
  liaraStatus?: string;
  sslStatus?: string;
  records: (DnsRecord & { visible: boolean; found: string[] })[];
  nameservers: string[];
  liaraDns?: { status?: string; nameServers: string[]; active: boolean; missing: string[] };
  registrar: string;
  steps: DomainStep[];
  next?: { tool: DomainTool };
  notes: string[];
  ready: boolean;
}

export const validDomain = (d: string) => /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(d) && !d.includes('..');

export async function domainStatus(
  client: LiaraClient,
  app: string,
  domain: string,
  opts: { resolver?: Resolver; method?: DomainMethod } = {},
): Promise<DomainStatus> {
  const { zone, apex } = splitDomain(domain);
  const irnic = zone.endsWith('.ir');
  const [all, liaraZone] = await Promise.all([client.domains(app), client.dnsZone(zone).catch(() => undefined)]);
  const d = all.find((x: any) => x.name === domain);
  // an existing Liara DNS zone means that path was chosen; .ir domains default to it (IRNIC only changes nameservers)
  const method: DomainMethod = liaraZone ? 'liara-dns' : (opts.method ?? (irnic ? 'liara-dns' : 'records'));

  const check = d ? await client.checkDomain(d._id).catch(() => undefined) : undefined;
  const needed = d ? requiredRecords(domain, { CNameRecord: check?.domain?.CNameRecord ?? d.CNameRecord, verificationCode: check?.domain?.verificationCode }) : [];
  const pub = await checkPublicDns(domain, needed, opts.resolver, liaraZone?.nameServers);

  const sslActive = d?.certificatesStatus === 'ACTIVE';
  const nsActive = Boolean(liaraZone && (pub.usesExpectedNameservers || liaraZone.status === 'ACTIVE'));
  const existing = liaraZone && nsActive ? await client.dnsRecords(zone).catch(() => [] as any[]) : [];
  const missing = needed.filter((r) => !existing.some((e: any) => e.name === r.name && e.type === r.type)).map((r) => `${r.type} ${r.name}`);
  const recordsVisible = needed.length > 0 && pub.records.every((r) => r.visible);

  const steps: DomainStep[] = [{ key: 'add', title: 'اضافه شدن دامنه به برنامه در لیارا', state: d ? 'done' : 'current' }];
  let routed: boolean; // traffic reaches Liara: records visible, or Liara DNS serving the records
  if (method === 'records') {
    routed = recordsVisible;
    steps.push({
      key: 'records',
      title: 'ثبت رکوردها در پنل دامنه',
      state: !d ? 'todo' : recordsVisible ? 'done' : 'manual',
      detail: 'این مرحله را خودتان در پنل شرکت دامنه انجام دهید؛ همیار بعد از ثبت، از اینترنت بررسی می‌کند.',
    });
  } else {
    const recordsDone = nsActive && missing.length === 0 && needed.length > 0;
    routed = recordsDone;
    steps.push(
      { key: 'zone', title: 'ساخت ناحیه‌ی دامنه در DNS لیارا', state: liaraZone ? 'done' : d ? 'current' : 'todo' },
      {
        key: 'ns',
        title: irnic ? 'عوض کردن نیم‌سرورها در پنل ایرنیک' : 'عوض کردن نیم‌سرورها در پنل دامنه',
        state: nsActive ? 'done' : liaraZone ? 'manual' : 'todo',
        detail: 'این مرحله را خودتان انجام دهید. تغییر نیم‌سرور از چند دقیقه تا ۲۴ ساعت طول می‌کشد.',
      },
      { key: 'dns-records', title: 'ساخت رکوردهای لازم در DNS لیارا', state: recordsDone ? 'done' : nsActive && d ? 'current' : 'todo' },
    );
  }
  steps.push({ key: 'ssl', title: 'فعال‌سازی SSL (https)', state: sslActive ? 'done' : routed && d ? 'current' : 'todo' });

  const current = steps.find((s) => s.state === 'current');
  const TOOL: Partial<Record<DomainStep['key'], DomainTool>> = { add: 'add_domain', zone: 'use_liara_dns', 'dns-records': 'create_dns_records', ssl: 'enable_ssl' };
  // a manual step before the current one means the user acts first
  const blocked = steps.findIndex((s) => s.state === 'manual');
  const next = current && (blocked < 0 || steps.indexOf(current) < blocked) ? TOOL[current.key] : undefined;

  const notes: string[] = [];
  if (needed.some((r) => r.type === 'ALIAS')) notes.push('روی ریشه‌ی دامنه (@) بعضی پنل‌ها CNAME را قبول نمی‌کنند؛ از نوع ALIAS یا ANAME یا DNS لیارا استفاده کنید.');
  if (method === 'records' && irnic) notes.push('پنل ایرنیک فقط نیم‌سرور را عوض می‌کند و رکورد نمی‌پذیرد؛ برای دامنه‌ی .ir راه DNS لیارا ساده‌تر است.');

  return {
    domain,
    zone,
    apex,
    irnic,
    method,
    onLiara: Boolean(d),
    liaraStatus: check?.domain?.status ?? d?.status,
    sslStatus: d?.certificatesStatus,
    records: pub.records,
    nameservers: pub.nameservers,
    liaraDns: liaraZone ? { status: liaraZone.status, nameServers: liaraZone.nameServers ?? [], active: nsActive, missing } : undefined,
    registrar: registrarHint(domain),
    steps,
    next: next ? { tool: next } : undefined,
    notes,
    ready: steps.every((s) => s.state === 'done'),
  };
}
