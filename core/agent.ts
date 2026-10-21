// The dashboard's agent loop over an OpenAI-compatible model (Liara AI).
// The model plans and explains; tools do the work; changes pause for a human
// decision in the UI; tool output is redacted before the model sees it.
import type { OpsContext } from './ops.js';
import * as ops from './ops.js';
import { runAction, type Preview } from './actions.js';
import type { Tier } from './policy.js';
import type { DeployEvent } from './deployer.js';
import { createRedactor } from './redact.js';

// ---------- model interface ----------

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLM {
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<{ content?: string | null; tool_calls?: ToolCall[] }>;
}

export function openAICompatibleLLM(opts: { url: string; apiKey: string; model: string; timeoutMs?: number }): LLM {
  return {
    async chat(messages, tools) {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages,
          tools: tools.map((t) => ({ type: 'function', function: t })),
          tool_choice: 'auto',
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Liara AI ${res.status}: ${body?.error?.message ?? body?.message ?? JSON.stringify(body).slice(0, 200)}`);
      return body.choices?.[0]?.message ?? { content: '' };
    },
  };
}

// ---------- events and approvals ----------

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; status: 'start' | 'done' | 'error'; args?: Record<string, unknown>; output?: string }
  | { type: 'progress'; tool: string; phase: string; message?: string };

export interface ApprovalRequest {
  id: string;
  tool: string;
  tier: Tier;
  preview: Preview;
  // keys whose values the human types into the card (never shown to the model)
  needsValues?: string[];
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  values?: Record<string, string>;
}

export interface AgentHooks {
  onEvent(e: AgentEvent): void;
  requestApproval(r: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface AgentTool extends ToolSpec {
  kind: 'read' | 'change';
  run(args: Record<string, any>, hooks: AgentHooks): Promise<string>;
}

// ---------- tools ----------

const str = (description: string) => ({ type: 'string', description });
const appParam = str('Liara app name');
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

let approvalSeq = 0;

async function runChange(ctx: OpsContext, tool: string, args: Record<string, any>, hooks: AgentHooks): Promise<string> {
  const onEvent = (e: DeployEvent) => hooks.onEvent({ type: 'progress', tool, phase: e.phase, message: e.message });
  const approved = async (realArgs: Record<string, any>) => {
    // The human already approved in the dashboard card; issue and consume the token server-side.
    const preview = await runAction(ctx, tool, realArgs, undefined, onEvent);
    if (preview.status === 'done') return ops.renderDone(tool, preview.result, []);
    if (preview.status !== 'needs_approval') return `❌ ${preview.error}`;
    const done = await runAction(ctx, tool, realArgs, { token: preview.token, approvedBy: 'user (dashboard)' }, onEvent);
    return done.status === 'done' ? ops.renderDone(tool, done.result, []) : `❌ ${'error' in done ? done.error : done.status}`;
  };
  const rejected = (tier: Tier, reason?: string) => {
    ctx.policy.audit({ tool, tier, args, outcome: 'rejected', approvedBy: 'user (dashboard)', detail: reason });
    return `🚫 کاربر این عملیات را رد کرد. دلیل: ${reason || 'بدون دلیل'}. راه دیگری پیشنهاد بده یا بپرس چه می‌خواهد.`;
  };

  // Secret env values: the model names the keys, the human types the values.
  if (tool === 'set_env' && Array.isArray(args.keys) && args.keys.length) {
    const keys: string[] = args.keys;
    const decision = await hooks.requestApproval({
      id: `a${++approvalSeq}`, tool, tier: 'T2', needsValues: keys,
      preview: {
        title: `تنظیم متغیرهای محیطی ${args.app}`,
        lines: [...keys.map((k) => `${k}: مقدار را خودتان وارد کنید (به هوش مصنوعی داده نمی‌شود)`), 'متغیرهای فعلی حفظ می‌شوند.'],
        risk: 'کم', downtime: 'یک ری‌استارت کوتاه', undo: 'تغییر دوباره‌ی مقدار',
      },
    });
    if (!decision.approved) return rejected('T2', decision.reason);
    const missing = keys.filter((k) => !decision.values?.[k]);
    if (missing.length) return `❌ مقدار ${missing.join(', ')} وارد نشد؛ کاری انجام نشد.`;
    const variables = [...(args.variables ?? []), ...keys.map((k) => ({ key: k, value: decision.values![k] }))];
    return approved({ app: args.app, variables });
  }

  const first = await runAction(ctx, tool, args, undefined, onEvent);
  if (first.status === 'done') return ops.renderDone(tool, first.result, []);
  if (first.status !== 'needs_approval') return `❌ ${first.error}`;
  const decision = await hooks.requestApproval({ id: `a${++approvalSeq}`, tool, tier: first.tier, preview: first.preview });
  if (!decision.approved) return rejected(first.tier, decision.reason);
  const done = await runAction(ctx, tool, args, { token: first.token, approvedBy: 'user (dashboard)' }, onEvent);
  return done.status === 'done' ? ops.renderDone(tool, done.result, []) : `❌ ${'error' in done ? done.error : done.status}`;
}

export function buildTools(ctx: OpsContext): AgentTool[] {
  const read = (name: string, description: string, parameters: Record<string, unknown>, fn: (a: any) => Promise<string>): AgentTool => ({
    name, description, parameters, kind: 'read', run: (a) => fn(a),
  });
  const change = (name: string, description: string, parameters: Record<string, unknown>): AgentTool => ({
    name, description: `${description} Pauses for the user's approval in the dashboard.`, parameters, kind: 'change',
    run: (a, hooks) => runChange(ctx, name, a, hooks),
  });

  return [
    read('liara_overview', 'Account balance, apps with status and plan, safety mode, latest actions.', obj({}), () => ops.overview(ctx)),
    read('analyze_project', 'Analyze a project folder on the server for deployment: platform, port, needed env vars, recommended plan with price, balance check.',
      obj({ dir: str('Project folder path'), app: str('Desired app name') }, ['dir']), (a) => ops.analyzeText(ctx, a.dir, a.app)),
    read('app_status', 'Status, plan, current release, env var names and live probe of an app.', obj({ app: appParam }, ['app']), (a) => ops.appStatus(ctx, a.app)),
    read('get_logs', 'Recent runtime logs grouped into patterns, errors first.',
      obj({ app: appParam, minutes: { type: 'number' }, errorsOnly: { type: 'boolean' } }, ['app']), (a) => ops.logsText(ctx, a.app, a.minutes ?? 30, a.errorsOnly ?? false)),
    read('diagnose', 'SRE investigation: logs, events, CPU/RAM, releases and live probe → hypothesis board with root cause, evidence ids and ranked fixes. Use for any "slow", "down", "500", "error" complaint.',
      obj({ app: appParam, path: str('URL path to probe, e.g. /products'), minutes: { type: 'number' } }, ['app']),
      async (a) => (await ops.diagnoseText(ctx, a.app, { path: a.path, minutes: a.minutes })).text),
    read('verify', 'After a fix: probe the site several times and compare with targets fixed before the change.',
      obj({ app: appParam, path: str('URL path') }, ['app']), async (a) => (await ops.verifyText(ctx, a.app, a.path)).text),
    read('check_domain', 'Domain setup guide and status: Liara status, Liara DNS, public DNS visibility, exact records or nameservers to set at the registrar (IRNIC), next step. Use for any domain question.',
      obj({ app: appParam, domain: str('Domain, e.g. shop.ir') }, ['app']), (a) => ops.checkDomainText(ctx, a.app, a.domain)),
    read('incident_report', 'Persian postmortem of the last diagnose and the actions since.', obj({ app: appParam }, ['app']), (a) => ops.incidentReportText(ctx, a.app)),
    read('audit_log', 'Latest actions with approvals.', obj({ limit: { type: 'number' } }), async (a) => ops.auditText(ctx, a.limit ?? 20)),

    change('launch_app', 'Create an app on a plan and deploy a folder for the first time.', obj({ app: appParam, dir: str('Project folder'), planID: str('Plan id from analyze_project') }, ['app', 'dir', 'planID'])),
    change('deploy', 'Deploy a new version of a folder to an existing app.', obj({ app: appParam, dir: str('Project folder'), port: { type: 'number' } }, ['app', 'dir'])),
    change('set_env', 'Set environment variables. Pass only key NAMES in `keys`; the user types the values in the dashboard. Use `variables` only for clearly non-secret values.',
      obj({ app: appParam, keys: { type: 'array', items: { type: 'string' } }, variables: { type: 'array', items: obj({ key: { type: 'string' }, value: { type: 'string' } }, ['key', 'value']) } }, ['app'])),
    change('restart_app', 'Restart the app (frees memory; temporary relief).', obj({ app: appParam }, ['app'])),
    change('turn_on_app', 'Turn a stopped app on.', obj({ app: appParam }, ['app'])),
    change('turn_off_app', 'Turn the app off (site goes offline).', obj({ app: appParam }, ['app'])),
    change('resize_plan', 'Move the app to another plan (shows price difference).', obj({ app: appParam, planID: str('Target plan id') }, ['app', 'planID'])),
    change('rollback', 'Switch the app back to an earlier release.', obj({ app: appParam, releaseID: str('Release id') }, ['app', 'releaseID'])),
    change('add_domain', 'Connect a domain to the app.', obj({ app: appParam, domain: str('Domain, e.g. shop.example.ir') }, ['app', 'domain'])),
    change('use_liara_dns', 'Manage the domain DNS on Liara (recommended for .ir): creates the zone and returns two nameservers for the registrar.', obj({ domain: str('Domain') }, ['domain'])),
    change('create_dns_records', 'Create the DNS records Liara needs for the app domain in Liara DNS (after nameservers are active).', obj({ app: appParam, domain: str('Domain') }, ['app', 'domain'])),
    change('enable_ssl', 'Issue a free SSL certificate for a connected domain.', obj({ domain: str('Domain') }, ['domain'])),
  ];
}

