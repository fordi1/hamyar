// Every state-changing operation Hamyar can perform, each with a risk tier, a
// human-readable preview, and an executor. runAction() is the single gate both the
// MCP server and the web dashboard go through, so the policy applies everywhere.
import { readFileSync } from 'node:fs';
import type { LiaraClient } from './liara-client.js';
import { Policy, PolicyError, type Tier } from './policy.js';
import { ApprovalError } from './approvals.js';
import { toPlanList } from './plan-advisor.js';
import { detectProject } from './detect.js';
import { listFiles } from './pack.js';
import { appUrl, deploySource, verifyDeployment, waitForRelease, type DeployEvent, type VerifyDeps } from './deployer.js';
import { LiaraError } from './liara-client.js';
import { registrarHint, requiredRecords, splitDomain } from './domain.js';
import { findHealthPath, healthCheckFor } from './analyze.js';
import { scanEnv } from './env-scan.js';

export interface Preview {
  title: string;
  lines: string[];
  risk: string;
  downtime: string;
  undo: string;
  cost?: string;
}

interface ActionDef {
  tier: Tier;
  preview(client: LiaraClient, args: any): Promise<Preview>;
  execute(client: LiaraClient, args: any, onEvent: (e: DeployEvent) => void, deps?: VerifyDeps): Promise<unknown>;
}

const fa = (n: number) => n.toLocaleString('fa-IR');

// ---------- env helpers ----------

export interface EnvVar {
  key: string;
  value: string;
}

export function envDiff(current: EnvVar[], updates: EnvVar[]) {
  const merged = current.map((v) => ({ key: v.key, value: v.value }));
  const added: string[] = [];
  const changed: string[] = [];
  for (const u of updates) {
    const existing = merged.find((v) => v.key === u.key);
    if (!existing) {
      merged.push({ key: u.key, value: u.value });
      added.push(u.key);
    } else if (existing.value !== u.value) {
      existing.value = u.value;
      changed.push(u.key);
    }
  }
  const touched = new Set([...added, ...changed]);
  const unchanged = merged.filter((v) => !touched.has(v.key)).map((v) => v.key);
  return { merged, added, changed, unchanged };
}

// Reads values from a local .env file so secrets never pass through the model.
export function readEnvFile(path: string, keys: string[]): EnvVar[] {
  const values = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) values.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return keys.map((key) => {
    if (!values.has(key)) throw new Error(`${key} is not in ${path}`);
    return { key, value: values.get(key)! };
  });
}

function resolveEnvArgs(args: { variables?: EnvVar[]; envFile?: string; keys?: string[] }): EnvVar[] {
  const fromFile = args.envFile && args.keys?.length ? readEnvFile(args.envFile, args.keys) : [];
  return [...(args.variables ?? []), ...fromFile];
}

async function recordsFor(c: LiaraClient, app: string, domain: string) {
  const d = (await c.domains(app)).find((x: any) => x.name === domain);
  if (!d) throw new Error(`دامنه‌ی ${domain} هنوز به ${app} اضافه نشده؛ اول add_domain را اجرا کنید.`);
  const check = await c.checkDomain(d._id).catch(() => ({}) as any);
  return requiredRecords(domain, { CNameRecord: check?.domain?.CNameRecord ?? d.CNameRecord, verificationCode: check?.domain?.verificationCode });
}

// Health check sent with the release (Liara keeps the old release serving until it passes)
// and the path our own verification probes. HAMYAR_HEALTHCHECK=off disables sending it.
function healthFor(dir: string, port: number): { healthPath: string; healthCheck?: ReturnType<typeof healthCheckFor> } {
  const path = findHealthPath(dir);
  if (!path) return { healthPath: '/' };
  return { healthPath: path, ...(process.env.HAMYAR_HEALTHCHECK === 'off' ? {} : { healthCheck: healthCheckFor(port, path) }) };
}

