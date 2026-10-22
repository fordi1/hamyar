// Hamyar web dashboard server: static UI + JSON API + streamed agent runs.
// Plain node:http so it deploys on Liara as a simple node app.
//
// Security: without HAMYAR_DASHBOARD_PASSWORD the server only listens on 127.0.0.1.
// With it (12+ chars), every /api route except /api/login needs an expiring session
// cookie; logins are rate-limited; state-changing requests must be same-origin JSON;
// every response carries a strict CSP. See web/security.ts.
import { config } from 'dotenv';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiaraClient } from '../core/liara-client.js';
import { Policy } from '../core/policy.js';
import * as ops from '../core/ops.js';
import type { OpsContext } from '../core/ops.js';
import { buildTools, llmFromEnv, runAgent, type ApprovalDecision, type ChatMessage } from '../core/agent.js';
import { appUrl, probe } from '../core/deployer.js';
import { normalizeSeries } from '../core/sre/collect.js';
import { resumeOperations } from '../core/operations.js';
import { MAX_ARCHIVE_BYTES, SourceError, SourceStore, extractZip, fetchGithub, parseGithubUrl } from '../core/sources.js';
import { WizardError, analyzeSource, cancelDeploy, requestDeploy, startDeploy } from '../core/wizard.js';
import { renderIncidentReport, type AuditRow, type Incident } from '../core/incidents.js';
import { domainStatus, validDomain } from '../core/domain-assistant.js';
import { RANGES, requestAppAction, runApprovedAppAction, shapeLogs, shapeMetrics, shapeReleases, validAppName, type LogLevel, type Range } from '../core/monitor.js';
import { LoginLimiter, SECURITY_HEADERS, SessionStore, checkMutationRequest, passwordProblem } from './security.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(root, '.env'), quiet: true });

const PUBLIC = join(root, 'web', 'public');
const PASSWORD = process.env.HAMYAR_DASHBOARD_PASSWORD ?? '';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = PASSWORD ? '0.0.0.0' : '127.0.0.1';
const DEV = process.env.HAMYAR_DEV === '1';
if (PASSWORD && passwordProblem(PASSWORD)) {
  console.error(passwordProblem(PASSWORD));
  process.exit(1);
}

const ctx: OpsContext = {
  client: LiaraClient.fromEnv(),
  policy: Policy.fromEnv(root),
  boards: new Map(),
};
const tools = buildTools(ctx);
const sources = new SourceStore(join(process.env.HAMYAR_STATE_DIR || join(root, '.hamyar'), 'sources'));

const llm = llmFromEnv();

// ---------- sessions, conversations, approvals ----------

const sessions = new SessionStore();
const limiter = new LoginLimiter();
const conversations = new Map<string, ChatMessage[]>();
const pending = new Map<string, (d: ApprovalDecision) => void>();

function cookie(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(name + '='))?.slice(name.length + 1);
}

