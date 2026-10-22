// Hamyar MCP server (stdio). Exposes the core as tools for Claude Code, Cursor or
// Claude Desktop — the "coding agent" side of Hamyar. Read-only tools run directly;
// every change goes through runAction(), i.e. the same policy as the web dashboard.
//
// Approval: if the client supports MCP elicitation, the server asks the HUMAN
// directly (the model cannot answer for them). Otherwise the tool returns a preview
// and a single-use confirm token bound to the exact arguments.
import { config } from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LiaraClient } from '../core/liara-client.js';
import { Policy } from '../core/policy.js';
import { runAction } from '../core/actions.js';
import * as ops from '../core/ops.js';
import { createRedactor } from '../core/redact.js';
import type { DeployEvent } from '../core/deployer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// stdout is the MCP channel, so dotenv must stay quiet
config({ path: join(root, '.env'), quiet: true });

const ctx: ops.OpsContext = {
  client: LiaraClient.fromEnv(),
  policy: Policy.fromEnv(root),
  boards: new Map(),
};
const { policy } = ctx;

const server = new McpServer(
  { name: 'hamyar', version: '0.1.0' },
  {
    capabilities: { logging: {} },
    instructions: [
      'Hamyar deploys and operates apps on the Liara PaaS and investigates incidents like an SRE.',
      'Reply to the user in Persian. Keep tool output (previews, boards) intact when you show it.',
      'Flow for a new project: analyze_project → show the plan (list_plans if the user wants to choose, or if Liara refused a plan) → launch_app with planID and, for g2 plans, bundlePlanID. For an existing app: deploy.',
      'Flow for an incident ("site is slow", "500 error"): diagnose → explain the root cause citing evidence ids (E1…) → propose the first fix → after the fix, verify → incident_report.',
      'Change tools (deploy, set_env, restart_app, resize_plan, rollback, …) need human approval through a trusted channel. If a tool returns an approval request number, show the preview and tell the user to approve it in the Hamyar dashboard or by running `npm run approve -- <number>` in their own terminal. Only after the user says they approved, call the SAME tool with the SAME arguments plus approvalId. You cannot approve on the user\'s behalf; an unapproved approvalId is refused.',
      'Never ask the user to paste secret values into chat. For env values use set_env with envFile + keys so values are read from a local file.',
      'If diagnose returns a code fix, edit the code at the given file:line yourself, then call deploy, then verify.',
      'Deleting apps, disks, databases or domains is intentionally unsupported; tell the user to do it in the Liara console.',
    ].join('\n'),
  },
);

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

// Tool output goes to the client model: mask secrets, including the app env values.
async function safely(fn: () => Promise<string>, app?: string) {
  try {
    return text(createRedactor(await ops.secretValues(ctx, app)).mask(await fn()));
  } catch (err: any) {
    return text(`❌ ${err?.explanation ?? err?.message ?? String(err)}`, true);
  }
}

// Shared handler for every change tool.
async function change(tool: string, args: Record<string, any>, approvalId?: string) {
  const events: DeployEvent[] = [];
  const onEvent = (e: DeployEvent) => {
    events.push(e);
    server.sendLoggingMessage({ level: 'info', data: `${tool}: ${e.phase}${e.message ? ` (${e.message})` : ''}` }).catch(() => {});
  };

  if (approvalId) {
    // The model calls back after the user said they approved; the store decides if that is true.
    const pending = policy.approvals.get(approvalId);
    if (pending?.status === 'pending') {
      return text(`⏳ درخواست ${pending.id} هنوز تأیید نشده است. کاربر باید آن را در داشبورد همیار یا با «npm run approve -- ${pending.id}» در ترمینال خودش تأیید کند.`);
    }
    const done = await runAction(ctx, tool, args, { approvalId }, onEvent, 'mcp');
    return done.status === 'done' ? text(ops.renderDone(tool, done.result, events)) : text(`❌ ${'error' in done ? done.error : done.status}`, true);
  }

  const first = await runAction(ctx, tool, args, undefined, onEvent, 'mcp');
  if (first.status === 'done') return text(ops.renderDone(tool, first.result, events));
  if (first.status !== 'needs_approval') return text(`❌ ${first.error}`, true);

  const preview = ops.renderPreview(first.preview, first.tier);
  if (server.server.getClientCapabilities()?.elicitation) {
    const answer = await server.server.elicitInput({
      message: preview,
      requestedSchema: {
        type: 'object',
        properties: {
          approve: { type: 'boolean', title: 'اجرا شود؟', description: 'تأیید برای اجرای این عملیات' },
          reason: { type: 'string', title: 'دلیل (اگر رد می‌کنید)' },
        },
        required: ['approve'],
      },
    });
    // The elicitation answer comes from the human in the client UI, not from the model.
    const approved = answer.action === 'accept' && answer.content?.approve === true;
    const reason = (answer.content?.reason as string) || (answer.action === 'cancel' ? 'لغو شد' : approved ? undefined : 'بدون دلیل');
    policy.approvals.decide(first.approvalId, { approved, by: 'user', channel: 'mcp-elicitation', reason });
    if (approved) {
      const done = await runAction(ctx, tool, args, { approvalId: first.approvalId }, onEvent, 'mcp');
      return done.status === 'done' ? text(ops.renderDone(tool, done.result, events)) : text(`❌ ${'error' in done ? done.error : done.status}`, true);
    }
    policy.audit({ tool, tier: first.tier, args, outcome: 'rejected', approvedBy: 'user (mcp-elicitation)', approvalId: first.approvalId, detail: reason });
    return text(`🚫 کاربر این عملیات را رد کرد. دلیل: ${reason}\nراه دیگری پیشنهاد بده یا از کاربر بپرس چه می‌خواهد.`);
  }

  // No trusted channel inside this client: hand the decision to the dashboard or the terminal.
  return text(
    `${preview}\n\n` +
      `📝 درخواست تأیید ${first.approvalId} ثبت شد (۱۰ دقیقه اعتبار).\n` +
      `کاربر باید خودش تأیید کند: در داشبورد همیار (بخش «در انتظار تأیید») یا با دستور زیر در ترمینال خودش:\n` +
      `npm run approve -- ${first.approvalId}\n` +
      `بعد از اینکه کاربر گفت تأیید کرده، همین ابزار را با همین آرگومان‌ها و approvalId="${first.approvalId}" صدا بزن. این شماره به‌تنهایی اجازه‌ی اجرا نیست.`,
  );
}

