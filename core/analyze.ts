// Builds the "launch plan" shown to the user before the first deploy:
// what Hamyar detected, which env vars are missing, which plan it recommends and why,
// and whether the account balance covers it. Read-only: makes GET requests only.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject, type Detection } from './detect.js';
import { scanEnv, type EnvScan } from './env-scan.js';
import { recommendPlan, toPlanList, type PlanAdvice } from './plan-advisor.js';
import { listFiles } from './pack.js';
import type { LiaraClient } from './liara-client.js';

export interface LaunchPlan {
  dir: string;
  detection: Detection;
  env: EnvScan;
  advice: PlanAdvice;
  balance: number;
  // enough balance for at least one day on the recommended plan
  balanceOk: boolean;
  fileCount: number;
  liaraJson: Record<string, unknown>;
}

function dependencies(dir: string): string[] {
  const deps: string[] = [];
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    deps.push(...Object.keys(pkg.dependencies ?? {}));
  }
  const reqPath = join(dir, 'requirements.txt');
  if (existsSync(reqPath)) {
    for (const line of readFileSync(reqPath, 'utf8').split(/\r?\n/)) {
      const name = line.trim().split(/[=<>~!\[; ]/)[0]?.toLowerCase();
      if (name && !name.startsWith('#')) deps.push(name);
    }
  }
  return deps;
}

// A dedicated health route; probing `/` would mark a release unhealthy whenever the
// home page itself fails (for example on a missing DATABASE_URL).
function findHealthPath(dir: string, files: string[]): string | undefined {
  for (const file of files.filter((f) => /\.(js|ts|mjs|cjs|py|php|go)$/.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const m = text.match(/['"](\/(?:health|healthz|ping|status))['"]/);
    if (m) return m[1];
  }
  return undefined;
}

export function buildLiaraJson(app: string, d: Detection, healthPath?: string): Record<string, unknown> {
  const url = `http://localhost:${d.port}${healthPath}`;
  // Node images may lack curl, so node apps check themselves with node's fetch.
  const command = ['node', 'next'].includes(d.platform)
    ? `node -e "fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`
    : `curl -fsS ${url} || exit 1`;
  return {
    app,
    platform: d.platform,
    port: d.port,
    ...(d.version ? { [d.platform]: { version: d.version } } : {}),
    // Liara keeps the old release serving until this passes (zero-downtime deploys).
    ...(healthPath ? { healthCheck: { command, interval: 30, timeout: 10, retries: 3, startPeriod: 20 } } : {}),
  };
}

const fa = (n: number) => n.toLocaleString('fa-IR');

export function renderLaunchPlan(plan: LaunchPlan): string {
  const { detection: d, env, advice } = plan;
  const out: string[] = [];
  out.push(`📦 پروژه: ${plan.dir}`);
  out.push(`   پلتفرم: ${d.platform}   پورت: ${d.port}${d.startCommand ? `   اجرا: ${d.startCommand}` : ''}${d.version ? `   نسخه: ${d.version}` : ''}`);
  d.reasons.forEach((r) => out.push(`   · ${r}`));
  if (d.conflict) out.push(`   ⚠️ ${d.conflict}`);
  d.warnings.forEach((w) => out.push(`   ⚠️ ${w}`));
  out.push(`   فایل‌هایی که آپلود می‌شوند: ${fa(plan.fileCount)}`);

  out.push('', '🔑 متغیرهای محیطی');
  if (!env.used.length) out.push('   کد هیچ متغیر محیطی‌ای نمی‌خواند.');
  for (const m of env.missing) {
    const tag = m.optional ? 'اختیاری (مقدار پیش‌فرض دارد)' : 'لازم';
    out.push(`   - ${m.name}: ${tag}${m.documented ? '، در .env.example هست' : ''}  ← ${m.locations[0]}`);
  }

  out.push('', `💳 پلن پیشنهادی: ${advice.plan.id} — ماهانه ${fa(advice.plan.monthly)} تومان`);
  advice.reasons.forEach((r) => out.push(`   · ${r}`));
  if (advice.bigger) out.push(`   گزینه‌ی بزرگ‌تر: ${advice.bigger.id} (${fa(advice.bigger.ramGB)} گیگ رم، ${fa(advice.bigger.monthly)} تومان)`);

  out.push('', `💰 موجودی حساب: ${fa(Math.round(plan.balance))} تومان ${plan.balanceOk ? '✅' : '❌ برای دیپلوی، حساب را شارژ کنید'}`);
  out.push('', `📝 liara.json پیشنهادی:\n${JSON.stringify(plan.liaraJson, null, 2)}`);
  return out.join('\n');
}

export async function analyzeProject(client: LiaraClient, dir: string, app: string): Promise<LaunchPlan> {
  const detection = detectProject(dir);
  const [rawPlans, balance] = await Promise.all([client.appPlans(), client.balance()]);
  const advice = recommendPlan({ platform: detection.platform, dependencies: dependencies(dir) }, toPlanList(rawPlans));
  const files = listFiles(dir, detection.platform);
  return {
    dir,
    detection,
    env: scanEnv(dir),
    advice,
    balance,
    balanceOk: balance >= advice.plan.hourly * 24,
    fileCount: files.length,
    liaraJson: buildLiaraJson(app, detection, findHealthPath(dir, files)),
  };
}
