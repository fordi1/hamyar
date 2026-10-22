// Explainable, rule-based plan recommendation over the live plan catalogue
// from `GET /v1/me` → plans.projects. Reasons are in Persian for the user.
import type { Platform } from './detect.js';

export interface Plan {
  id: string;
  ramGB: number;
  cpu: number;
  hourly: number;
  // toman per month
  monthly: number;
  region?: string;
}

export interface PlanInput {
  platform: Platform;
  dependencies: string[];
  // memory the app actually uses today (from metrics), if it is already deployed
  observedMemoryGB?: number;
}

export interface PlanAdvice {
  plan: Plan;
  neededRamGB: number;
  reasons: string[];
  cheaper?: Plan;
  bigger?: Plan;
}

const HOURS_PER_MONTH = 720;

export function toPlanList(raw: Record<string, any>): Plan[] {
  return Object.entries(raw)
    .filter(([id, p]) => p?.available && id !== 'database-control-panel' && p.RAM?.amount)
    .map(([id, p]) => ({
      id,
      ramGB: p.RAM.amount,
      cpu: p.CPU?.amount ?? 0,
      hourly: p.price,
      // hourly prices are truncated, so round the monthly figure to whole thousands of toman
      monthly: p.displayPrice ?? Math.round((p.price * HOURS_PER_MONTH) / 1000) * 1000,
      region: p.region,
    }))
    .sort((a, b) => a.monthly - b.monthly || b.ramGB - a.ramGB);
}

// The plans the Liara CLI offers for new apps (`app:create` keeps g2 plans in Iran).
// Older plans may still be listed as available but are not offered here.
export function deployablePlans(raw: Record<string, any>): Plan[] {
  return toPlanList(raw).filter((p) => p.id.includes('g2'));
}

// ---------- feature bundle plans ----------
// A g2 app also needs a "feature plan" (`bundlePlanID`) from `GET /v1/me` →
// plans.projectBundlePlans[planID]. It is billed on top of the plan and decides features
// such as rollback, zero-downtime deploys and log retention.

export interface FeatureBundle {
  id: string;
  hourly: number;
  monthly: number;
  rollback: boolean;
  zeroDowntime: boolean;
  logsDays: number;
}

export function toBundleList(raw: Record<string, any>, planID: string): FeatureBundle[] {
  return Object.entries<any>(raw?.[planID] ?? {})
    .filter(([, b]) => b?.available)
    .map(([id, b]) => ({
      id,
      hourly: Number(b.price) || 0,
      monthly: b.displayPrice ?? Math.round(((Number(b.price) || 0) * HOURS_PER_MONTH) / 1000) * 1000,
      rollback: Boolean(b.rollback),
      zeroDowntime: Boolean(b.zeroDowntime),
      logsDays: Number(b.maxLogsRetention) || 0,
    }))
    .sort((a, b) => a.hourly - b.hourly);
}

// Rollback is part of how Hamyar recovers from a bad release, so prefer the cheapest bundle with it.
export function defaultBundle(bundles: FeatureBundle[]): FeatureBundle | undefined {
  return bundles.find((b) => b.rollback) ?? bundles[0];
}

// ---------- full catalogue for the user to choose from ----------

export interface CatalogEntry extends Plan {
  // g2 plans choose among priced feature plans; older ("classic") plans get the free g1 "default"
  generation: 'g2' | 'classic';
  bundles: FeatureBundle[];
  defaultBundle?: string;
  totalHourly: number;
  totalMonthly: number;
  // enough memory for the project
  fits: boolean;
}

