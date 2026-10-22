// The guided first deploy behind the dashboard wizard: analyze a prepared source, file one
// approval request (env keys named, values typed by the human), then run launch_app with
// the values only after that request is approved here. Same path and checks as the agent's
// values card (core/agent.ts runChange), without the model in between.
import { analyzeProject } from './analyze.js';
import { ACTIONS, runAction, type ActionResult } from './actions.js';
import { toPlanList, type Plan } from './plan-advisor.js';
import { appNameProblem, suggestAppName } from './sources.js';
import type { DeployEvent } from './deployer.js';
import type { LiaraClient } from './liara-client.js';
import type { Policy } from './policy.js';

export class WizardError extends Error {}

type Ctx = { client: LiaraClient; policy: Policy };

export interface PlanOption extends Plan {
  role: 'cheaper' | 'recommended' | 'bigger';
  // the balance covers at least one day on this plan
  affordable: boolean;
}

export interface SourceAnalysis {
  app: string;
  nameProblem?: string;
  existingApps: string[];
  detection: { platform: string; port: number; startCommand?: string; version?: string; reasons: string[]; warnings: string[]; conflict?: string };
  env: { required: { name: string; location: string; documented: boolean }[]; optional: { name: string; location: string }[] };
  plans: PlanOption[];
  neededRamGB: number;
  planReasons: string[];
  balance: number;
  fileCount: number;
  healthPath?: string;
  liaraJson: Record<string, unknown>;
}

const affordable = (plan: Plan, balance: number) => balance >= plan.hourly * 24;

export async function analyzeSource(ctx: Ctx, dir: string, nameHint: string): Promise<SourceAnalysis> {
  const app = suggestAppName(nameHint);
  const [plan, apps] = await Promise.all([analyzeProject(ctx.client, dir, app), ctx.client.listApps().catch(() => [])]);
  const { detection: d, env, advice, balance } = plan;
  const options: PlanOption[] = [];
  if (advice.cheaper) options.push({ ...advice.cheaper, role: 'cheaper', affordable: affordable(advice.cheaper, balance) });
  options.push({ ...advice.plan, role: 'recommended', affordable: affordable(advice.plan, balance) });
  if (advice.bigger) options.push({ ...advice.bigger, role: 'bigger', affordable: affordable(advice.bigger, balance) });
  const healthCheck = plan.liaraJson.healthCheck as { command?: string } | undefined;
  return {
    app,
    nameProblem: appNameProblem(app),
    existingApps: apps.map((a: any) => a.project_id),
    detection: { platform: d.platform, port: d.port, startCommand: d.startCommand, version: d.version, reasons: d.reasons, warnings: d.warnings, conflict: d.conflict },
    env: {
      required: env.missing.filter((m) => !m.optional).map((m) => ({ name: m.name, location: m.locations[0], documented: m.documented })),
      optional: env.missing.filter((m) => m.optional).map((m) => ({ name: m.name, location: m.locations[0] })),
    },
    plans: options,
    neededRamGB: advice.neededRamGB,
    planReasons: advice.reasons,
    balance,
    fileCount: plan.fileCount,
    healthPath: healthCheck?.command?.match(/localhost:\d+(\/\S*)/)?.[1],
    liaraJson: plan.liaraJson,
  };
}

export interface DeployRequest {
  id: string;
  keys: string[];
  preview: Awaited<ReturnType<(typeof ACTIONS)['launch_app']['preview']>>;
  expiresAt: number;
}

