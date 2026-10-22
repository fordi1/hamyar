// The guided first deploy behind the dashboard wizard: analyze a prepared source, file one
// approval request (env keys named, values typed by the human), then run launch_app with
// the values only after that request is approved here. Same path and checks as the agent's
// values card (core/agent.ts runChange), without the model in between.
import { analyzeProject } from './analyze.js';
import { ACTIONS, runAction, type ActionResult } from './actions.js';
import { planCatalog, toBundleList, toPlanList, type CatalogEntry, type FeatureBundle } from './plan-advisor.js';
import { appNameProblem, suggestAppName } from './sources.js';
import type { DeployEvent } from './deployer.js';
import type { LiaraClient } from './liara-client.js';
import type { Policy } from './policy.js';

export class WizardError extends Error {}

type Ctx = { client: LiaraClient; policy: Policy };

// A plan the user can buy: catalogue entry + whether the balance carries a day of it.
export interface CatalogOption extends CatalogEntry {
  // the feature plan used unless the user picks another (cheapest with rollback)
  bundle?: FeatureBundle;
  affordable: boolean;
}

export interface PlanOption extends CatalogOption {
  role: 'cheaper' | 'recommended' | 'bigger';
}

export interface SourceAnalysis {
  app: string;
  nameProblem?: string;
  existingApps: string[];
  detection: { platform: string; port: number; startCommand?: string; version?: string; reasons: string[]; warnings: string[]; conflict?: string };
  env: { required: { name: string; location: string; documented: boolean }[]; optional: { name: string; location: string }[] };
  // three suggestions, and every plan the account can buy (minus families Liara refused)
  plans: PlanOption[];
  catalog: CatalogOption[];
  neededRamGB: number;
  planReasons: string[];
  balance: number;
  fileCount: number;
  healthPath?: string;
  liaraJson: Record<string, unknown>;
}

const affordable = (hourly: number, balance: number) => balance >= hourly * 24;

const asOption = (e: CatalogEntry, balance: number): CatalogOption => ({
  ...e,
  bundle: e.bundles.find((b) => b.id === e.defaultBundle),
  affordable: affordable(e.totalHourly, balance),
});

// cheapest plan that fits, one cheaper (it may be too small) and the next bigger one
function suggestions(catalog: CatalogOption[]): PlanOption[] {
  const recommended = catalog.find((p) => p.fits) ?? catalog[catalog.length - 1];
  if (!recommended) return [];
  const cheaper = catalog.filter((p) => p.totalMonthly < recommended.totalMonthly).pop();
  const bigger = catalog.find((p) => p.ramGB > recommended.ramGB && p.fits);
  return [
    ...(cheaper ? [{ ...cheaper, role: 'cheaper' as const }] : []),
    { ...recommended, role: 'recommended' as const },
    ...(bigger ? [{ ...bigger, role: 'bigger' as const }] : []),
  ];
}