// ---------- loop ----------

export const SYSTEM_PROMPT = [
  'تو «همیار» هستی: همکار DevOps و SRE برای برنامه‌هایی که روی لیارا اجرا می‌شوند. کاربر ممکن است دانش فنی کمی داشته باشد.',
  'همیشه فارسی، کوتاه و ساده جواب بده. اصطلاح فنی را یک‌بار ساده توضیح بده.',
  'برای شکایت از کندی، قطعی یا خطا اول diagnose را اجرا کن. علت اصلی را با شماره‌ی شواهد (مثل E1) توضیح بده، فرضیه‌های ردشده را خیلی کوتاه بگو، و اولین راه‌حل قابل‌اجرا را پیشنهاد بده.',
  'ابزارهای تغییر (deploy، set_env، restart_app، resize_plan، rollback و…) در داشبورد کارت تأیید نشان می‌دهند و تا کاربر تأیید نکند اجرا نمی‌شوند. خودت تأیید را فرض نکن.',
  'هرگز از کاربر نخواه رمز، کلید یا مقدار محرمانه را در چت بنویسد. برای set_env فقط نام متغیر را در keys بده؛ کاربر مقدار را در کارت وارد می‌کند.',
  'بعد از هر اصلاح، verify را اجرا کن و نتیجه را با عدد قبل و بعد بگو. اگر verify شکست خورد، راه‌حل بعدی یا rollback را پیشنهاد بده.',
  'اگر راه‌حل تغییر کد است، محل دقیق (فایل:خط) و تغییر پیشنهادی را بگو و توضیح بده که Coding Agent (مثلاً Claude Code با MCP همیار) می‌تواند آن را انجام دهد.',
  'حذف برنامه، دیسک، دیتابیس یا دامنه عمداً پشتیبانی نمی‌شود؛ بگو از کنسول لیارا انجام دهند. اگر داده‌ای در API لیارا در دسترس نیست، صادقانه بگو.',
].join('\n');

