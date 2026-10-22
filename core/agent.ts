// The dashboard's agent loop over an OpenAI-compatible model (Liara AI).
// The model plans and explains; tools do the work; changes pause for a human
// decision in the UI; tool output is redacted before the model sees it.
import type { OpsContext } from './ops.js';
import * as ops from './ops.js';
import { ACTIONS, runAction, type Preview } from './actions.js';
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

export class AIProviderError extends Error {
  constructor(
    public explanation: string,
    public status?: number,
    public retryAfterSeconds?: number,
  ) {
    super(explanation);
  }
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function providerError(provider: string, status: number, retryAfter?: number): AIProviderError {
  if (status === 401 || status === 403) {
    return new AIProviderError(`اتصال به ${provider} رد شد. کلید API و دسترسی آن را در تنظیمات بررسی کنید.`, status);
  }
  if (status === 404) {
    return new AIProviderError(`مدل انتخاب‌شده در ${provider} در دسترس نیست. نام مدل را در تنظیمات بررسی کنید.`, status);
  }
  if (status === 429) {
    const wait = retryAfter ? ` حدود ${retryAfter.toLocaleString('fa-IR')} ثانیه` : ' کمی';
    return new AIProviderError(`سقف درخواست‌های ${provider} پر شده است.${wait} صبر کنید و دوباره تلاش کنید.`, status, retryAfter);
  }
  if (status >= 500) return new AIProviderError(`${provider} موقتاً پاسخ نمی‌دهد. چند دقیقه‌ی دیگر دوباره تلاش کنید.`, status);
  return new AIProviderError(`درخواست هوش مصنوعی در ${provider} انجام نشد. تنظیمات مدل را بررسی کنید.`, status);
}

export function openAICompatibleLLM(opts: { url: string; apiKey: string; model: string; timeoutMs?: number; provider?: string; reasoningEffort?: string }): LLM {
  return {
    async chat(messages, tools) {
      const provider = opts.provider ?? 'سرویس هوش مصنوعی';
      let res: Response;
      try {
        res = await fetch(opts.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            messages,
            ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: 'auto' } : {}),
            // some reasoning models reject tool calls on chat/completions unless reasoning is off
            ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : { temperature: 0.2 }),
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
      } catch (err: any) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new AIProviderError(`پاسخ ${provider} بیش از حد طول کشید. دوباره تلاش کنید.`);
        }
        throw new AIProviderError(`ارتباط با ${provider} برقرار نشد. اینترنت و آدرس API را بررسی کنید.`);
      }
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw providerError(provider, res.status, retryAfterSeconds(res.headers.get('retry-after')));
      const message = body.choices?.[0]?.message;
      if (!message) throw new AIProviderError(`${provider} پاسخ قابل‌استفاده‌ای برنگرداند. دوباره تلاش کنید.`);
      return message;
    },
  };
}

// Model provider from env, first match wins:
// 1. Liara AI with an API key: LIARA_AI_API_KEY + LIARA_AI_BASE_URL
// 2. Liara AI with the console token: LIARA_AI_WORKSPACE_ID (+ LIARA_API_TOKEN)
// 3. CodeCraft API: CODECRAFT_API_KEY (+ optional base/model overrides)
// 4. any OpenAI-compatible provider: AI_API_KEY + AI_BASE_URL (e.g. https://ai.boxapi.ir/ai/v1)
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): (LLM & { provider: string; model: string }) | undefined {
  const pick = (provider: string, base: string, apiKey: string, model: string, reasoningEffort = env.AI_REASONING_EFFORT) => ({
    ...openAICompatibleLLM({ url: `${base.replace(/\/$/, '')}/chat/completions`, apiKey, model, provider, reasoningEffort: reasoningEffort || undefined }),
    provider,
    model,
  });
  if (env.LIARA_AI_API_KEY && env.LIARA_AI_BASE_URL) return pick('Liara AI', env.LIARA_AI_BASE_URL, env.LIARA_AI_API_KEY, env.LIARA_AI_MODEL || 'openai/gpt-4.1');
  if (env.LIARA_AI_WORKSPACE_ID && env.LIARA_API_TOKEN) {
    return pick('Liara AI', `https://ai.liara.ir/api/v1/${env.LIARA_AI_WORKSPACE_ID}/playground`, env.LIARA_API_TOKEN, env.LIARA_AI_MODEL || 'openai/gpt-4.1');
  }
  if (env.CODECRAFT_API_KEY) {
    return pick('CodeCraft API', env.CODECRAFT_BASE_URL || 'https://codecraftapi.com/v1', env.CODECRAFT_API_KEY, env.CODECRAFT_MODEL || 'gpt-5.6-sol', env.CODECRAFT_REASONING_EFFORT || 'none');
  }
  if (env.AI_API_KEY && env.AI_BASE_URL) {
    let provider = 'OpenAI-compatible API';
    try {
      provider = new URL(env.AI_BASE_URL).hostname;
    } catch {}
    return pick(provider, env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL || 'anthropic/claude-sonnet-5.5');
  }
  return undefined;
}

