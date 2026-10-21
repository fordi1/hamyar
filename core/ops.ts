// Read-only operations shared by the MCP server and the web agent. Each returns
// Persian text ready to show, so both interfaces behave identically.
import { resolve } from 'node:path';
import type { LiaraClient } from './liara-client.js';
import type { Policy } from './policy.js';
import type { Preview } from './actions.js';
import { analyzeProject, renderLaunchPlan } from './analyze.js';
import { diagnose, renderBoard } from './sre/diagnose.js';
import { clusterLogs } from './sre/cluster.js';
import { normalizeLogs } from './sre/collect.js';
import { criteriaFor, verifyFix } from './sre/verify.js';
import { renderPostmortem, type ActionRecord } from './sre/postmortem.js';
import { appUrl, probe, type DeployEvent } from './deployer.js';
import type { Board } from './sre/rca.js';
import { checkPublicDns, registrarHint, requiredRecords, splitDomain } from './domain.js';

export interface OpsContext {
  client: LiaraClient;
  policy: Policy;
  // last diagnose per app: the "before" for verify and the base of the incident report
  boards: Map<string, Board>;
}

const fa = (n: number) => n.toLocaleString('fa-IR');

export async function overview({ client, policy }: OpsContext): Promise<string> {
  const [balance, apps] = await Promise.all([client.balance(), client.listApps()]);
  const lines = [
    `💰 موجودی: ${fa(Math.round(balance))} تومان   🛡️ حالت ایمنی: ${policy.mode}`,
    apps.length ? '📋 برنامه‌ها:' : '📋 هنوز برنامه‌ای ندارید.',
    ...apps.map((a: any) => `  - ${a.project_id}: ${a.type}، پلن ${a.planID}، ${a.status}${a.scale === 0 ? ' (خاموش)' : ''} — ${appUrl(a.project_id)}`),
  ];
  const recent = policy.recent(5);
  if (recent.length) lines.push('🧾 آخرین عملیات:', ...recent.map((r) => `  - ${r.at} ${r.tool} → ${r.outcome}`));
  return lines.join('\n');
}

export async function analyzeText({ client }: OpsContext, dir: string, app?: string): Promise<string> {
  const plan = await analyzeProject(client, resolve(dir), app ?? 'my-app');
  return `${renderLaunchPlan(plan)}\n\nبرای ساخت و دیپلوی: launch_app با planID="${plan.advice.plan.id}"`;
}

export async function appStatus({ client }: OpsContext, app: string): Promise<string> {
  const [info, releases, probed] = await Promise.all([client.getApp(app), client.releases(app, 3).catch(() => undefined), probe(appUrl(app), 3)]);
  return [
    `📦 ${app}: ${info.status}${info.scale === 0 ? ' (خاموش)' : ''}، پلتفرم ${info.type}، پلن ${info.planID}`,
    `🔖 نسخه‌ی فعلی: ${releases?.currentRelease ?? '—'}`,
    `🌐 ${appUrl(app)} → ${fa(Math.round(probed.okRatio * 100))}٪ موفق، p95=${fa(probed.p95)}ms ${probed.healthy ? '✅' : '⚠️'}`,
    `🔑 متغیرها: ${(info.envs ?? []).map((e: any) => e.key).join(', ') || '—'}`,
  ].join('\n');
}

export async function logsText({ client }: OpsContext, app: string, minutes = 30, errorsOnly = false): Promise<string> {
  const logs = normalizeLogs(await client.logs(app, Math.floor(Date.now() / 1000) - minutes * 60));
  const clusters = clusterLogs(logs)
    .filter((c) => !errorsOnly || c.isError)
    .sort((a, b) => Number(b.isError) - Number(a.isError) || b.count - a.count);
  if (!clusters.length) return `در ${fa(minutes)} دقیقه‌ی اخیر لاگی${errorsOnly ? ' با خطا' : ''} نیست.`;
  return [
    `📜 ${fa(logs.length)} خط لاگ در ${fa(minutes)} دقیقه، ${fa(clusters.length)} الگو:`,
    ...clusters.slice(0, 15).map((c) => `${c.isError ? '🔴' : '⚪'} ${fa(c.count)}× ${c.samples[0].split('\n')[0].slice(0, 200)}`),
  ].join('\n');
}