export async function analyzeSource(ctx: Ctx, dir: string, nameHint: string, opts: { blocked?: string[] } = {}): Promise<SourceAnalysis> {
  const app = suggestAppName(nameHint);
  const [plan, apps, rawPlans, bundles] = await Promise.all([
    analyzeProject(ctx.client, dir, app),
    ctx.client.listApps().catch(() => []),
    ctx.client.appPlans(),
    ctx.client.bundlePlans().catch(() => ({})),
  ]);
  const { detection: d, env, advice, balance } = plan;
  const catalog = planCatalog(rawPlans, bundles, advice.neededRamGB, { blocked: opts.blocked }).map((e) => asOption(e, balance));
  const options = suggestions(catalog);
  const chosen = options.find((o) => o.role === 'recommended');
  const planReasons = [
    ...advice.reasons.filter((r) => !r.startsWith('ارزان‌ترین پلن')),
    ...(chosen ? [`ارزان‌ترین پلنی که این مقدار رم را دارد «${chosen.id}» است: ماهانه حدود ${chosen.totalMonthly.toLocaleString('fa-IR')} تومان${chosen.bundle ? ` با پلن امکانات ${chosen.bundle.id}` : ''}.`] : []),
    ...(opts.blocked?.length ? [`لیارا این پلن‌ها را برای حساب شما نساخت و کنار گذاشته شدند: ${opts.blocked.join('، ')}.`] : []),
  ];
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
    catalog,
    neededRamGB: advice.neededRamGB,
    planReasons,
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

export async function requestDeploy(ctx: Ctx, input: { dir: string; app: string; planID: string; bundlePlanID?: string; keys: string[] }): Promise<DeployRequest> {
  const { dir, app, planID } = input;
  const keys = [...new Set(input.keys.filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))];
  const problem = appNameProblem(app);
  if (problem) throw new WizardError(problem);
  const [apps, rawPlans, bundles, balance] = await Promise.all([ctx.client.listApps(), ctx.client.appPlans(), ctx.client.bundlePlans().catch(() => ({})), ctx.client.balance()]);
  if (apps.some((a: any) => a.project_id === app)) {
    throw new WizardError(`برنامه‌ای به نام ${app} را از قبل دارید. برای نسخه‌ی جدید آن، از گفت‌وگو «انتشار نسخه‌ی جدید» را بخواهید؛ یا نام دیگری انتخاب کنید.`);
  }
  const plan = toPlanList(rawPlans).find((p) => p.id === planID);
  if (!plan) throw new WizardError(`پلن ${planID} در فهرست پلن‌های فعلی لیارا نیست؛ یک پلن دیگر انتخاب کنید.`);
  if (!planID.includes('g2')) throw new WizardError(`پلن ${planID} از نسل قدیمی لیاراست؛ API لیارا برنامه‌ی جدید را فقط روی پلن‌های g2 می‌سازد.`);
  // every plan needs a feature plan: the one the user picked, else the cheapest with rollback
  // (older plans have a single free "default")
  let bundle: FeatureBundle | undefined;
  {
    const list = toBundleList(bundles, planID);
    bundle = input.bundlePlanID ? list.find((b) => b.id === input.bundlePlanID) : (list.find((b) => b.rollback) ?? list[0]);
    if (!bundle) throw new WizardError(input.bundlePlanID ? `پلن امکانات «${input.bundlePlanID}» برای ${planID} در دسترس نیست.` : `برای ${planID} پلن امکاناتی در دسترس نیست؛ یک پلن دیگر انتخاب کنید.`);
  }
  if (!affordable(plan.hourly + (bundle?.hourly ?? 0), balance)) {
    throw new WizardError(`موجودی حساب (${Math.round(balance).toLocaleString('fa-IR')} تومان) برای یک روز پلن ${planID}${bundle ? ' با پلن امکاناتش' : ''} کافی نیست. اول حساب لیارا را شارژ کنید.`);
  }
  const bundlePlanID = bundle?.id;

  ctx.policy.assertAllowed('launch_app', 'T2');
  const base = await ACTIONS.launch_app.preview(ctx.client, { app, dir, planID, bundlePlanID, variables: keys.map((key) => ({ key, value: '' })) });
  const preview = {
    ...base,
    lines: [
      ...base.lines.filter((l) => !l.startsWith('متغیرهایی که')),
      ...(keys.length ? [`متغیرهایی که قبل از دیپلوی تنظیم می‌شوند: ${keys.join('، ')} (مقدارها فقط به لیارا می‌رود، نه هوش مصنوعی)`] : []),
    ],
  };
  const record = ctx.policy.approvals.request({ tool: 'launch_app', tier: 'T2', args: { app, dir, planID, ...(bundlePlanID ? { bundlePlanID } : {}), keys, wizard: true }, preview, source: 'dashboard' });
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
  const { app, dir, planID, bundlePlanID, keys = [] } = record.args as { app: string; dir: string; planID: string; bundlePlanID?: string; keys?: string[] };
  const missing = keys.filter((k) => !values[k]?.trim());
  if (missing.length) throw new WizardError(`مقدار ${missing.join('، ')} وارد نشده است.`);

  ctx.policy.approvals.decide(id, { approved: true, by: 'user', channel: 'dashboard' });
  ctx.policy.audit({ tool: 'launch_app', tier: 'T2', args: { app, planID, keys }, outcome: 'approved', approvedBy: 'user (dashboard)', approvalId: id });

  const real = { app, dir, planID, ...(bundlePlanID ? { bundlePlanID } : {}), variables: keys.map((key) => ({ key, value: values[key] })) };
  const filed = await runAction(ctx, 'launch_app', real, undefined, onEvent, 'dashboard');
  if (filed.status !== 'needs_approval') return filed;
  ctx.policy.approvals.decide(filed.approvalId, { approved: true, by: 'user', channel: 'dashboard', reason: `مقادیر همراه با تأیید ${id}` });
  return runAction(ctx, 'launch_app', real, { approvalId: filed.approvalId }, onEvent, 'dashboard');
}

export function cancelDeploy(ctx: Ctx, id: string, reason: string): void {
  const n = ctx.policy.approvals.revokeAll(reason, (r) => r.id === id && r.tool === 'launch_app' && r.source === 'dashboard');
  if (n) ctx.policy.audit({ tool: 'launch_app', tier: 'T2', args: {}, outcome: 'revoked', approvalId: id, detail: reason });
}