// ---------- events and approvals ----------

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; status: 'start' | 'done' | 'error'; args?: Record<string, unknown>; output?: string; data?: unknown }
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
  by?: string;
}

export interface AgentHooks {
  onEvent(e: AgentEvent): void;
  requestApproval(r: ApprovalRequest): Promise<ApprovalDecision>;
}

// `data` is structured output for the dashboard only; the model sees `text`.
export type ToolResult = string | { text: string; data?: unknown };

export interface AgentTool extends ToolSpec {
  kind: 'read' | 'change';
  run(args: Record<string, any>, hooks: AgentHooks): Promise<ToolResult>;
}

// ---------- tools ----------

const str = (description: string) => ({ type: 'string', description });
const appParam = str('Liara app name');
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

// The requestApproval hook is the trust boundary: implementations must resolve it only
// from a human (the dashboard resolves it from an authenticated /api/approve call).
// The decision is recorded in the shared approval store before anything executes.
function recordDecision(ctx: OpsContext, id: string, d: ApprovalDecision) {
  const rec = ctx.policy.approvals.get(id);
  if (rec?.status === 'pending') ctx.policy.approvals.decide(id, { approved: d.approved, by: d.by ?? 'user', channel: 'dashboard', reason: d.reason });
}

async function runChange(ctx: OpsContext, tool: string, args: Record<string, any>, hooks: AgentHooks): Promise<string> {
  const onEvent = (e: DeployEvent) => hooks.onEvent({ type: 'progress', tool, phase: e.phase, message: e.message });
  const finish = (r: Awaited<ReturnType<typeof runAction>>) =>
    r.status === 'done' ? ops.renderDone(tool, r.result, []) : `❌ ${'error' in r ? r.error : r.status}`;
  const rejected = (tier: Tier, id: string, reason?: string) => {
    ctx.policy.audit({ tool, tier, args, outcome: 'rejected', approvedBy: 'user (dashboard)', approvalId: id, detail: reason });
    return `🚫 کاربر این عملیات را رد کرد. دلیل: ${reason || 'بدون دلیل'}. راه دیگری پیشنهاد بده یا بپرس چه می‌خواهد.`;
  };

  // Secret env values (set_env, or a first deploy that needs env vars): the model names
  // the keys, the human types the values on the approval card.
  if ((tool === 'set_env' || tool === 'launch_app') && Array.isArray(args.keys) && args.keys.length) {
    const keys: string[] = args.keys;
    const { keys: _keys, ...rest } = args;
    const valueLines = keys.map((k) => `${k}: مقدار را خودتان وارد کنید (به هوش مصنوعی داده نمی‌شود)`);
    const preview =
      tool === 'launch_app'
        ? await (async () => {
            const p = await ACTIONS.launch_app.preview(ctx.client, { ...rest, variables: keys.map((k) => ({ key: k, value: '' })) });
            return { ...p, lines: [...p.lines.filter((l) => !l.startsWith('متغیرهایی که')), ...valueLines] };
          })()
        : {
            title: `تنظیم متغیرهای محیطی ${args.app}`,
            lines: [...valueLines, 'متغیرهای فعلی حفظ می‌شوند.'],
            risk: 'کم', downtime: 'یک ری‌استارت کوتاه', undo: 'تغییر دوباره‌ی مقدار',
          };
    ctx.policy.assertAllowed(tool, 'T2');
    const card = ctx.policy.approvals.request({ tool, tier: 'T2', args: { ...rest, keys }, preview, source: 'dashboard' });
    const decision = await hooks.requestApproval({ id: card.id, tool, tier: 'T2', needsValues: keys, preview });
    recordDecision(ctx, card.id, decision);
    if (!decision.approved) return rejected('T2', card.id, decision.reason);
    const missing = keys.filter((k) => !decision.values?.[k]);
    if (missing.length) return `❌ مقدار ${missing.join(', ')} وارد نشد؛ کاری انجام نشد.`;
    // The same human submission (approve + values) authorizes the concrete arguments.
    const real = { ...rest, variables: [...(args.variables ?? []), ...keys.map((k) => ({ key: k, value: decision.values![k] }))] };
    const filed = await runAction(ctx, tool, real, undefined, onEvent);
    if (filed.status !== 'needs_approval') return finish(filed);
    ctx.policy.approvals.decide(filed.approvalId, { approved: true, by: decision.by ?? 'user', channel: 'dashboard', reason: `مقادیر همراه با تأیید ${card.id}` });
    return finish(await runAction(ctx, tool, real, { approvalId: filed.approvalId }, onEvent));
  }

  const first = await runAction(ctx, tool, args, undefined, onEvent);
  if (first.status !== 'needs_approval') return finish(first);
  const decision = await hooks.requestApproval({ id: first.approvalId, tool, tier: first.tier, preview: first.preview });
  recordDecision(ctx, first.approvalId, decision);
  if (!decision.approved) return rejected(first.tier, first.approvalId, decision.reason);
  return finish(await runAction(ctx, tool, args, { approvalId: first.approvalId }, onEvent));
}