// Validates a rollback target against the real release history before anything runs.
async function rollbackTarget(c: LiaraClient, app: string, releaseID: string) {
  const { releases = [], currentRelease } = await c.releases(app, 20);
  const target = releases.find((r: any) => r._id === releaseID);
  let problem: string | undefined;
  if (!target) problem = `نسخه‌ی ${releaseID} در ۲۰ نسخه‌ی اخیر ${app} پیدا نشد.`;
  else if (releaseID === currentRelease) problem = `نسخه‌ی ${releaseID} همین الان نسخه‌ی فعلی است؛ برگشت معنی ندارد.`;
  else if (target.state !== 'READY') problem = `نسخه‌ی ${releaseID} سالم ساخته نشده (وضعیت ${target.state})؛ برگشت به آن امن نیست.`;
  return { target, current: currentRelease as string | undefined, problem };
}

async function planInfo(client: LiaraClient, planID: string) {
  return toPlanList({ [planID]: { ...(await client.appPlans())[planID], available: true } })[0];
}

// ---------- catalogue ----------

export const ACTIONS: Record<string, ActionDef> = {
  restart_app: {
    tier: 'T1',
    async preview(_c, { app }) {
      return { title: `ری‌استارت برنامه‌ی ${app}`, lines: ['برنامه متوقف و دوباره اجرا می‌شود؛ حافظه آزاد می‌شود.'], risk: 'کم', downtime: 'چند ثانیه', undo: 'نیازی ندارد' };
    },
    execute: (c, { app }) => c.restart(app),
  },

  turn_on_app: {
    tier: 'T1',
    async preview(_c, { app }) {
      return { title: `روشن کردن برنامه‌ی ${app}`, lines: ['برنامه دوباره در دسترس قرار می‌گیرد و هزینه‌ی ساعتی پلن محاسبه می‌شود.'], risk: 'کم', downtime: 'ندارد', undo: 'خاموش کردن' };
    },
    execute: (c, { app }) => c.scale(app, 1),
  },

  turn_off_app: {
    tier: 'T2',
    async preview(_c, { app }) {
      return { title: `خاموش کردن برنامه‌ی ${app}`, lines: ['سایت از دسترس خارج می‌شود تا وقتی دوباره روشن شود.'], risk: 'بالا: سایت قطع می‌شود', downtime: 'تا روشن کردن دوباره', undo: 'روشن کردن برنامه' };
    },
    execute: (c, { app }) => c.scale(app, 0),
  },

  set_env: {
    tier: 'T2',
    async preview(c, args) {
      const current = (await c.getApp(args.app)).envs ?? [];
      const d = envDiff(current, resolveEnvArgs(args));
      return {
        title: `تغییر متغیرهای محیطی ${args.app}`,
        lines: [
          ...d.added.map((k) => `➕ اضافه می‌شود: ${k} (مقدار مخفی است)`),
          ...d.changed.map((k) => `✏️ تغییر می‌کند: ${k} (مقدار مخفی است)`),
          `بدون تغییر می‌مانند: ${fa(d.unchanged.length)} متغیر`,
          ...(d.added.length + d.changed.length === 0 ? ['⚠️ هیچ تغییری لازم نیست.'] : []),
        ],
        risk: 'کم؛ لیارا کل مجموعه را جایگزین می‌کند، همیار مقادیر فعلی را حفظ می‌کند',
        downtime: 'یک ری‌استارت کوتاه',
        undo: 'برگرداندن مقدار قبلی با همین ابزار',
      };
    },
    async execute(c, args) {
      const current = (await c.getApp(args.app)).envs ?? [];
      const d = envDiff(current, resolveEnvArgs(args));
      await c.updateEnvs(args.app, d.merged);
      return { added: d.added, changed: d.changed };
    },
  },

  resize_plan: {
    tier: 'T2',
    async preview(c, { app, planID }) {
      const current = (await c.getApp(app)).planID;
      const [from, to] = await Promise.all([planInfo(c, current), planInfo(c, planID)]);
      const delta = (to?.monthly ?? 0) - (from?.monthly ?? 0);
      return {
        title: `تغییر پلن ${app}: ${current} ← ${planID}`,
        lines: [
          `فعلی: ${current} — ${fa(from?.ramGB ?? 0)} گیگ رم، ${fa(from?.cpu ?? 0)} CPU، ماهانه ${fa(from?.monthly ?? 0)} تومان`,
          `جدید: ${planID} — ${fa(to?.ramGB ?? 0)} گیگ رم، ${fa(to?.cpu ?? 0)} CPU، ماهانه ${fa(to?.monthly ?? 0)} تومان`,
        ],
        cost: `${delta >= 0 ? '+' : ''}${fa(delta)} تومان در ماه`,
        risk: 'هزینه تغییر می‌کند',
        downtime: 'یک ری‌استارت کوتاه',
        undo: `برگشت به ${current}`,
      };
    },
    execute: (c, { app, planID }) => c.resize(app, planID),
  },

  rollback: {
    tier: 'T2',
    async preview(c, { app, releaseID }) {
      const { target, current, problem } = await rollbackTarget(c, app, releaseID);
      return {
        title: `برگشت ${app} به نسخه‌ی ${releaseID}`,
        lines: [
          `نسخه‌ی فعلی: ${current ?? 'نامشخص'}`,
          target ? `نسخه‌ی مقصد: ${releaseID} — ساخته‌شده ${new Date(target.createdAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}، وضعیت ${target.state}` : `نسخه‌ی مقصد: ${releaseID}`,
          ...(problem ? [`⛔ ${problem}`] : []),
          'روش: اول برگشت مستقیم لیارا؛ اگر لیارا پشتیبانی نکرد، همین نسخه از روی کد ذخیره‌شده‌اش دوباره منتشر می‌شود.',
          'بعد از برگشت، سلامت سایت با چند دور تست بررسی می‌شود.',
        ],
        risk: 'تغییرات نسخه‌ی فعلی تا دیپلوی بعدی از دسترس خارج می‌شود',
        downtime: 'بدون قطعی (نسخه‌ی فعلی تا آماده شدن نسخه‌ی مقصد کار می‌کند)',
        undo: current ? `برگشت دوباره به ${current}` : 'دیپلوی دوباره‌ی کد فعلی',
      };
    },
    async execute(c, { app, releaseID }, onEvent, deps) {
      const { target, current, problem } = await rollbackTarget(c, app, releaseID);
      if (problem || !target) throw Object.assign(new Error(problem), { explanation: problem });
      let method: 'native' | 'redeploy' = 'native';
      let servedRelease = releaseID;
      onEvent({ phase: 'DEPLOYING', message: 'برگشت مستقیم لیارا' });
      try {
        await c.rollback(app, releaseID);
      } catch (err) {
        // Native rollback is not in the official spec: only fall back when the endpoint is missing.
        if (!(err instanceof LiaraError) || ![404, 405].includes(err.status)) throw err;
        const sourceID = target.sourceID ?? target.source?._id ?? target.source;
        if (typeof sourceID !== 'string' || target.sourceAvailable === false) {
          const msg = `لیارا برگشت مستقیم را پشتیبانی نکرد و کد ذخیره‌شده‌ی نسخه‌ی ${releaseID} در دسترس نیست. راه جایگزین: کد سالم قبلی را از پوشه‌ی پروژه دوباره deploy کنید (مثلاً Coding Agent تغییر خراب را برگرداند).`;
          throw Object.assign(new Error(msg), { explanation: msg });
        }
        method = 'redeploy';
        onEvent({ phase: 'BUILDING', message: 'انتشار دوباره‌ی کد نسخه‌ی مقصد' });
        servedRelease = await c.createRelease(app, { sourceID, port: target.port, type: target.projectType ?? target.platform ?? target.type, message: `Rollback to ${releaseID} by Hamyar` });
        const release = await waitForRelease(c, servedRelease, onEvent);
        if (release.state !== 'READY') return { method, previous: current, releaseID: servedRelease, state: release.state === 'UNHEALTHY' ? 'HEALTH_FAILED' : 'FAILED', release };
      }
      onEvent({ phase: 'VERIFYING' });
      const { healthy, verification } = await verifyDeployment(c, app, servedRelease, '/', deps);
      const state = healthy ? 'VERIFIED_HEALTHY' : 'HEALTH_FAILED';
      onEvent({ phase: state, message: verification.reason });
      return { method, previous: current, target: releaseID, releaseID: servedRelease, state, verification };
    },
  },

  deploy: {
    tier: 'T2',
    async preview(c, { app, dir, port }) {
      const d = detectProject(dir);
      const files = listFiles(dir, d.platform).length;
      const health = healthFor(dir, port ?? d.port);
      const { currentRelease } = await c.releases(app, 1).catch(() => ({ currentRelease: undefined }));
      return {
        title: `انتشار نسخه‌ی جدید ${app}`,
        lines: [
          `پوشه: ${dir}`,
          `پلتفرم: ${d.platform}، پورت: ${port ?? d.port}، ${fa(files)} فایل`,
          health.healthCheck ? `بررسی سلامت لیارا روی ${health.healthPath}: تا سالم نشود، نسخه‌ی فعلی سرویس می‌دهد` : `بررسی سلامت: بعد از انتشار، همیار ${health.healthPath} را تست می‌کند`,
          ...d.warnings.map((w) => `⚠️ ${w}`),
          currentRelease ? `نسخه‌ی فعلی برای برگشت: ${currentRelease}` : 'این اولین نسخه است.',
        ],
        risk: 'اگر نسخه‌ی جدید سالم نباشد، موفق اعلام نمی‌شود و همیار راه برگشت را پیشنهاد می‌دهد',
        downtime: 'بدون قطعی (نسخه‌ی قبلی تا آماده و سالم شدن نسخه‌ی جدید کار می‌کند)',
        undo: currentRelease ? `برگشت به ${currentRelease}` : 'خاموش کردن برنامه',
      };
    },
    async execute(c, { app, dir, port, message }, onEvent) {
      const d = detectProject(dir);
      const p = port ?? d.port;
      return deploySource(c, { app, dir, platform: d.platform, port: p, message, ...healthFor(dir, p) }, onEvent);
    },
  },

  launch_app: {
    tier: 'T2',
    async preview(c, args) {
      const { app, dir, planID } = args;
      const d = detectProject(dir);
      const plan = await planInfo(c, planID);
      const balance = await c.balance();
      const provided = resolveEnvArgs(args).map((v) => v.key);
      const missing = scanEnv(dir).missing.filter((m) => !m.optional && !provided.includes(m.name)).map((m) => m.name);
      return {
        title: `ساخت برنامه‌ی ${app} و اولین دیپلوی`,
        lines: [
          `پلتفرم: ${d.platform}، پورت: ${d.port}`,
          `پلن: ${planID} — ${fa(plan?.ramGB ?? 0)} گیگ رم، ${fa(plan?.cpu ?? 0)} CPU`,
          `آدرس: ${appUrl(app)}`,
          `موجودی حساب: ${fa(Math.round(balance))} تومان`,
          ...(provided.length ? [`متغیرهایی که قبل از دیپلوی تنظیم می‌شوند: ${provided.join('، ')} (مقدارها مخفی است)`] : []),
          ...(missing.length ? [`⚠️ کد این متغیرها را لازم دارد ولی مقداری برایشان داده نشده: ${missing.join('، ')} — احتمالاً سایت بعد از دیپلوی خطا می‌دهد`] : []),
          ...d.warnings.map((w) => `⚠️ ${w}`),
        ],
        cost: `ماهانه حدود ${fa(plan?.monthly ?? 0)} تومان (ساعتی ${fa(Math.round(plan?.hourly ?? 0))} تومان)`,
        risk: 'از موجودی حساب کسر می‌شود',
        downtime: '—',
        undo: 'خاموش کردن برنامه با همیار، یا حذف از کنسول لیارا',
      };
    },
    async execute(c, args, onEvent) {
      const { app, dir, planID, message } = args;
      const d = detectProject(dir);
      const variables = resolveEnvArgs(args);
      onEvent({ phase: 'PREPARING', message: 'ساخت برنامه' });
      await c.createApp({ name: app, planID, platform: d.platform });
      // From here on the app exists and is billed: never fail silently.
      try {
        if (variables.length) await c.updateEnvs(app, variables);
        const result = await deploySource(c, { app, dir, platform: d.platform, port: d.port, message: message ?? 'First deploy by Hamyar', ...healthFor(dir, d.port) }, onEvent);
        return { ...result, appCreated: true };
      } catch (err: any) {
        const why = err?.explanation ?? err?.message ?? String(err);
        throw Object.assign(new Error(why), {
          explanation: `برنامه‌ی ${app} ساخته شد ولی دیپلوی کامل نشد: ${why}. برنامه روی لیارا وجود دارد و هزینه‌ی ساعتی پلن محاسبه می‌شود؛ می‌توانید دوباره deploy کنید یا آن را با turn_off_app (با تأیید) خاموش کنید.`,
        });
      }
    },
  },

  add_domain: {
    tier: 'T2',
    async preview(_c, { app, domain }) {
      return { title: `اتصال دامنه‌ی ${domain} به ${app}`, lines: ['بعد از ثبت، همیار رکوردی را که باید در پنل دامنه وارد کنید نشان می‌دهد.'], risk: 'کم', downtime: 'ندارد', undo: 'حذف دامنه از کنسول لیارا' };
    },
    execute: (c, { app, domain }) => c.addDomain(app, domain),
  },

  use_liara_dns: {
    tier: 'T2',
    async preview(_c, { domain }) {
      const { zone } = splitDomain(domain);
      return {
        title: `مدیریت DNS دامنه‌ی ${zone} در لیارا`,
        lines: [
          `ناحیه‌ی ${zone} در سرویس DNS لیارا ساخته می‌شود.`,
          'بعد از آن باید دو نیم‌سرور (NS) لیارا را در پنل دامنه وارد کنید؛ همیار دقیقاً می‌گوید چه وارد کنید.',
          registrarHint(domain),
          '⚠️ اگر روی این دامنه رکوردهای دیگری (مثل ایمیل) دارید، بعد از تغییر NS باید در لیارا هم ساخته شوند.',
        ],
        risk: 'متوسط؛ تا وقتی NS را عوض نکنید هیچ چیزی تغییر نمی‌کند',
        downtime: 'ندارد',
        undo: 'برگرداندن NS قبلی در پنل دامنه',
      };
    },
    async execute(c, { domain }) {
      const { zone } = splitDomain(domain);
      return (await c.dnsZone(zone)) ?? c.createDnsZone(zone);
    },
  },

  create_dns_records: {
    tier: 'T2',
    async preview(c, { app, domain }) {
      const records = await recordsFor(c, app, domain);
      return {
        title: `ساخت خودکار رکوردهای ${domain} در DNS لیارا`,
        lines: records.map((r) => `${r.type}  ${r.name}  →  ${r.value}  (${r.purpose})`),
        risk: 'کم',
        downtime: 'ندارد',
        undo: 'حذف رکورد از منوی DNS کنسول لیارا',
      };
    },
    async execute(c, { app, domain }) {
      const { zone } = splitDomain(domain);
      const existing = await c.dnsRecords(zone);
      const created: string[] = [];
      for (const r of await recordsFor(c, app, domain)) {
        if (existing.some((e: any) => e.name === r.name && e.type === r.type)) continue;
        await c.createDnsRecord(zone, { name: r.name, type: r.type, contents: [r.type === 'TXT' ? { text: r.value } : { host: r.value }] });
        created.push(`${r.type} ${r.name}`);
      }
      return { created };
    },
  },

  enable_ssl: {
    tier: 'T1',
    async preview(_c, { domain }) {
      return { title: `فعال کردن SSL (https) برای ${domain}`, lines: ['گواهی رایگان صادر می‌شود؛ دامنه باید قبلاً به لیارا متصل شده باشد.'], risk: 'کم', downtime: 'ندارد', undo: 'غیرفعال کردن SSL' };
    },
    execute: (c, { domain }) => c.enableSsl(domain),
  },
};