// `blocked`: plan ids, or "g2" for the whole family, that Liara refused to create for this account.
export function planCatalog(rawPlans: Record<string, any>, rawBundles: Record<string, any>, neededRamGB: number, opts: { blocked?: string[] } = {}): CatalogEntry[] {
  const blocked = new Set(opts.blocked ?? []);
  // only g2 plans: Liara's create endpoint takes bundlePlanID free/basic/standard/pro (an older
  // plan's "default" bundle is refused) and the CLI offers only g2 plans for new apps
  return deployablePlans(rawPlans)
    .filter((p) => !blocked.has(p.id) && !blocked.has('g2'))
    .map((p) => {
      const generation: CatalogEntry['generation'] = p.id.includes('g2') ? 'g2' : 'classic';
      const bundles = toBundleList(rawBundles, p.id);
      const chosen = defaultBundle(bundles);
      return {
        ...p,
        generation,
        bundles,
        defaultBundle: chosen?.id,
        totalHourly: p.hourly + (chosen?.hourly ?? 0),
        totalMonthly: p.monthly + (chosen?.monthly ?? 0),
        fits: p.ramGB >= neededRamGB,
      };
    })
    .sort((a, b) => a.totalMonthly - b.totalMonthly || b.ramGB - a.ramGB);
}

const BASE_RAM: Record<Platform, number> = {
  static: 0.25, react: 0.25, vue: 0.25, angular: 0.25,
  node: 0.5, php: 0.5, python: 0.5, flask: 0.5, go: 0.5, docker: 0.5,
  next: 1, django: 1, laravel: 1, wordpress: 1, dotnet: 1,
};

const HEAVY_DEPS: Record<string, number> = {
  puppeteer: 2, playwright: 2, 'playwright-core': 2,
  tensorflow: 4, '@tensorflow/tfjs-node': 4, torch: 4, transformers: 4,
  sharp: 1, canvas: 1, celery: 1, pandas: 1, numpy: 1,
};

// Keep actual usage under 70 % of the plan so spikes don't cause OOM kills.
const HEADROOM = 0.7;

const fmt = (n: number) => n.toLocaleString('fa-IR');

export function recommendPlan(input: PlanInput, plans: Plan[]): PlanAdvice {
  if (!plans.length) throw new Error('No available plans in the catalogue');
  const reasons: string[] = [];

  let need = BASE_RAM[input.platform];
  reasons.push(`پلتفرم ${input.platform} معمولاً حداقل ${fmt(need)} گیگابایت رم لازم دارد.`);

  for (const dep of input.dependencies) {
    const heavy = HEAVY_DEPS[dep];
    if (heavy && heavy > need) {
      need = heavy;
      reasons.push(`وابستگی ${dep} حافظه‌ی زیادی مصرف می‌کند، پس حداقل ${fmt(heavy)} گیگابایت رم پیشنهاد می‌شود.`);
    }
  }

  if (input.observedMemoryGB !== undefined) {
    const fromUsage = input.observedMemoryGB / HEADROOM;
    if (fromUsage > need) {
      need = fromUsage;
      reasons.push(
        `برنامه الان حدود ${fmt(Math.round(input.observedMemoryGB * 100) / 100)} گیگابایت رم مصرف می‌کند؛ برای اینکه زیر ۷۰٪ ظرفیت بماند، حداقل ${fmt(Math.round(fromUsage * 100) / 100)} گیگابایت لازم است.`,
      );
    }
  }

  const fitting = plans.filter((p) => p.ramGB >= need);
  const byRam = [...plans].sort((a, b) => a.ramGB - b.ramGB || a.monthly - b.monthly);
  let plan: Plan;
  if (fitting.length) {
    plan = fitting[0];
    reasons.push(`ارزان‌ترین پلن با این مقدار رم «${plan.id}» است: ${fmt(plan.ramGB)} گیگ رم، ${fmt(plan.cpu)} هسته CPU، ماهانه حدود ${fmt(plan.monthly)} تومان.`);
  } else {
    plan = byRam[byRam.length - 1];
    reasons.push(`هیچ پلنی این مقدار رم ندارد؛ بزرگ‌ترین پلن موجود «${plan.id}» پیشنهاد می‌شود و بهتر است مصرف حافظه در کد هم بررسی شود.`);
  }

  const idx = byRam.findIndex((p) => p.id === plan.id);
  const cheaper = [...plans].filter((p) => p.monthly < plan.monthly).pop();
  const bigger = byRam.slice(idx + 1).find((p) => p.ramGB > plan.ramGB);

  return { plan, neededRamGB: Math.round(need * 100) / 100, reasons, cheaper, bigger };
}