export function buildTools(ctx: OpsContext): AgentTool[] {
  const read = (name: string, description: string, parameters: Record<string, unknown>, fn: (a: any) => Promise<ToolResult>): AgentTool => ({
    name, description, parameters, kind: 'read', run: (a) => fn(a),
  });
  const change = (name: string, description: string, parameters: Record<string, unknown>): AgentTool => ({
    name, description: `${description} Pauses for the user's approval in the dashboard.`, parameters, kind: 'change',
    run: (a, hooks) => runChange(ctx, name, a, hooks),
  });

  return [
    read('liara_overview', 'Account balance, apps with status and plan, safety mode, latest actions.', obj({}), () => ops.overview(ctx)),
    read('list_plans', 'Every plan this Liara account can buy, with the feature plans (bundlePlanID) of g2 plans and the full monthly price. Use when the user asks which plans exist, wants to choose one, or a plan was refused.', obj({}), () => ops.plansText(ctx)),
    read('analyze_project', 'Analyze a project folder on the server for deployment: platform, port, needed env vars, recommended plan with price, balance check.',
      obj({ dir: str('Project folder path'), app: str('Desired app name') }, ['dir']), (a) => ops.analyzeText(ctx, a.dir, a.app)),
    read('app_status', 'Status, plan, current release, env var names and live probe of an app.', obj({ app: appParam }, ['app']), (a) => ops.appStatus(ctx, a.app)),
    read('get_logs', 'Recent runtime logs grouped into patterns, errors first.',
      obj({ app: appParam, minutes: { type: 'number' }, errorsOnly: { type: 'boolean' } }, ['app']), (a) => ops.logsText(ctx, a.app, a.minutes ?? 30, a.errorsOnly ?? false)),
    read('diagnose', 'SRE investigation: logs, events, CPU/RAM, releases and live probe → hypothesis board with root cause, evidence ids and ranked fixes. Use for any "slow", "down", "500", "error" complaint.',
      obj({ app: appParam, path: str('URL path to probe, e.g. /products'), minutes: { type: 'number' } }, ['app']),
      async (a) => {
        const { text, board, incident } = await ops.diagnoseText(ctx, a.app, { path: a.path, minutes: a.minutes });
        return { text, data: { ...ops.boardSummary(board), incidentId: incident?.id } };
      }),
    read('verify', 'After a fix: probe the site several times and compare with targets fixed before the change.',
      obj({ app: appParam, path: str('URL path') }, ['app']), async (a) => {
        const { text, passed, rows } = await ops.verifyText(ctx, a.app, a.path);
        return { text, data: { kind: 'verify', passed, rows } };
      }),
    read('check_domain', 'Domain setup guide and status: Liara status, Liara DNS, public DNS visibility, exact records or nameservers to set at the registrar (IRNIC), next step. Use for any domain question.',
      obj({ app: appParam, domain: str('Domain, e.g. shop.ir') }, ['app']), (a) => ops.checkDomainText(ctx, a.app, a.domain)),
    read('incident_report', 'Persian postmortem of the last diagnose and the actions since.', obj({ app: appParam }, ['app']), (a) => ops.incidentReportText(ctx, a.app)),
    read('audit_log', 'Latest actions with approvals.', obj({ limit: { type: 'number' } }), async (a) => ops.auditText(ctx, a.limit ?? 20)),

    change('launch_app', 'Create an app on a plan and deploy a folder for the first time. Pass the env var NAMES the code needs (from analyze_project) in `keys`; the user types the values on the approval card before the deploy.',
      obj({ app: appParam, dir: str('Project folder'), planID: str('Plan id from analyze_project or list_plans'), bundlePlanID: str('Feature plan for a g2 plan (from list_plans); omit for the cheapest with rollback'), keys: { type: 'array', items: { type: 'string' } } }, ['app', 'dir', 'planID'])),
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
  // e.g. the selected app's env values: masked wherever they appear in tool output
  knownSecrets?: string[];
}): Promise<ChatMessage[]> {
  const { llm, tools, hooks } = opts;
  const redactor = createRedactor(opts.knownSecrets);
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
          const result = await tool.run(args, hooks);
          output = typeof result === 'string' ? result : result.text;
          const data = typeof result === 'string' ? undefined : result.data;
          hooks.onEvent({ type: 'tool', name: tool.name, status: output.startsWith('❌') ? 'error' : 'done', output, ...(data ? { data } : {}) });
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