// ---------- the gate ----------

export type ActionResult =
  | { status: 'needs_approval'; tier: Tier; preview: Preview; approvalId: string; expiresAt: number }
  | { status: 'done'; result: unknown }
  | { status: 'failed'; error: string }
  | { status: 'blocked'; error: string };

// First call (no approvalId): returns a preview and files a pending approval request.
// Second call (approvalId): runs only if a human approved that exact request through a
// trusted channel; the id itself is not a credential.
export async function runAction(
  ctx: { client: LiaraClient; policy: Policy },
  tool: string,
  args: Record<string, any>,
  approval?: { approvalId?: string },
  onEvent: (e: DeployEvent) => void = () => {},
  source: 'mcp' | 'dashboard' = 'dashboard',
): Promise<ActionResult> {
  const { client, policy } = ctx;
  const def = ACTIONS[tool];
  const block = (error: string, tier: Tier = def?.tier ?? 'T3'): ActionResult => {
    policy.audit({ tool, tier, args, outcome: 'blocked', detail: error, approvalId: approval?.approvalId });
    return { status: 'blocked', error };
  };
  if (!def) return block(`«${tool}» در همیار وجود ندارد. عملیات حذف عمداً پیاده‌سازی نشده است.`);

  let approvedBy = 'auto';
  try {
    policy.assertAllowed(tool, def.tier);
    if (policy.needsApproval(def.tier) && !approval?.approvalId) {
      const preview = await def.preview(client, args);
      const record = policy.approvals.request({ tool, tier: def.tier, args, preview, source });
      policy.audit({ tool, tier: def.tier, args, outcome: 'previewed', approvalId: record.id });
      return { status: 'needs_approval', tier: def.tier, preview, approvalId: record.id, expiresAt: record.expiresAt };
    }
    if (approval?.approvalId) {
      const record = policy.approvals.consume(approval.approvalId, tool, args);
      approvedBy = `${record.decidedBy ?? 'user'} (${record.channel})`;
    }
    policy.assertRate(tool, args.app);
  } catch (err: any) {
    if (err instanceof PolicyError || err instanceof ApprovalError) return block(err.explanation, def.tier);
    return { status: 'failed', error: err?.explanation ?? err?.message ?? String(err) };
  }

  // Persisted so the dashboard can show it after a refresh and a restart can resume it.
  const op = policy.operations.start({ tool, app: args.app, approvalId: approval?.approvalId });
  const track = (e: DeployEvent) => {
    policy.operations.event(op.id, e);
    onEvent(e);
  };
  try {
    const result: any = await def.execute(client, args, track);
    policy.audit({ tool, tier: def.tier, args, outcome: 'executed', approvedBy, approvalId: approval?.approvalId });
    policy.operations.finish(op.id, result?.state ?? 'DONE');
    return { status: 'done', result };
  } catch (err: any) {
    const error = err?.explanation ?? err?.message ?? String(err);
    policy.audit({ tool, tier: def.tier, args, outcome: 'failed', detail: error });
    policy.operations.finish(op.id, 'FAILED', error);
    return { status: 'failed', error };
  }
}