const app = z.string().describe('Liara app name, e.g. "broken-shop"');
const approvalId = z.string().optional().describe('Approval request number, only after the user approved it in the dashboard or terminal');
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

// ---------- read-only tools (T0) ----------

server.registerTool('liara_overview', {
  title: 'Liara account overview',
  description: 'Balance, apps with status and plan, current safety mode, and the latest actions from the audit log.',
  annotations: readOnly,
}, () => safely(() => ops.overview(ctx)));

server.registerTool('list_plans', {
  title: 'Plans this account can buy',
  description: 'Every app plan the Liara account can buy, the feature plans (bundlePlanID) each g2 plan needs, and the full monthly price (plan + feature plan). Use before launch_app when the user wants to choose, or after Liara refused a plan.',
  annotations: readOnly,
}, () => safely(() => ops.plansText(ctx)));

server.registerTool('analyze_project', {
  title: 'Analyze a local project for deployment',
  description: 'Detects platform/port (same rules as the Liara CLI), env vars the code needs, recommends a plan with price and reason, checks the balance, and proposes liara.json. Call before launch_app.',
  inputSchema: { dir: z.string().describe('Absolute path of the project folder'), app: app.optional() },
  annotations: { readOnlyHint: true },
}, ({ dir, app: name }) => safely(() => ops.analyzeText(ctx, dir, name)));

server.registerTool('app_status', {
  title: 'App status',
  description: 'Current status, plan, release, env var names and a live HTTP probe of the app.',
  inputSchema: { app },
  annotations: readOnly,
}, ({ app: name }) => safely(() => ops.appStatus(ctx, name), name));

server.registerTool('get_logs', {
  title: 'Recent logs, clustered',
  description: 'Runtime logs of the last N minutes grouped into patterns with counts (errors first).',
  inputSchema: { app, minutes: z.number().int().min(1).max(1440).default(30), errorsOnly: z.boolean().default(false) },
  annotations: readOnly,
}, ({ app: name, minutes, errorsOnly }) => safely(() => ops.logsText(ctx, name, minutes, errorsOnly), name));

server.registerTool('diagnose', {
  title: 'Investigate an incident (SRE)',
  description: 'Collects logs, events, CPU/RAM metrics, releases and a live probe; runs deterministic detectors; returns a hypothesis board (validated / rejected, with evidence ids), the root cause, ranked fixes, and a code-fix brief for the coding agent.',
  inputSchema: {
    app,
    dir: z.string().optional().describe('Local project folder, to compare env vars the code reads and point at code lines'),
    path: z.string().optional().describe('URL path to probe, e.g. /products'),
    minutes: z.number().int().min(5).max(360).default(30),
  },
  annotations: readOnly,
}, ({ app: name, dir, path, minutes }) => safely(async () => (await ops.diagnoseText(ctx, name, { dir, path, minutes, source: 'mcp' })).text, name));