export async function requestDeploy(ctx: Ctx, input: { dir: string; app: string; planID: string; keys: string[] }): Promise<DeployRequest> {
  const { dir, app, planID } = input;
  const keys = [...new Set(input.keys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))];
  const problem = appNameProblem(app);
  if (problem) throw new WizardError(problem);
  const [apps, rawPlans, balance] = await Promise.all([ctx.client.listApps(), ctx.client.appPlans(), ctx.client.balance()]);
  if (apps.some((a: any) => a.project_id === app)) {
    throw new WizardError(`برنامه‌ای به نام ${app} را از قبل دارید. برای نسخه‌ی جدید آن، از گفت‌وگو «انتشار نسخه‌ی جدید» را بخواهید؛ یا نام دیگری انتخاب کنید.`);
  }
  const plan = toPlanList(rawPlans).find((p) => p.id === planID);
  if (!plan) throw new WizardError(`پلن ${planID} در فهرست پلن‌های فعلی لیارا نیست؛ یک پلن دیگر انتخاب کنید.`);
  if (!affordable(plan, balance)) {
    throw new WizardError(`موجودی حساب (${Math.round(balance).toLocaleString('fa-IR')} تومان) برای یک روز پلن ${planID} کافی نیست. اول حساب لیارا را شارژ کنید.`);
  }

  ctx.policy.assertAllowed('launch_app', 'T2');
  const base = await ACTIONS.launch_app.preview(ctx.client, { app, dir, planID, variables: keys.map((key) => ({ key, value: '' })) });
  const preview = {
    ...base,
    lines: [
      ...base.lines.filter((l) => !l.startsWith('متغیرهایی که')),
      ...(keys.length ? [`متغیرهایی که قبل از دیپلوی تنظیم می‌شوند: ${keys.join('، ')} (مقدارها فقط به لیارا می‌رود، نه هوش مصنوعی)`] : []),
    ],
  };
  const record = ctx.policy.approvals.request({ tool: 'launch_app', tier: 'T2', args: { app, dir, planID, keys, wizard: true }, preview, source: 'dashboard' });
  ctx.policy.audit({ tool: 'launch_app', tier: 'T2', args: { app, planID, keys }, outcome: 'previewed', approvalId: record.id });
  return { id: record.id, keys, preview, expiresAt: record.expiresAt };
}

// The approve click on the wizard card: it decides the request and carries the values,
// so the same human submission authorizes the concrete arguments.
export async function startDeploy(ctx: Ctx, id: string, values: Record<string, string>, onEvent: (e: DeployEvent) => void): Promise<ActionResult> {
  const record = ctx.policy.approvals.get(id);
  if (!record || record.tool !== 'launch_app' || record.source !== 'dashboard' || !record.args.wizard) {
    throw new WizardError('این درخواست دیپلوی پیدا نشد؛ از ویزارد دوباره شروع کنید.');
  }
  if (record.status !== 'pending') throw new WizardError('این درخواست دیگر در انتظار نیست (اجرا، رد، لغو یا منقضی شده است).');
  const { app, dir, planID, keys = [] } = record.args as { app: string; dir: string; planID: string; keys?: string[] };
  const missing = keys.filter((k) => !values[k]?.trim());
  if (missing.length) throw new WizardError(`مقدار ${missing.join('، ')} وارد نشده است.`);

  ctx.policy.approvals.decide(id, { approved: true, by: 'user', channel: 'dashboard' });
  ctx.policy.audit({ tool: 'launch_app', tier: 'T2', args: { app, planID, keys }, outcome: 'approved', approvedBy: 'user (dashboard)', approvalId: id });

  const real = { app, dir, planID, variables: keys.map((key) => ({ key, value: values[key] })) };
  const filed = await runAction(ctx, 'launch_app', real, undefined, onEvent, 'dashboard');
  if (filed.status !== 'needs_approval') return filed;
  ctx.policy.approvals.decide(filed.approvalId, { approved: true, by: 'user', channel: 'dashboard', reason: `مقادیر همراه با تأیید ${id}` });
  return runAction(ctx, 'launch_app', real, { approvalId: filed.approvalId }, onEvent, 'dashboard');
}

export function cancelDeploy(ctx: Ctx, id: string, reason: string): void {
  const n = ctx.policy.approvals.revokeAll(reason, (r) => r.id === id && r.tool === 'launch_app' && r.source === 'dashboard');
  if (n) ctx.policy.audit({ tool: 'launch_app', tier: 'T2', args: {}, outcome: 'revoked', approvalId: id, detail: reason });
}
