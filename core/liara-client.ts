// Thin typed wrapper around the Liara REST API (https://developers.liara.ir).
// Rules: reads are retried, writes are never retried blindly; every failure carries a
// Persian explanation the agent can show to the user as-is.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export class LiaraError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: any,
    public explanation: string,
  ) {
    super(`Liara API ${status} on ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

export interface ClientOptions {
  token: string;
  teamId?: string;
  base?: string;
  timeoutMs?: number;
}

type Query = Record<string, string | number | undefined>;

function explain(status: number, body: any): string {
  const message: string = body?.message ?? body?.error?.message ?? '';
  if (status === 401) return 'کلید API لیارا نامعتبر یا منقضی است؛ از منوی API کنسول یک کلید جدید بسازید.';
  if (status === 403) return 'این کلید اجازه‌ی انجام این کار را ندارد.';
  if (status === 404) return 'برنامه یا منبع موردنظر در لیارا پیدا نشد؛ نام برنامه را بررسی کنید.';
  if (status === 409) return 'این نام قبلاً استفاده شده یا عملیات دیگری در حال انجام است.';
  if (message === 'g2_plan_unavailable')
    return 'لیارا ساخت برنامه روی پلن‌های نسل جدید (g2) را برای این حساب یا تیم فعال نکرده است. یک پلن دیگر انتخاب کنید یا از پشتیبانی لیارا بپرسید چرا g2 برای حساب شما بسته است.';
  if (message === 'frozen_project' || /balance|credit/i.test(message))
    return 'موجودی حساب لیارا کافی نیست؛ لطفاً حساب را از کنسول شارژ کنید.';
  if (status === 429) return 'تعداد درخواست‌ها زیاد شده؛ چند ثانیه صبر کنید.';
  if (status >= 500) return 'سرویس لیارا موقتاً خطا داد؛ کمی بعد دوباره امتحان می‌کنیم.';
  return message ? `لیارا خطا داد: ${message}` : `لیارا خطای ${status} داد.`;
}

export class LiaraClient {
  private base: string;
  private timeoutMs: number;

  constructor(private opts: ClientOptions) {
    if (!opts.token) throw new Error('LIARA_API_TOKEN is not set');
    this.base = opts.base ?? 'https://api.liara.ir';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  static fromEnv(): LiaraClient {
    return new LiaraClient({
      token: process.env.LIARA_API_TOKEN ?? '',
      teamId: process.env.LIARA_TEAM_ID || undefined,
      base: process.env.LIARA_API_BASE || undefined,
    });
  }

  private url(path: string, query: Query = {}, base = this.base): URL {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    if (this.opts.teamId) url.searchParams.set('teamID', this.opts.teamId);
    return url;
  }

  private async request<T>(method: string, path: string, init: { query?: Query; json?: unknown; form?: FormData; timeoutMs?: number; base?: string } = {}): Promise<T> {
    const isRead = method === 'GET';
    const attempts = isRead ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(this.url(path, init.query, init.base), {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
          signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
        });
        const text = await res.text();
        let body: any = text;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {}
        if (res.ok) return body as T;
        const error = new LiaraError(res.status, path, body, explain(res.status, body));
        if (!isRead || res.status < 500) throw error;
        lastError = error;
      } catch (err) {
        if (err instanceof LiaraError && (err.status < 500 || !isRead)) throw err;
        lastError = err;
        if (!isRead) break;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    if (lastError instanceof LiaraError) throw lastError;
    throw new LiaraError(0, path, String(lastError), 'اتصال به لیارا برقرار نشد؛ اینترنت یا فیلترشکن را بررسی کنید.');
  }

  // ---------- account ----------
  me() {
    return this.request<any>('GET', '/v1/me');
  }
  async balance(): Promise<number> {
    const r = await this.request<any>('GET', '/v1/billing');
    // with a teamID Liara returns both; team apps are paid from the team balance
    return (this.opts.teamId ? r.team?.balance : undefined) ?? r.user?.balance ?? 0;
  }
  async appPlans(): Promise<Record<string, any>> {
    return (await this.me()).plans?.projects ?? {};
  }
  // feature plans per app plan; g2 apps cannot be created without one (`g2_plan_unavailable`)
  async bundlePlans(): Promise<Record<string, any>> {
    return (await this.me()).plans?.projectBundlePlans ?? {};
  }

  // ---------- apps ----------
  async listApps(): Promise<any[]> {
    return (await this.request<any>('GET', '/v1/projects')).projects ?? [];
  }
  async getApp(name: string): Promise<any> {
    return (await this.request<any>('GET', `/v1/projects/${name}`)).project;
  }
  // private networks: Liara requires one when creating an app (`network_is_required`); apps and
  // databases on the same network reach each other privately
  async networks(): Promise<{ _id: string; name: string }[]> {
    return (await this.request<any>('GET', '/v1/networks')).networks ?? [];
  }
  createNetwork(name: string) {
    return this.request<any>('POST', '/v1/networks', { json: { networkName: name } });
  }
  createApp(body: { name: string; planID: string; platform: string; bundlePlanID?: string; network?: string; readOnlyRootFilesystem?: boolean }) {
    return this.request<any>('POST', '/v1/projects', { json: body });
  }
  restart(name: string) {
    return this.request<any>('POST', `/v1/projects/${name}/actions/restart`);
  }
  scale(name: string, scale: 0 | 1) {
    return this.request<any>('POST', `/v1/projects/${name}/actions/scale`, { json: { scale } });
  }
  resize(name: string, planID: string) {
    return this.request<any>('POST', `/v1/projects/${name}/resize`, { json: { planID } });
  }
  // Replaces the WHOLE env set: callers must merge with the current envs first.
  updateEnvs(project: string, variables: { key: string; value: string }[]) {
    return this.request<any>('POST', '/v1/projects/update-envs', { json: { project, variables } });
  }
  setZeroDowntime(appId: string, enabled: boolean) {
    return this.request<any>('POST', `/v1/projects/${appId}/zero-downtime/${enabled ? 'enable' : 'disable'}`);
  }

  // ---------- deploy ----------
  async uploadSource(name: string, archivePath: string): Promise<string> {
    const form = new FormData();
    // typed like the CLI's form-data upload; an untyped part is refused ("Allowed types: gzip, zip")
    form.append('file', new Blob([readFileSync(archivePath)], { type: 'application/gzip' }), basename(archivePath));
    const r = await this.request<{ sourceID: string }>('POST', `/v2/projects/${name}/sources`, { form, timeoutMs: 10 * 60_000 });
    return r.sourceID;
  }
  // Body mirrors what `liara deploy` sends (Liara CLI src/commands/deploy.ts).
  async createRelease(name: string, body: { sourceID: string; port: number; type: string; message?: string; healthCheck?: unknown; build?: unknown; envs?: unknown }): Promise<string> {
    const r = await this.request<{ releaseID: string }>('POST', `/v2/projects/${name}/releases`, { json: body });
    return r.releaseID;
  }
  // Undocumented in the OpenAPI spec but used by the official CLI.
  async getRelease(releaseID: string): Promise<any> {
    return (await this.request<any>('GET', `/v1/releases/${releaseID}`)).release;
  }
  buildLogs(releaseID: string, since?: string): Promise<{ release: any; buildOutput: { line: string; stream: string; createdAt: string }[] }> {
    return this.request('GET', `/v2/releases/${releaseID}/build-logs`, { query: { since } });
  }
  releases(name: string, count = 10) {
    return this.request<any>('GET', `/v1/projects/${name}/releases`, { query: { page: 1, count } });
  }
  // Not in the official OpenAPI spec; path used by community tools. Verified on first real use.
  rollback(name: string, releaseID: string) {
    return this.request<any>('POST', `/v2/projects/${name}/releases/${releaseID}/rollback`);
  }

  // ---------- observability ----------
  // The v1 endpoint now only answers "Please upgrade your client"; this is what `liara logs`
  // reads (CLI src/commands/app/logs.ts): {data: [{metaData, values: [[ns timestamp, line]]}]},
  // each line JSON with `_entry` and `type`.
  // Pages are capped (100 lines counted forward from `start`), so like the CLI we keep reading
  // from the last line's second until a short page; the boundary second is de-duplicated.
  async logs(name: string, sinceUnix: number, maxPages = 30): Promise<{ type: string; datetime: string; message: string }[]> {
    const out: { type: string; datetime: string; message: string }[] = [];
    const seen = new Set<string>();
    let start = sinceUnix;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      const r = await this.request<any>('GET', `/v2/projects/${name}/logs`, { query: { start, direction: 'forward' } });
      let count = 0;
      let lastSec = start;
      for (const stream of r?.data ?? []) {
        for (const [ts, line] of stream?.values ?? []) {
          count++;
          const stamp = String(ts);
          const ms = stamp.length >= 13 ? Number(stamp.slice(0, 13)) : Number(stamp) * 1000;
          lastSec = Math.max(lastSec, Math.floor(ms / 1000));
          if (seen.has(`${stamp}|${line}`)) continue;
          seen.add(`${stamp}|${line}`);
          let message = String(line ?? '');
          let type = 'stdout';
          try {
            const parsed = JSON.parse(message);
            if (parsed && typeof parsed === 'object' && '_entry' in parsed) {
              message = String(parsed._entry ?? '');
              type = parsed.type === 'stderr' ? 'stderr' : 'stdout';
            }
          } catch {}
          out.push({ type, datetime: new Date(ms).toISOString(), message });
        }
      }
      if (count < 100 || lastSec <= start) break;
      start = lastSec;
    }
    return out.sort((a, b) => a.datetime.localeCompare(b.datetime));
  }
  events(name: string, startUnix?: number, endUnix?: number) {
    return this.request<any>('GET', `/v1/projects/${name}/events`, { query: { start: startUnix, end: endUnix } });
  }
  applets(name: string) {
    return this.request<any>('GET', `/v1/projects/${name}/applets`);
  }
  metricsSummary(name: string) {
    return this.request<any>('GET', `/v1/projects/${name}/metrics/summary`);
  }
  metrics(name: string, kind: 'cpu' | 'memory' | 'network-receive' | 'network-transmit', sinceUnix: number) {
    return this.request<any>('GET', `/v1/projects/${name}/metrics/${kind}`, { query: { since: sinceUnix } });
  }
  disks(appId: string) {
    return this.request<any>('GET', `/v1/projects/${appId}/disks`);
  }

  // ---------- domains ----------
  async domains(project: string): Promise<any[]> {
    return (await this.request<any>('GET', '/v1/domains', { query: { project } })).domains ?? [];
  }
  addDomain(project: string, name: string) {
    return this.request<any>('POST', '/v1/domains', { json: { name, project, type: 'PROJECT' } });
  }
  checkDomain(domainId: string) {
    return this.request<any>('GET', `/v1/domains/${domainId}/check`);
  }
  enableSsl(domain: string) {
    return this.request<any>('POST', '/v1/domains/provision-ssl-certs', { json: { domain } });
  }

  // ---------- Liara DNS service (https://dns-service.liara.ir, spec/dns.yaml) ----------
  private static DNS = 'https://dns-service.liara.ir';

  async dnsZones(): Promise<any[]> {
    return (await this.request<any>('GET', '/api/v1/zones', { base: LiaraClient.DNS })).data ?? [];
  }
  async dnsZone(zone: string): Promise<any | undefined> {
    try {
      return (await this.request<any>('GET', `/api/v1/zones/${zone}`, { base: LiaraClient.DNS })).data;
    } catch (err) {
      if (err instanceof LiaraError && err.status === 404) return undefined;
      throw err;
    }
  }
  async createDnsZone(name: string): Promise<any> {
    return (await this.request<any>('POST', '/api/v1/zones', { json: { name }, base: LiaraClient.DNS })).data;
  }
  checkDnsZone(zone: string) {
    return this.request<any>('PUT', `/api/v1/zones/${zone}/check`, { base: LiaraClient.DNS });
  }
  async dnsRecords(zone: string): Promise<any[]> {
    return (await this.request<any>('GET', `/api/v1/zones/${zone}/dns-records`, { base: LiaraClient.DNS })).data ?? [];
  }
  // `contents` shape per type is not documented; {host} for CNAME/ALIAS and {text} for TXT are verified on first real use.
  createDnsRecord(zone: string, record: { name: string; type: string; ttl?: number; contents: Record<string, string>[] }) {
    return this.request<any>('POST', `/api/v1/zones/${zone}/dns-records`, { json: { ttl: 3600, ...record }, base: LiaraClient.DNS });
  }
}