const TOOL_FOR_FIX: Record<string, string> = {
  set_env: 'set_env', restart: 'restart_app', turn_on: 'turn_on_app', resize: 'resize_plan', rollback: 'rollback', redeploy_port: 'deploy',
};

export async function diagnoseText(ctx: OpsContext, app: string, opts: { dir?: string; path?: string; minutes?: number } = {}): Promise<{ text: string; board: Board }> {
  const board = await diagnose(ctx.client, app, { projectDir: opts.dir ? resolve(opts.dir) : undefined, probePath: opts.path, windowMinutes: opts.minutes });
  ctx.boards.set(app, board);
  const out = [renderBoard(board)];

  const next = board.fixes.find((f) => TOOL_FOR_FIX[f.action]);
  if (next) out.push(`\n➡️ ابزار پیشنهادی برای راه‌حل اول قابل‌اجرا: ${TOOL_FOR_FIX[next.action]} ${JSON.stringify({ app, ...(next.args ?? {}) })}`);

  const codeFix = board.fixes.find((f) => f.action === 'code_fix');
  if (codeFix && board.root) {
    out.push(
      '\n🧑‍💻 برای Coding Agent:',
      `- علت: ${board.root.title}`,
      board.codeHint ? `- محل: ${board.codeHint.file}:${board.codeHint.line} — ${board.codeHint.message}` : '- محل دقیق در کد مشخص نیست؛ از شواهد بالا شروع کن.',
      `- کار: ${codeFix.title}. ${codeFix.effect}`,
      '- بعد از اصلاح: deploy با همان app و پوشه‌ی پروژه، سپس verify.',
    );
  }
  return { text: out.join('\n'), board };
}

export async function verifyText(ctx: OpsContext, app: string, path?: string): Promise<{ text: string; passed: boolean }> {
  const board = ctx.boards.get(app);
  const before = board?.snapshot.probe;
  const target = appUrl(app) + (path ?? (before ? new URL(before.url).pathname : '/'));
  const result = await verifyFix(target, criteriaFor(board?.root?.id, before), before, { rounds: 3, intervalMs: 5000 });
  const text = [
    result.passed ? '✅ مشکل برطرف شد' : '❌ هنوز به هدف نرسیده‌ایم',
    '| معیار | قبل | بعد | هدف | |', '|---|---|---|---|---|',
    ...result.rows.map((r) => `| ${r.metric} | ${r.before} | ${r.after} | ${r.target} | ${r.ok ? '✅' : '❌'} |`),
    result.passed ? 'برای گزارش کامل: incident_report' : 'diagnose را دوباره اجرا کن یا راه‌حل بعدی را امتحان کن (یا rollback).',
  ].join('\n');
  return { text, passed: result.passed };
}

const DOMAIN_STEPS = (domain: string, app: string) => [
  `۱. add_domain با app="${app}" و domain="${domain}" (ثبت دامنه در لیارا)`,
  '۲. یکی از دو راه:',
  `   الف) پیشنهادی: use_liara_dns — DNS در لیارا مدیریت می‌شود، شما فقط دو NS را در پنل دامنه وارد می‌کنید و همیار رکوردها را خودش می‌سازد (create_dns_records).`,
  '   ب) DNS فعلی‌تان (Cloudflare، آروان و…): همیار رکوردهای لازم را دقیق می‌گوید و بعد از ثبت، از اینترنت بررسی می‌کند.',
  '۳. enable_ssl برای https',
  registrarHint(domain),
];

