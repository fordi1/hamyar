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
import { timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiaraClient } from '../core/liara-client.js';
import { Policy } from '../core/policy.js';
import * as ops from '../core/ops.js';
import type { OpsContext } from '../core/ops.js';
import { buildTools, llmFromEnv, runAgent, type ApprovalDecision, type ChatMessage } from '../core/agent.js';
import { appUrl, probe } from '../core/deployer.js';
import { normalizeSeries } from '../core/sre/collect.js';
import { resumeOperations } from '../core/operations.js';
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

    const refused = checkMutationRequest(req);
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

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/config':
        return json(res, 200, { mode: ctx.policy.mode, ai: Boolean(llm), auth: Boolean(PASSWORD) });
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
        return chat(req, res);
      case 'POST /api/quick':
        return quick(req, res);
      case 'GET /api/approvals': {
        // Pending requests from this dashboard and from MCP clients; survives refresh and restart.
        const list = ctx.policy.approvals.list({ status: 'pending' }).map((r) => ({
          id: r.id, tool: r.tool, tier: r.tier, preview: r.preview, source: r.source, expiresAt: r.expiresAt,
          needsValues: r.tool === 'set_env' && Array.isArray(r.args.keys) ? r.args.keys : undefined,
          waiting: pending.has(r.id),
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
        const decided = ctx.policy.approvals.decide(record.id, { approved: Boolean(approved), by: 'user', channel: 'dashboard', reason });
        ctx.policy.audit({ tool: decided.tool, tier: decided.tier, args: decided.args, outcome: decided.status === 'approved' ? 'approved' : 'rejected', approvedBy: 'user (dashboard)', approvalId: decided.id, detail: reason });
        const resolveDecision = pending.get(record.id);
        if (resolveDecision) {
          pending.delete(record.id);
          resolveDecision({ approved: Boolean(approved), reason, values, by: 'user' });
        }
        return json(res, 200, { ok: true, status: decided.status, source: decided.source });
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
resumeOperations(ctx.policy.operations, ctx.client).catch((err) => console.error('resume failed:', err?.message ?? err));

server.listen(PORT, HOST, () => {
  console.log(`Hamyar dashboard on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (mode=${ctx.policy.mode}, ai=${llm ? 'on' : 'off'}, auth=${PASSWORD ? 'on' : 'local only'})`);
});
