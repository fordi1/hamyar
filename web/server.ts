// Hamyar web dashboard server: static UI + JSON API + streamed agent runs.
// Plain node:http so it deploys on Liara as a simple node app.
//
// Security: without HAMYAR_DASHBOARD_PASSWORD the server only listens on
// 127.0.0.1. With it, every /api route except /api/login needs a session cookie.
import { config } from 'dotenv';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiaraClient } from '../core/liara-client.js';
import { Policy } from '../core/policy.js';
import type { OpsContext } from '../core/ops.js';
import { buildTools, llmFromEnv, runAgent, type ApprovalDecision, type ChatMessage } from '../core/agent.js';
import { appUrl, probe } from '../core/deployer.js';
import { normalizeSeries } from '../core/sre/collect.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(root, '.env'), quiet: true });

const PUBLIC = join(root, 'web', 'public');
const PASSWORD = process.env.HAMYAR_DASHBOARD_PASSWORD ?? '';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = PASSWORD ? '0.0.0.0' : '127.0.0.1';

const ctx: OpsContext = {
  client: LiaraClient.fromEnv(),
  policy: new Policy({ mode: Policy.fromEnv().mode, auditPath: process.env.HAMYAR_AUDIT_PATH || join(root, 'audit.jsonl') }),
  boards: new Map(),
};
const tools = buildTools(ctx);

const llm = llmFromEnv();

// ---------- sessions, conversations, approvals ----------

const sessions = new Set<string>();
const conversations = new Map<string, ChatMessage[]>();
const pending = new Map<string, (d: ApprovalDecision) => void>();

function cookie(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(name + '='))?.slice(name.length + 1);
}

function authorized(req: IncomingMessage): boolean {
  if (!PASSWORD) return true;
  const sid = cookie(req, 'hamyar_sid');
  return Boolean(sid && sessions.has(sid));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (e: unknown) => res.write(JSON.stringify(e) + '\n');

  if (!llm) {
    send({ type: 'assistant', text: 'هوش مصنوعی لیارا هنوز تنظیم نشده (LIARA_AI_API_KEY و LIARA_AI_BASE_URL یا LIARA_AI_WORKSPACE_ID). دکمه‌های بررسی سریع بدون هوش مصنوعی هم کار می‌کنند.' });
    return res.end();
  }

  const history = conversations.get(conversation) ?? [];
  try {
    const updated = await runAgent({
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

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { password } = await body(req);
      const a = Buffer.from(String(password ?? ''));
      const b = Buffer.from(PASSWORD);
      if (!PASSWORD || (a.length === b.length && timingSafeEqual(a, b))) {
        const sid = randomBytes(24).toString('hex');
        sessions.add(sid);
        res.setHeader('Set-Cookie', `hamyar_sid=${sid}; HttpOnly; SameSite=Strict; Path=/${PASSWORD ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      return json(res, 401, { error: 'رمز اشتباه است' });
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
      case 'GET /api/audit':
        return json(res, 200, ctx.policy.recent(30).reverse());
      case 'POST /api/chat':
        return chat(req, res);
      case 'POST /api/quick':
        return quick(req, res);
      case 'POST /api/approve': {
        const { id, approved, reason, values } = await body(req);
        const resolveDecision = pending.get(id);
        if (!resolveDecision) return json(res, 404, { error: 'این درخواست تأیید دیگر معتبر نیست' });
        pending.delete(id);
        resolveDecision({ approved: Boolean(approved), reason, values });
        return json(res, 200, { ok: true });
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

server.listen(PORT, HOST, () => {
  console.log(`Hamyar dashboard on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (mode=${ctx.policy.mode}, ai=${llm ? 'on' : 'off'}, auth=${PASSWORD ? 'on' : 'local only'})`);
});