// Step-by-step domain status: Liara's view, Liara DNS zone, and what the public internet sees.
export async function checkDomainText({ client }: OpsContext, app: string, domain?: string): Promise<string> {
  const all = await client.domains(app);
  const domains = domain ? all.filter((d: any) => d.name === domain) : all;
  if (!domains.length) {
    return domain
      ? [`دامنه‌ی ${domain} هنوز به ${app} اضافه نشده. مراحل:`, ...DOMAIN_STEPS(domain, app)].join('\n')
      : 'هنوز دامنه‌ای به این برنامه متصل نشده. نام دامنه را بدهید تا مراحل را بگویم (add_domain).';
  }

  const parts = await Promise.all(domains.map(async (d: any) => {
    const check = await client.checkDomain(d._id).catch(() => undefined);
    const records = requiredRecords(d.name, { CNameRecord: check?.domain?.CNameRecord ?? d.CNameRecord, verificationCode: check?.domain?.verificationCode });
    const { zone } = splitDomain(d.name);
    const liaraZone = await client.dnsZone(zone).catch(() => undefined);
    const pub = await checkPublicDns(d.name, records, undefined, liaraZone?.nameServers);
    const lines = [`🌐 ${d.name} — وضعیت در لیارا: ${check?.domain?.status ?? d.status ?? '—'}، SSL: ${d.certificatesStatus ?? '—'}`];

    if (liaraZone) {
      if (pub.usesExpectedNameservers || liaraZone.status === 'ACTIVE') {
        lines.push(`✅ دامنه از DNS لیارا استفاده می‌کند (${liaraZone.status ?? 'ACTIVE'}).`);
        const existing = await client.dnsRecords(zone).catch(() => [] as any[]);
        const missing = records.filter((r) => !existing.some((e: any) => e.name === r.name && e.type === r.type));
        lines.push(missing.length ? `➡️ ${fa(missing.length)} رکورد لازم هنوز ساخته نشده: create_dns_records را اجرا کنید.` : '✅ رکوردهای لازم در DNS لیارا ساخته شده‌اند.');
      } else {
        lines.push(
          '⏳ ناحیه در DNS لیارا ساخته شده ولی نیم‌سرورها هنوز عوض نشده‌اند. در پنل دامنه این دو NS را وارد کنید:',
          ...(liaraZone.nameServers ?? []).map((ns: string) => `   ${ns}`),
          `   ${registrarHint(d.name)}`,
          `   NS فعلی که اینترنت می‌بیند: ${pub.nameservers.join('، ') || 'پیدا نشد'}`,
          '   تغییر NS از چند دقیقه تا ۲۴ ساعت طول می‌کشد؛ بعد از آن دوباره check_domain بزنید.',
        );
      }
    } else {
      lines.push('رکوردهایی که باید در DNS دامنه ثبت شوند (یا با use_liara_dns خودکارش کنید):');
      for (const r of pub.records) {
        lines.push(`   ${r.visible ? '✅' : '⏳'} ${r.type}  نام: ${r.name}  مقدار: ${r.value}  — ${r.purpose}${!r.visible && r.found.length ? ` (الان: ${r.found.join(', ')})` : ''}`);
      }
      if (records.some((r) => r.type === 'ALIAS')) lines.push('   نکته: روی ریشه‌ی دامنه (@) بعضی پنل‌ها CNAME را قبول نمی‌کنند؛ از نوع ALIAS/ANAME یا DNS لیارا استفاده کنید.');
      lines.push(`   NS فعلی: ${pub.nameservers.join('، ') || 'پیدا نشد'}`);
    }

    const ready = pub.records.length > 0 && pub.records.every((r) => r.visible);
    if (d.certificatesStatus !== 'ACTIVE' && (ready || pub.usesExpectedNameservers)) lines.push('➡️ رکوردها دیده می‌شوند؛ حالا enable_ssl را اجرا کنید.');
    return lines.join('\n');
  }));

  return parts.join('\n\n');
}

export async function incidentReportText(ctx: OpsContext, app: string): Promise<string> {
  const board = ctx.boards.get(app);
  if (!board) throw new Error('اول diagnose را برای این برنامه اجرا کنید.');
  const actions: ActionRecord[] = ctx.policy
    .recent(50)
    .filter((e) => e.args?.app === app && Date.parse(e.at) >= board.createdAt && e.outcome !== 'previewed')
    .map((e) => ({
      at: Date.parse(e.at), action: e.tool, tier: e.tier, title: e.tool, approvedBy: e.approvedBy, detail: e.detail,
      result: e.outcome === 'executed' ? 'ok' : e.outcome === 'rejected' ? 'rejected' : 'failed',
    }));
  const before = board.snapshot.probe;
  const verify = before ? await verifyFix(before.url, criteriaFor(board.root?.id, before), before, { rounds: 1 }) : undefined;
  return renderPostmortem({ board, actions, verify });
}