server.registerTool('verify', {
  title: 'Verify a fix',
  description: 'Probes the site a few times and compares with targets fixed before the change (and with the last diagnose). Use after every fix.',
  inputSchema: { app, path: z.string().optional() },
  annotations: readOnly,
}, ({ app: name, path }) => safely(async () => (await ops.verifyText(ctx, name, path)).text, name));

server.registerTool('check_domain', {
  title: 'Domain setup guide and status',
  description: 'Step-by-step domain status: what Liara sees, whether the domain uses Liara DNS, which records are visible on public DNS, the exact records or nameservers to set at the registrar (e.g. IRNIC), and the next tool to call. With a domain that is not added yet, returns the full setup steps.',
  inputSchema: { app, domain: z.string().optional() },
  annotations: readOnly,
}, ({ app: name, domain }) => safely(() => ops.checkDomainText(ctx, name, domain), name));

server.registerTool('incident_report', {
  title: 'Incident report (postmortem)',
  description: 'Persian markdown report from the last diagnose and the actions taken since, including approvals and verification.',
  inputSchema: { app },
  annotations: { readOnlyHint: true },
}, ({ app: name }) => safely(() => ops.incidentReportText(ctx, name), name));

server.registerTool('audit_log', {
  title: 'Audit log',
  description: 'Latest actions Hamyar previewed, executed, failed, rejected or blocked, with who approved them.',
  inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  annotations: { readOnlyHint: true },
}, ({ limit }) => safely(async () => ops.auditText(ctx, limit)));

// ---------- change tools (T1 / T2) ----------

const changeTool = (name: string, title: string, description: string, shape: Record<string, z.ZodTypeAny>, destructive = false) =>
  server.registerTool(name, {
    title,
    description: `${description} Requires human approval: the first call files an approval request the user approves in the dashboard or terminal.`,
    inputSchema: { ...shape, approvalId },
    annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: true },
  }, (async (input: Record<string, any>) => {
    try {
      const { approvalId: id, ...args } = input;
      if (typeof args.dir === 'string') args.dir = resolve(args.dir);
      if (typeof args.envFile === 'string') args.envFile = resolve(args.envFile);
      return await change(name, args, id);
    } catch (err: any) {
      return text(`❌ ${err?.explanation ?? err?.message ?? String(err)}`, true);
    }
  }) as any);

changeTool('launch_app', 'Create app and first deploy', 'Creates a Liara app on the given plan, sets the env vars the code needs (read from a local file so values never pass through chat), then deploys and verifies.', {
  app, dir: z.string().describe('Absolute path of the project folder'), planID: z.string().describe('Plan id from analyze_project or list_plans'),
  bundlePlanID: z.string().optional().describe('Feature plan for a g2 plan (see list_plans); default: the cheapest with rollback'),
  envFile: z.string().optional().describe('Local .env file to read the values from'),
  keys: z.array(z.string()).optional().describe('Env var names to read from envFile and set before the deploy'),
});
changeTool('deploy', 'Deploy a new version', 'Packs the folder (never uploads .env files), uploads, builds, follows the build and probes the site.', {
  app, dir: z.string(), port: z.number().int().optional(), message: z.string().optional(),
});
changeTool('set_env', 'Set environment variables', 'Merges variables into the app env (Liara replaces the whole set; Hamyar keeps existing ones). Prefer envFile+keys so secret values never pass through chat.', {
  app,
  variables: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe('Only for non-secret values'),
  envFile: z.string().optional().describe('Local .env file to read values from'),
  keys: z.array(z.string()).optional().describe('Keys to read from envFile'),
});
changeTool('restart_app', 'Restart app', 'Restarts the app (frees memory; temporary relief).', { app });
changeTool('turn_on_app', 'Turn app on', 'Turns a stopped app on.', { app });
changeTool('turn_off_app', 'Turn app off', 'Stops the app; the site goes offline.', { app }, true);
changeTool('resize_plan', 'Change plan', 'Moves the app to another plan; preview shows price difference.', { app, planID: z.string() });
changeTool('rollback', 'Roll back to a previous release', 'Switches the app back to an earlier release.', { app, releaseID: z.string() });
changeTool('add_domain', 'Connect a domain', 'Adds a domain to the app; then use check_domain for DNS instructions.', { app, domain: z.string() });
changeTool('use_liara_dns', 'Manage the domain DNS on Liara', 'Creates the domain zone in Liara DNS and returns the two nameservers the user must set at the registrar.', { domain: z.string() });
changeTool('create_dns_records', 'Create the app DNS records', 'After the zone is active on Liara DNS, creates the records Liara needs for this app domain.', { app, domain: z.string() });
changeTool('enable_ssl', 'Enable SSL', 'Issues a free certificate for a connected domain.', { domain: z.string() });

await server.connect(new StdioServerTransport());