function authorized(req: IncomingMessage): boolean {
  if (!PASSWORD) return true;
  return sessions.valid(cookie(req, 'hamyar_sid'));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function rawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new SourceError(`حجم فایل بیشتر از ${Math.round(max / 1024 / 1024)} مگابایت است.`);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new SourceError(`حجم فایل بیشتر از ${Math.round(max / 1024 / 1024)} مگابایت است.`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  // the UI simulation is a development tool only
  if (path.endsWith('dev-sim.js') && !DEV) return json(res, 404, { error: 'not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ---------- API ----------

async function status(app: string) {
  const since = Math.floor(Date.now() / 1000) - 30 * 60;
  const [info, releases, memory, cpu, probed] = await Promise.all([
    ctx.client.getApp(app),
    ctx.client.releases(app, 5).catch(() => undefined),
    ctx.client.metrics(app, 'memory', since).catch(() => undefined),
    ctx.client.metrics(app, 'cpu', since).catch(() => undefined),
    probe(appUrl(app), 3),
  ]);
  const plans = await ctx.client.appPlans().catch(() => ({} as Record<string, any>));
  const plan = plans[info.planID];
  return {
    app,
    url: appUrl(app),
    status: info.status,
    scale: info.scale,
    platform: info.type,
    planID: info.planID,
    planRamGB: plan?.RAM?.amount,
    planCpu: plan?.CPU?.amount,
    currentRelease: releases?.currentRelease,
    releases: (releases?.releases ?? []).slice(0, 5).map((r: any) => ({ id: r._id, state: r.state, createdAt: r.createdAt })),
    envNames: (info.envs ?? []).map((e: any) => e.key),
    memory: normalizeSeries(memory),
    cpu: normalizeSeries(cpu),
    probe: { okRatio: probed.okRatio, p50: probed.p50, p95: probed.p95, healthy: probed.healthy },
  };
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  const { message, app, conversation = 'default' } = await body(req);
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (e: unknown) => res.write(JSON.stringify(e) + '\n');

  if (!llm) {
    send({ type: 'assistant', text: 'هوش مصنوعی لیارا هنوز تنظیم نشده (LIARA_AI_API_KEY و LIARA_AI_BASE_URL یا LIARA_AI_WORKSPACE_ID). دکمه‌های بررسی سریع بدون هوش مصنوعی هم کار می‌کنند.' });
    return res.end();
  }

  const history = conversations.get(conversation) ?? [];
  try {
    const knownSecrets = await ops.secretValues(ctx, app ? String(app) : undefined);
    const updated = await runAgent({
      knownSecrets,
      llm,
      tools,
      history,
      userMessage: String(message ?? '').slice(0, 4000) + (app ? `\n\n(برنامه‌ی انتخاب‌شده در داشبورد: ${app})` : ''),
      hooks: {
        onEvent: send,
        requestApproval: (r) =>
          new Promise<ApprovalDecision>((resolveDecision) => {
            pending.set(r.id, resolveDecision);
            send({ type: 'approval', ...r });
            // An unanswered card expires like a confirm token.
            setTimeout(() => {
              if (pending.delete(r.id)) resolveDecision({ approved: false, reason: 'زمان تأیید (۱۰ دقیقه) تمام شد' });
            }, 10 * 60_000);
          }),
      },
    });
    // keep the conversation short enough for the model's context
    conversations.set(conversation, updated.slice(-40));
  } catch (err: any) {
    send({ type: 'error', text: err?.explanation ?? err?.message ?? String(err) });
  }
  res.end();
}

// Direct tool run without the model, for the quick-action buttons.
async function quick(req: IncomingMessage, res: ServerResponse) {
  const { tool, args } = await body(req);
  const t = tools.find((x) => x.name === tool && x.kind === 'read');
  if (!t) return json(res, 400, { error: 'only read-only tools can run directly' });
  try {
    const result = await t.run(args ?? {}, { onEvent: () => {}, requestApproval: async () => ({ approved: false }) });
    json(res, 200, typeof result === 'string' ? { output: result } : { output: result.text, data: result.data });
  } catch (err: any) {
    json(res, 200, { error: err?.explanation ?? err?.message ?? String(err) });
  }
}

// ---------- app pages: monitoring, logs, releases ----------

const LOG_RANGES: Record<string, number> = { '15m': 900, '1h': 3600, '6h': 21_600, '24h': 86_400 };

async function appData(res: ServerResponse, app: string, kind: string, url: URL) {
  if (!validAppName(app)) return json(res, 400, { error: 'نام برنامه معتبر نیست.' });
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'metrics') {
    const range = (url.searchParams.get('range') ?? '1h') as Range;
    const since = now - (RANGES[range] ?? RANGES['1h']);
    const optional = <T>(p: Promise<T>) => p.catch(() => undefined);
    const [info, plans, cpu, memory, rx, tx, summary, releases] = await Promise.all([
      ctx.client.getApp(app),
      optional(ctx.client.appPlans()),
      optional(ctx.client.metrics(app, 'cpu', since)),
      optional(ctx.client.metrics(app, 'memory', since)),
      optional(ctx.client.metrics(app, 'network-receive', since)),
      optional(ctx.client.metrics(app, 'network-transmit', since)),
      optional(ctx.client.metricsSummary(app)),
      optional(ctx.client.releases(app, 20)),
    ]);
    const plan = plans?.[info.planID];
    const markers = shapeReleases(releases).filter((r) => r.createdAt >= since * 1000).map((r) => ({ at: r.createdAt, current: r.current }));
    return json(res, 200, { range, since: since * 1000, ...shapeMetrics({ cpu, memory, rx, tx, summary }, { ramGB: plan?.RAM?.amount, cpu: plan?.CPU?.amount }), releases: markers });
  }
  if (kind === 'logs') {
    const window = LOG_RANGES[url.searchParams.get('range') ?? '1h'] ?? 3600;
    const level = url.searchParams.get('level') as LogLevel | null;
    const raw = await ctx.client.logs(app, now - window);
    return json(res, 200, shapeLogs(raw, { level: level && ['error', 'warn', 'info'].includes(level) ? level : undefined, q: url.searchParams.get('q') ?? undefined }));
  }
  if (kind === 'releases') return json(res, 200, shapeReleases(await ctx.client.releases(app, 20)));
  if (kind === 'domains') {
    const list = await ctx.client.domains(app);
    return json(res, 200, list.map((d: any) => ({ name: d.name, status: d.status, ssl: d.certificatesStatus })));
  }
  if (kind === 'domain') {
    const domain = String(url.searchParams.get('d') ?? '').trim().toLowerCase();
    if (!validDomain(domain)) return json(res, 400, { error: 'نام دامنه معتبر نیست؛ مثل shop.ir یا www.shop.com بنویسید.' });
    const method = url.searchParams.get('method');
    return json(res, 200, await domainStatus(ctx.client, app, domain, { method: method === 'records' || method === 'liara-dns' ? method : undefined }));
  }
  json(res, 404, { error: 'not found' });
}

// ---------- incidents (screens D and G) ----------

// approvals, rejections and executions for the app while the incident was open, from the audit log
function incidentActions(inc: Incident): AuditRow[] {
  const from = inc.openedAt - 60_000;
  const to = inc.closedAt ?? Date.now();
  return ctx.policy
    .recent(500)
    .filter((e) => e.args?.app === inc.app && e.outcome !== 'previewed')
    .map((e) => ({ at: Date.parse(e.at), tool: e.tool, outcome: e.outcome, approvedBy: e.approvedBy, detail: e.detail }))
    .filter((e) => e.at >= from && e.at <= to)
    .sort((a, b) => a.at - b.at);
}

async function incidents(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === 'GET' && url.pathname === '/api/incidents') {
    return json(res, 200, ctx.policy.incidents.list().map((i) => ({
      id: i.id, app: i.app, title: i.title, status: i.status, severity: i.severity, openedAt: i.openedAt, closedAt: i.closedAt,
      diagnoses: i.diagnoses, rootConfidence: i.root?.confidence, fix: i.fixes[0]?.title, verified: i.verifications.at(-1)?.passed,
    })));
  }
  const m = url.pathname.match(/^\/api\/incidents\/([A-F0-9]{8})(\/close)?$/);
  if (!m) return json(res, 404, { error: 'not found' });
  if (req.method === 'POST' && m[2]) {
    const { reason } = await body(req);
    const closed = ctx.policy.incidents.close(m[1], String(reason ?? '').slice(0, 300));
    if (!closed) return json(res, 409, { error: 'این حادثه باز نیست.' });
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'GET' || m[2]) return json(res, 404, { error: 'not found' });
  const inc = ctx.policy.incidents.get(m[1]);
  if (!inc) return json(res, 404, { error: 'این حادثه پیدا نشد.' });
  const actions = incidentActions(inc);
  return json(res, 200, { incident: inc, actions, report: renderIncidentReport(inc, actions) });
}

// ---------- deploy wizard: source intake, analysis, approval, run ----------

const publicSource = (s: { id: string; origin: string; label: string }) => ({ id: s.id, origin: s.origin, label: s.label });

function sourceFor(id: unknown) {
  const s = sources.get(String(id ?? ''));
  if (!s) throw new WizardError('کد این پروژه دیگر در دسترس نیست؛ از مرحله‌ی اول دوباره شروع کنید.');
  return s;
}

async function wizard(req: IncomingMessage, res: ServerResponse, url: URL) {
  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case 'POST /api/source/local': {
        // a path on this machine only makes sense when the dashboard runs on it
        if (PASSWORD) return json(res, 403, { error: 'پروژه‌ی محلی فقط وقتی داشبورد روی همین کامپیوتر اجرا می‌شود در دسترس است.' });
        const { path } = await body(req);
        const dir = resolve(String(path ?? '').trim());
        if (!path || !existsSync(dir) || !statSync(dir).isDirectory()) throw new SourceError('این پوشه پیدا نشد. مسیر کامل پوشه‌ی پروژه را وارد کنید.');
        return json(res, 200, { source: publicSource(sources.register('local', basename(dir), dir)) });
      }
      case 'POST /api/source/github': {
        const { url: repoUrl, branch } = await body(req);
        const ref = parseGithubUrl(String(repoUrl ?? ''));
        if (branch) ref.branch = String(branch).trim();
        const s = sources.create('github', `${ref.owner}/${ref.repo}${ref.branch ? `@${ref.branch}` : ''}`);
        try {
          await fetchGithub(ref, s.dir);
        } catch (err) {
          sources.remove(s);
          throw err;
        }
        return json(res, 200, { source: publicSource(s) });
      }
      case 'POST /api/source/zip': {
        const name = basename(String(url.searchParams.get('name') ?? 'project.zip')).slice(0, 80);
        const data = await rawBody(req, MAX_ARCHIVE_BYTES);
        const s = sources.create('zip', name);
        try {
          await extractZip(data, s.dir);
        } catch (err) {
          sources.remove(s);
          throw err;
        }
        return json(res, 200, { source: publicSource(s) });
      }
      case 'POST /api/wizard/analyze': {
        const { sourceId, subdir = '', blocked } = await body(req);
        const s = sourceFor(sourceId);
        const dir = sources.projectDir(s, String(subdir));
        const hint = String(subdir).split('/').filter(Boolean).pop() || s.label.replace(/@.*$/, '').split('/').pop() || 'my-app';
        // plans Liara refused for this account earlier in the wizard (e.g. the g2 family)
        const refused = Array.isArray(blocked) ? blocked.map(String).filter((b) => /^[a-z0-9-]{1,40}$/.test(b)).slice(0, 20) : undefined;
        return json(res, 200, await analyzeSource(ctx, dir, hint, { blocked: refused }));
      }
      case 'POST /api/wizard/request': {
        const { sourceId, subdir = '', app, planID, bundlePlanID, keys = [] } = await body(req);
        const dir = sources.projectDir(sourceFor(sourceId), String(subdir));
        return json(res, 200, await requestDeploy(ctx, { dir, app: String(app ?? ''), planID: String(planID ?? ''), bundlePlanID: bundlePlanID ? String(bundlePlanID) : undefined, keys: Array.isArray(keys) ? keys.map(String) : [] }));
      }
      case 'POST /api/wizard/cancel': {
        const { id, reason } = await body(req);
        cancelDeploy(ctx, String(id ?? ''), String(reason || 'کاربر برگشت و تنظیمات را ویرایش کرد'));
        return json(res, 200, { ok: true });
      }
      case 'POST /api/wizard/start': {
        const { id, values = {} } = await body(req);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const send = (e: unknown) => res.write(JSON.stringify(e) + '\n');
        try {
          const result = await startDeploy(ctx, String(id ?? ''), values && typeof values === 'object' ? values : {}, (e) => send({ type: 'progress', phase: e.phase, message: e.message }));
          send(result.status === 'done' ? { type: 'done', result: result.result } : { type: 'error', text: 'error' in result ? result.error : result.status });
        } catch (err: any) {
          send({ type: 'error', text: err?.explanation ?? err?.message ?? String(err) });
        }
        return res.end();
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    const known = err instanceof SourceError || err instanceof WizardError;
    json(res, known ? 400 : 500, { error: err?.explanation ?? err?.message ?? String(err) });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

    const refused = checkMutationRequest(req, { allowZip: url.pathname === '/api/source/zip' });
    if (refused) return json(res, 403, { error: refused });

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (limiter.blocked(ip)) return json(res, 429, { error: 'تعداد تلاش‌های ناموفق زیاد بود؛ ۱۵ دقیقه‌ی دیگر دوباره امتحان کنید.' });
      const { password } = await body(req);
      const a = Buffer.from(String(password ?? ''));
      const b = Buffer.from(PASSWORD);
      if (!PASSWORD || (a.length === b.length && timingSafeEqual(a, b))) {
        limiter.succeed(ip);
        const sid = sessions.create();
        res.setHeader('Set-Cookie', `hamyar_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessions.maxAgeSeconds}${PASSWORD ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      limiter.fail(ip);
      return json(res, 401, { error: 'رمز اشتباه است' });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      sessions.destroy(cookie(req, 'hamyar_sid'));
      res.setHeader('Set-Cookie', 'hamyar_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (!authorized(req)) return json(res, 401, { error: 'login required' });
    if (url.pathname.startsWith('/api/source/') || url.pathname.startsWith('/api/wizard/')) return await wizard(req, res, url);
    const appRoute = req.method === 'GET' && url.pathname.match(/^\/api\/apps\/([^/]+)\/(metrics|logs|releases|domains|domain)$/);
    // awaited so a Liara error reaches the catch below instead of crashing the server
    if (appRoute) return await appData(res, decodeURIComponent(appRoute[1]), appRoute[2], url);
    if (url.pathname === '/api/incidents' || url.pathname.startsWith('/api/incidents/')) return await incidents(req, res, url);

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/config':
        return json(res, 200, { mode: ctx.policy.mode, ai: Boolean(llm), provider: llm?.provider, model: llm?.model, auth: Boolean(PASSWORD), local: !PASSWORD });
      case 'GET /api/me': {
        // only what the top bar shows; never national code, phone or tokens
        const [me, balance] = await Promise.all([ctx.client.me(), ctx.client.balance()]);
        return json(res, 200, { name: me.user?.fullname ?? '', email: me.user?.email ?? '', balance });
      }
      case 'GET /api/apps': {
        const [balance, apps] = await Promise.all([ctx.client.balance(), ctx.client.listApps()]);
        return json(res, 200, { balance, apps: apps.map((a: any) => ({ name: a.project_id, status: a.status, scale: a.scale, planID: a.planID, type: a.type })) });
      }
      case 'GET /api/status':
        return json(res, 200, await status(String(url.searchParams.get('app'))));
      case 'GET /api/probe': {
        const p = await probe(appUrl(String(url.searchParams.get('app'))), 2);
        return json(res, 200, { okRatio: p.okRatio, p95: p.p95, healthy: p.healthy });
      }
      case 'GET /api/operations':
        return json(res, 200, { active: ctx.policy.operations.active(), recent: ctx.policy.operations.recent(10) });
      case 'GET /api/audit':
        return json(res, 200, ctx.policy.recent(30).reverse());
      case 'POST /api/chat':
        return await chat(req, res);
      case 'POST /api/quick':
        return await quick(req, res);
      case 'GET /api/approvals': {
        // Pending requests from this dashboard and from MCP clients; survives refresh and restart.
        const list = ctx.policy.approvals.list({ status: 'pending' }).map((r) => ({
          id: r.id, tool: r.tool, tier: r.tier, preview: r.preview, source: r.source, expiresAt: r.expiresAt,
          needsValues: r.tool === 'set_env' && Array.isArray(r.args.keys) ? r.args.keys : undefined,
          waiting: pending.has(r.id),
          wizard: Boolean(r.args.wizard),
          direct: Boolean(r.args.direct),
        }));
        return json(res, 200, list);
      }
      case 'POST /api/approve': {
        const { id, approved, reason, values } = await body(req);
        const record = ctx.policy.approvals.get(String(id ?? ''));
        if (!record || record.status !== 'pending') return json(res, 404, { error: 'این درخواست تأیید دیگر معتبر نیست' });
        const needsValues = record.tool === 'set_env' && Array.isArray(record.args.keys);
        // a values card can only be applied by the agent run that is waiting for it
        if (needsValues && approved && !pending.has(record.id)) return json(res, 409, { error: 'این درخواست به گفت‌وگوی دیگری تعلق دارد؛ دوباره از همیار بخواهید.' });
        // a wizard deploy carries its env values with the approve click on the wizard page
        if (record.args.wizard && approved) return json(res, 409, { error: 'این دیپلوی را از صفحه‌ی «دیپلوی جدید» تأیید کنید؛ مقدار متغیرها همان‌جا وارد شده است.' });
        const decided = ctx.policy.approvals.decide(record.id, { approved: Boolean(approved), by: 'user', channel: 'dashboard', reason });
        ctx.policy.audit({ tool: decided.tool, tier: decided.tier, args: decided.args, outcome: decided.status === 'approved' ? 'approved' : 'rejected', approvedBy: 'user (dashboard)', approvalId: decided.id, detail: reason });
        // a button on the app page: nothing else waits for it, so the dashboard runs it now
        if (decided.status === 'approved' && decided.args.direct) {
          runApprovedAppAction(ctx, decided.id).catch((err) => console.error('direct action failed:', err?.message ?? err));
          return json(res, 200, { ok: true, status: decided.status, source: decided.source, running: true });
        }
        const resolveDecision = pending.get(record.id);
        if (resolveDecision) {
          pending.delete(record.id);
          resolveDecision({ approved: Boolean(approved), reason, values, by: 'user' });
        }
        return json(res, 200, { ok: true, status: decided.status, source: decided.source });
      }
      case 'POST /api/action/request': {
        const { tool, args } = await body(req);
        try {
          const r = await requestAppAction(ctx, String(tool ?? ''), args && typeof args === 'object' ? args : {});
          if (r.status === 'needs_approval') return json(res, 200, { status: r.status, id: r.approvalId, tool, tier: r.tier, preview: r.preview, expiresAt: r.expiresAt, source: 'dashboard' });
          if (r.status === 'done') return json(res, 200, { status: 'done' });
          return json(res, 400, { error: r.error });
        } catch (err: any) {
          return json(res, 400, { error: err?.message ?? String(err) });
        }
      }
      case 'POST /api/stop': {
        ctx.policy.revokeAll();
        for (const [id, resolveDecision] of pending) {
          pending.delete(id);
          resolveDecision({ approved: false, reason: 'کاربر دکمه‌ی توقف را زد' });
        }
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    json(res, 500, { error: err?.explanation ?? err?.message ?? String(err) });
  }
});

// After a restart: dashboard approval requests have no agent run waiting for them any more
// (it lived in this process), so they are revoked with a reason; MCP requests stay. Deploys
// that were in flight are followed to the end on Liara in the background.
const orphaned = ctx.policy.approvals.revokeAll('داشبورد ری‌استارت شد و گفت‌وگوی این درخواست قطع شد؛ دوباره از همیار بخواهید.', (r) => r.source === 'dashboard');
if (orphaned) ctx.policy.audit({ tool: '*', tier: 'T2', args: {}, outcome: 'revoked', detail: `${orphaned} درخواست تأیید داشبورد بعد از ری‌استارت لغو شد` });
sources.cleanup();
resumeOperations(ctx.policy.operations, ctx.client).catch((err) => console.error('resume failed:', err?.message ?? err));

server.listen(PORT, HOST, () => {
  console.log(`Hamyar dashboard on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (mode=${ctx.policy.mode}, ai=${llm ? 'on' : 'off'}, auth=${PASSWORD ? 'on' : 'local only'})`);
});