export function auditText({ policy }: OpsContext, limit = 20): string {
  const entries = policy.recent(limit);
  if (!entries.length) return 'هنوز عملیاتی ثبت نشده است.';
  return entries
    .map((e) => `${e.at} [${e.tier}] ${e.tool} ${JSON.stringify(e.args)} → ${e.outcome}${e.approvedBy ? ` (${e.approvedBy})` : ''}${e.detail ? ` — ${e.detail}` : ''}`)
    .join('\n');
}

export function renderPreview(p: Preview, tier: string): string {
  return [
    `🛑 نیاز به تأیید شما (${tier === 'T1' ? 'کم‌خطر' : 'تغییر مهم'})`,
    `**${p.title}**`,
    ...p.lines.map((l) => `• ${l}`),
    p.cost ? `💰 هزینه: ${p.cost}` : '',
    `⚠️ ریسک: ${p.risk}`,
    `⏱️ قطعی: ${p.downtime}`,
    `↩️ راه برگشت: ${p.undo}`,
  ].filter(Boolean).join('\n');
}

export function renderDone(tool: string, result: any, events: DeployEvent[]): string {
  if (tool === 'deploy' || tool === 'launch_app') {
    const phases = [...new Set(events.map((e) => e.phase))].join(' → ');
    const lines = [`مراحل: ${phases}`];
    if (result?.release?.state === 'READY') {
      lines.unshift(`✅ نسخه‌ی ${result.releaseID} منتشر شد: ${result.url}`);
      if (result.probe) {
        lines.push(`تست سایت: ${fa(Math.round(result.probe.okRatio * 100))}٪ موفق، p95=${fa(result.probe.p95)}ms ${result.probe.healthy ? '✅' : '⚠️ سایت سالم به نظر نمی‌رسد؛ diagnose را اجرا کنید'}`);
      }
    } else {
      lines.unshift(`❌ انتشار نسخه‌ی ${result?.releaseID ?? ''} با وضعیت ${result?.release?.state} تمام شد${result?.release?.failReason ? `: ${result.release.failReason}` : ''}`);
      const tail = result?.release?.lastLines?.slice(-8) ?? [];
      if (tail.length) lines.push('آخرین خطوط build:', ...tail.map((l: string) => `  ${l}`));
      lines.push('برای پیدا کردن علت، diagnose را اجرا کنید.');
    }
    return lines.join('\n');
  }
  if (tool === 'set_env') {
    return `✅ متغیرها ذخیره شدند (اضافه: ${result?.added?.join(', ') || '—'}، تغییر: ${result?.changed?.join(', ') || '—'}). لیارا برنامه را ری‌استارت می‌کند؛ بعد از چند ثانیه verify را اجرا کنید.`;
  }
  if (tool === 'add_domain') return '✅ دامنه ثبت شد. حالا check_domain را اجرا کنید تا رکوردی که باید در پنل دامنه وارد شود را ببینید.';
  if (tool === 'use_liara_dns') {
    return [`✅ ناحیه‌ی ${result?.name ?? ''} در DNS لیارا آماده است. این دو نیم‌سرور (NS) را در پنل دامنه وارد کنید:`, ...(result?.nameServers ?? []).map((n: string) => `   ${n}`), 'بعد از فعال شدن NS، check_domain و سپس create_dns_records را اجرا کنید.'].join('\n');
  }
  if (tool === 'create_dns_records') return result?.created?.length ? `✅ ساخته شد: ${result.created.join('، ')}. چند دقیقه بعد check_domain و سپس enable_ssl.` : '✅ همه‌ی رکوردهای لازم از قبل وجود داشتند.';
  return `✅ «${tool}» انجام شد. برای اطمینان، verify را اجرا کنید.`;
}