export async function runAgent(opts: {
  llm: LLM;
  tools: AgentTool[];
  history: ChatMessage[];
  userMessage: string;
  hooks: AgentHooks;
  maxSteps?: number;
  system?: string;
}): Promise<ChatMessage[]> {
  const { llm, tools, hooks } = opts;
  const redactor = createRedactor();
  const specs: ToolSpec[] = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const messages: ChatMessage[] = [{ role: 'system', content: opts.system ?? SYSTEM_PROMPT }, ...opts.history, { role: 'user', content: opts.userMessage }];
  const maxSteps = opts.maxSteps ?? 10;

  for (let step = 0; step < maxSteps; step++) {
    const reply = await llm.chat(messages, specs);
    if (!reply.tool_calls?.length) {
      const text = reply.content ?? '';
      messages.push({ role: 'assistant', content: text });
      hooks.onEvent({ type: 'assistant', text: redactor.unmask(text) });
      return messages.slice(1);
    }

    messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls });
    if (reply.content) hooks.onEvent({ type: 'assistant', text: redactor.unmask(reply.content) });

    for (const call of reply.tool_calls) {
      const tool = tools.find((t) => t.name === call.function.name);
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {}
      hooks.onEvent({ type: 'tool', name: call.function.name, status: 'start', args });

      let output: string;
      if (!tool) {
        output = `ابزار «${call.function.name}» وجود ندارد. عملیات حذف عمداً در همیار نیست.`;
        hooks.onEvent({ type: 'tool', name: call.function.name, status: 'error', output });
      } else {
        try {
          output = await tool.run(args, hooks);
          hooks.onEvent({ type: 'tool', name: tool.name, status: output.startsWith('❌') ? 'error' : 'done', output });
        } catch (err: any) {
          output = `❌ ${err?.explanation ?? err?.message ?? String(err)}`;
          hooks.onEvent({ type: 'tool', name: tool.name, status: 'error', output });
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: redactor.mask(output) });
    }
  }

  const text = 'به سقف مراحل این گفت‌وگو رسیدم؛ اگر لازم است، درخواست را دقیق‌تر یا در چند مرحله بپرسید.';
  messages.push({ role: 'assistant', content: text });
  hooks.onEvent({ type: 'assistant', text });
  return messages.slice(1);
}
