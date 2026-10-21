// Deterministic detectors: Snapshot → hypotheses with evidence for AND against.
// No LLM here. Each detector returns null when it has no data either way, so the
// board only shows hypotheses that were actually tested.
import type { Snapshot, Point } from './snapshot.js';
import { clusterLogs, isErrorLine } from './cluster.js';
import type { Plan } from '../plan-advisor.js';

export type HypothesisId =
  | 'app-off' | 'missing-env' | 'memory' | 'cpu' | 'bad-release' | 'slow'
  | 'port' | 'build' | 'disk' | 'database' | 'http-errors' | 'crash-loop';

export type Status = 'validated' | 'invalidated' | 'inconclusive';

export interface Evidence {
  // assigned by the RCA board (E1, E2, …)
  id?: string;
  kind: 'log' | 'metric' | 'event' | 'release' | 'probe' | 'app' | 'code' | 'build';
  summary: string;
  at?: number;
  // 0..1: how strongly this alone supports (or contradicts) the hypothesis
  weight: number;
}

export type FixAction =
  | 'set_env' | 'restart' | 'turn_on' | 'resize' | 'rollback' | 'code_fix'
  | 'redeploy_port' | 'build_location' | 'resize_disk' | 'check_database';

export interface FixOption {
  action: FixAction;
  // T1/T2 are executed by Hamyar after approval; code = coding agent; manual = user in console
  tier: 'T1' | 'T2' | 'code' | 'manual';
  title: string;
  args?: Record<string, unknown>;
  effect: string;
  risk: string;
  downtime: string;
  undo: string;
}

export interface CodeHint {
  file: string;
  line: number;
  message: string;
}

export interface Hypothesis {
  id: HypothesisId;
  title: string;
  // a symptom is explained by some cause; it is never reported as the root cause
  category: 'cause' | 'symptom';
  status: Status;
  confidence: number;
  supporting: Evidence[];
  contradicting: Evidence[];
  startedAt?: number;
  fixes: FixOption[];
  codeHint?: CodeHint;
}

// ---------- scoring ----------

const combine = (es: Evidence[]) => 1 - es.reduce((p, e) => p * (1 - e.weight), 1);

function hypothesis(
  base: Omit<Hypothesis, 'status' | 'confidence' | 'startedAt'> & { startedAt?: number },
): Hypothesis | null {
  const { supporting, contradicting } = base;
  if (!supporting.length && !contradicting.length) return null;
  const sup = combine(supporting);
  const con = combine(contradicting);
  const confidence = Math.round(sup * (1 - 0.7 * con) * 100) / 100;
  let status: Status = 'inconclusive';
  if (confidence >= 0.6) status = 'validated';
  else if (con >= 0.5 && sup < 0.3) status = 'invalidated';
  const times = supporting.map((e) => e.at).filter((t): t is number => typeof t === 'number');
  return { ...base, status, confidence, startedAt: base.startedAt ?? (times.length ? Math.min(...times) : undefined) };
}

// ---------- helpers ----------

const pct = (r: number) => `${Math.round(r * 100).toLocaleString('fa-IR')}٪`;
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024).toLocaleString('fa-IR')}MB`;
const duration = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000).toLocaleString('fa-IR')} ثانیه` : `${Math.round(ms / 60_000).toLocaleString('fa-IR')} دقیقه`;

function toBytes(series: Point[]): Point[] {
  const max = Math.max(...series.map((p) => p.v));
  // Liara reports bytes; fall back for MB/GB-scaled values just in case.
  const factor = max > 1e5 ? 1 : max <= 64 ? 1024 ** 3 : 1024 ** 2;
  return series.map((p) => ({ t: p.t, v: p.v * factor }));
}

function linearFit(points: Point[]): { slopePerMin: number; r2: number } {
  const n = points.length;
  const xs = points.map((p) => (p.t - points[0].t) / 60_000);
  const ys = points.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!sxx || !syy) return { slopePerMin: 0, r2: 0 };
  return { slopePerMin: sxy / sxx, r2: (sxy * sxy) / (sxx * syy) };
}

const ACCESS_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s+(\d{3})\s+(\d+(?:\.\d+)?)\s?ms\b/;

function accessEntries(s: Snapshot) {
  return s.logs
    .map((l) => {
      const m = l.message.match(ACCESS_RE);
      return m ? { at: l.at, method: m[1], path: m[2], status: Number(m[3]), ms: Number(m[4]) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// First frame of the application's own code in a stack trace.
export function stackFrame(text: string): { file: string; line: number } | undefined {
  const py = text.match(/File "(?:\/app\/)?([^"]+)", line (\d+)/);
  if (py && !py[1].includes('site-packages')) return { file: py[1], line: Number(py[2]) };
  for (const m of text.matchAll(/\(?(?:file:\/\/)?(?:\/app\/|\/usr\/src\/app\/)?([\w./-]+\.(?:js|mjs|cjs|ts|py|php|go)):(\d+)(?::\d+)?\)?/g)) {
    if (!m[1].includes('node_modules') && !m[1].startsWith('node:') && !m[1].startsWith('internal/')) {
      return { file: m[1].replace(/^\.\//, ''), line: Number(m[2]) };
    }
  }
  return undefined;
}

function biggerPlan(s: Snapshot): Plan | undefined {
  const plans = s.availablePlans ?? [];
  const current = s.appInfo.planRamGB ?? 0;
  return [...plans].filter((p) => p.ramGB > current).sort((a, b) => a.ramGB - b.ramGB || a.monthly - b.monthly)[0];
}

const fa = (n: number) => n.toLocaleString('fa-IR');

const fixes = {
  restart: (): FixOption => ({
    action: 'restart', tier: 'T1', title: 'ری‌استارت برنامه',
    effect: 'حافظه آزاد می‌شود و برنامه از نو شروع می‌کند؛ راه‌حل موقت است.',
    risk: 'کم', downtime: 'چند ثانیه', undo: 'نیازی به برگشت ندارد.',
  }),
  resize: (plan: Plan | undefined): FixOption => ({
    action: 'resize', tier: 'T2',
    title: plan ? `ارتقای پلن به ${plan.id} (${fa(plan.ramGB)} گیگ رم)` : 'ارتقای پلن',
    args: plan ? { planID: plan.id } : undefined,
    effect: 'منابع بیشتر در اختیار برنامه قرار می‌گیرد.',
    risk: 'هزینه‌ی ماهانه بالا می‌رود' + (plan ? ` (حدود ${fa(plan.monthly)} تومان در ماه)` : ''),
    downtime: 'یک ری‌استارت کوتاه',
    undo: 'برگرداندن به پلن قبلی از همین دستیار',
  }),
  code: (title: string, effect: string): FixOption => ({
    action: 'code_fix', tier: 'code', title, effect,
    risk: 'به تغییر کد و دیپلوی دوباره نیاز دارد', downtime: 'بدون قطعی (دیپلوی بدون توقف)',
    undo: 'برگشت به نسخه‌ی قبلی (rollback)',
  }),
};

// ---------- detectors ----------

function appOff(s: Snapshot): Hypothesis | null {
  const off = s.appInfo.scale === 0 || /off|stop/i.test(s.appInfo.status ?? '');
  if (!off) return null;
  return hypothesis({
    id: 'app-off', title: 'برنامه خاموش است', category: 'cause',
    supporting: [{ kind: 'app', summary: `وضعیت برنامه در لیارا: ${s.appInfo.status ?? 'OFF'} (scale=${s.appInfo.scale})`, weight: 0.95 }],
    contradicting: [],
    fixes: [{
      action: 'turn_on', tier: 'T1', title: 'روشن کردن برنامه',
      effect: 'برنامه دوباره در دسترس قرار می‌گیرد.', risk: 'کم؛ هزینه‌ی ساعتی پلن دوباره محاسبه می‌شود',
      downtime: 'ندارد', undo: 'خاموش کردن از کنسول',
    }],
  });
}

const NOT_ENV_WORDS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HTTP', 'HTTPS', 'JSON', 'API', 'SQL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'ERR', 'URL']);
const ENV_PHRASE = /^[\s:'"`]*(?:env(?:ironment)? var(?:iable)? )?(?:is |was )?(?:not set|not defined|undefined|missing|not configured|must be set|required|is empty)/i;
const ENV_PREFIX = /(?:KeyError|Missing (?:required )?env(?:ironment)?(?: var(?:iable)?)?|ImproperlyConfigured: Set the|environment variable)\s*:?\s*['"]?([A-Z][A-Z0-9_]{2,})/;

function missingEnv(s: Snapshot): Hypothesis | null {
  const supporting: Evidence[] = [];
  const contradicting: Evidence[] = [];
  const codeNames = new Set(s.codeEnv?.used.map((u) => u.name) ?? []);
  const found = new Map<string, { at: number; message: string }>();

  for (const l of s.logs) {
    const prefix = l.message.match(ENV_PREFIX);
    if (prefix) found.set(prefix[1], found.get(prefix[1]) ?? { at: l.at, message: l.message });
    for (const m of l.message.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      const name = m[1];
      if (NOT_ENV_WORDS.has(name) || (!name.includes('_') && !codeNames.has(name))) continue;
      const rest = l.message.slice((m.index ?? 0) + name.length, (m.index ?? 0) + name.length + 50);
      if (ENV_PHRASE.test(rest) && !found.has(name)) found.set(name, { at: l.at, message: l.message });
    }
  }

  let name: string | undefined;
  for (const [n, hit] of found) {
    name ??= n;
    const count = s.logs.filter((l) => l.message.includes(n)).length;
    if (s.appInfo.envNames.includes(n)) {
      contradicting.push({ kind: 'app', summary: `متغیر ${n} روی لیارا تعریف شده است (شاید مقدارش اشتباه باشد).`, weight: 0.6 });
    } else {
      supporting.push({ kind: 'log', at: hit.at, summary: `لاگ برنامه ${fa(count)} بار گفته «${n}» تنظیم نشده و این متغیر در تنظیمات لیارا وجود ندارد: ${hit.message.split('\n')[0].slice(0, 140)}`, weight: 0.9 });
    }
  }

  for (const m of s.codeEnv?.missing ?? []) {
    if (m.optional) continue;
    name ??= m.name;
    supporting.push({ kind: 'code', summary: `کد در ${m.locations[0]} متغیر ${m.name} را می‌خواند ولی روی لیارا تنظیم نشده است.`, weight: 0.5 });
  }

  if (!name) return null;
  const hit = found.get(name);
  const frame = hit ? stackFrame(hit.message) : undefined;
  const loc = s.codeEnv?.used.find((u) => u.name === name)?.locations[0];
  const [file, line] = loc ? loc.split(':') : [frame?.file, frame?.line];

  return hypothesis({
    id: 'missing-env', title: `متغیر محیطی ${name} تنظیم نشده`, category: 'cause',
    supporting, contradicting,
    codeHint: file ? { file: String(file), line: Number(line), message: `${name} is read here` } : undefined,
    fixes: [{
      action: 'set_env', tier: 'T2', title: `تنظیم متغیر ${name} روی لیارا`, args: { key: name },
      effect: 'برنامه با مقدار درست دوباره راه‌اندازی می‌شود.', risk: 'کم؛ مقدار را خودتان وارد می‌کنید و به هوش مصنوعی داده نمی‌شود',
      downtime: 'یک ری‌استارت کوتاه', undo: 'حذف یا تغییر متغیر از همین دستیار',
    }],
  });
}

function memory(s: Snapshot): Hypothesis | null {
  const supporting: Evidence[] = [];
  const contradicting: Evidence[] = [];
  const planBytes = s.appInfo.planRamGB ? s.appInfo.planRamGB * 1024 ** 3 : undefined;

  for (const e of [...s.events.map((e) => ({ at: e.at, text: e.text })), ...s.applets.map((a) => ({ at: a.at, text: `${a.state} ${a.reason ?? ''}` }))]) {
    if (/OOMKilled|out of memory|\boom\b/i.test(e.text)) {
      supporting.push({ kind: 'event', at: e.at, summary: `رویداد لیارا: کانتینر به‌خاطر کمبود حافظه کشته شد (OOM) — «${e.text.slice(0, 100)}»`, weight: 0.9 });
      break;
    }
  }
  const oomLog = s.logs.find((l) => /heap out of memory|JavaScript heap|MemoryError|Cannot allocate memory|ENOMEM/i.test(l.message));
  if (oomLog) supporting.push({ kind: 'log', at: oomLog.at, summary: `لاگ خطای کمبود حافظه: ${oomLog.message.slice(0, 120)}`, weight: 0.8 });

  let leak = false;
  if (s.memoryBytes.length >= 5) {
    const series = toBytes(s.memoryBytes);
    const max = Math.max(...series.map((p) => p.v));
    if (planBytes) {
      const ratio = max / planBytes;
      const at = series.find((p) => p.v === max)?.t;
      if (ratio >= 0.9) supporting.push({ kind: 'metric', at, summary: `مصرف رم به ${mb(max)} رسید، یعنی ${pct(ratio)} سقف پلن (${s.appInfo.planRamGB} گیگ).`, weight: 0.6 });
      else if (ratio >= 0.75) supporting.push({ kind: 'metric', at, summary: `مصرف رم تا ${pct(ratio)} سقف پلن بالا رفته است.`, weight: 0.3 });
      else if (ratio < 0.5) contradicting.push({ kind: 'metric', summary: `بیشترین مصرف رم ${mb(max)} است، یعنی فقط ${pct(ratio)} سقف پلن.`, weight: 0.7 });
    }
    const { slopePerMin, r2 } = linearFit(series);
    const minutes = (series[series.length - 1].t - series[0].t) / 60_000;
    const growth = slopePerMin * minutes;
    const significant = planBytes ? growth >= 0.2 * planBytes : growth >= 0.5 * series[0].v;
    if (slopePerMin > 0 && r2 >= 0.8 && significant) {
      leak = true;
      supporting.push({
        kind: 'metric', at: series[0].t,
        summary: `رم به‌طور پیوسته بالا می‌رود (${mb(growth)} افزایش در ${duration(minutes * 60_000)}، R²=${r2.toFixed(2)}) — الگوی نشت حافظه.`,
        weight: 0.6,
      });
    }
  }

  const bigger = biggerPlan(s);
  return hypothesis({
    id: 'memory', title: leak ? 'نشت حافظه (Memory leak) و پر شدن رم' : 'کمبود حافظه (OOM)', category: 'cause',
    supporting, contradicting,
    fixes: [
      fixes.restart(),
      fixes.resize(bigger),
      fixes.code(leak ? 'پیدا کردن و رفع نشت حافظه در کد' : 'کاهش مصرف حافظه در کد', 'مشکل از ریشه حل می‌شود و نیازی به پلن گران‌تر نیست.'),
    ],
  });
}

function cpu(s: Snapshot): Hypothesis | null {
  if (!s.cpuCores.length || !s.appInfo.planCpu) return null;
  const planCpu = s.appInfo.planCpu;
  const recent = s.cpuCores.filter((p) => p.t >= s.collectedAt - 5 * 60_000);
  const points = recent.length ? recent : s.cpuCores.slice(-5);
  const toCores = (v: number) => (v > planCpu * 2 && v > 2 ? v / 100 : v);
  const avg = points.reduce((a, p) => a + toCores(p.v), 0) / points.length;
  const ratio = avg / planCpu;
  const supporting: Evidence[] = [];
  const contradicting: Evidence[] = [];
  if (ratio >= 0.9) supporting.push({ kind: 'metric', at: points[0].t, summary: `میانگین مصرف CPU در ۵ دقیقه‌ی اخیر ${pct(ratio)} سقف پلن است.`, weight: 0.6 });
  else if (ratio < 0.5) contradicting.push({ kind: 'metric', summary: `مصرف CPU فقط ${pct(ratio)} سقف پلن است.`, weight: 0.7 });
  if (supporting.length && s.probe && s.probe.p95 > 1500) supporting.push({ kind: 'probe', summary: `پاسخ سایت کند است (p95=${fa(s.probe.p95)}ms).`, weight: 0.2 });
  return hypothesis({
    id: 'cpu', title: 'پر شدن ظرفیت CPU', category: 'cause', supporting, contradicting,
    fixes: [fixes.resize(biggerPlan(s)), fixes.code('بهینه‌سازی بخش پرمصرف کد', 'مصرف CPU پایین می‌آید.')],
  });
}

function badRelease(s: Snapshot): Hypothesis | null {
  const current = s.releases.find((r) => r.id === s.currentReleaseId) ?? s.releases[0];
  if (!current || current.createdAt < s.windowStart || current.state !== 'READY') return null;
  const previous = s.releases.find((r) => r.createdAt < current.createdAt && r.state === 'READY');
  const isFailure = (l: Snapshot['logs'][number]) => isErrorLine(l.message, l.type) || / [5]\d\d \d/.test(l.message);
  const before = s.logs.filter((l) => l.at < current.createdAt);
  const after = s.logs.filter((l) => l.at >= current.createdAt);
  const errBefore = before.filter(isFailure).length;
  const errAfter = after.filter(isFailure);
  const supporting: Evidence[] = [];
  const contradicting: Evidence[] = [];
  const minutesAgo = Math.round((s.collectedAt - current.createdAt) / 60_000);

  if (errAfter.length >= 3 && errBefore === 0 && before.length > 0) {
    supporting.push({ kind: 'release', at: current.createdAt, summary: `نسخه‌ی جدید (${current.id}) ${fa(minutesAgo)} دقیقه پیش منتشر شد؛ قبل از آن ${fa(before.length)} خط لاگ بدون خطا بود و بعد از آن ${fa(errAfter.length)} خطا ثبت شد.`, weight: 0.7 });
    const first = errAfter[0];
    if (first.at - current.createdAt <= 10 * 60_000) {
      supporting.push({ kind: 'log', at: first.at, summary: `اولین خطا ${fa(Math.max(0, Math.round((first.at - current.createdAt) / 60_000)))} دقیقه بعد از انتشار نسخه آمد: ${first.message.split('\n')[0].slice(0, 120)}`, weight: 0.4 });
    }
  } else if (errBefore > 0 && errAfter.length > 0) {
    contradicting.push({ kind: 'log', summary: `خطاها (${fa(errBefore)} مورد) قبل از انتشار نسخه‌ی ${current.id} هم وجود داشتند.`, weight: 0.6 });
  } else if (errAfter.length === 0) {
    contradicting.push({ kind: 'release', summary: `بعد از انتشار نسخه‌ی ${current.id} خطایی ثبت نشده است.`, weight: 0.6 });
  }

  return hypothesis({
    id: 'bad-release', title: `نسخه‌ی جدید (${current.id}) خراب است`, category: 'cause', supporting, contradicting,
    fixes: [
      ...(previous ? [{
        action: 'rollback' as const, tier: 'T2' as const, title: `برگشت به نسخه‌ی سالم قبلی (${previous.id})`, args: { releaseID: previous.id },
        effect: 'سایت فوراً با نسخه‌ی قبلی که سالم بود کار می‌کند.', risk: 'تغییرات نسخه‌ی جدید موقتاً از دسترس خارج می‌شود',
        downtime: 'بدون قطعی (با zero-downtime)', undo: 'دیپلوی دوباره‌ی نسخه‌ی جدید',
      }] : []),
      fixes.code('رفع باگ نسخه‌ی جدید و دیپلوی دوباره', 'نسخه‌ی جدید درست کار می‌کند.'),
    ],
  });
}

function slow(s: Snapshot): Hypothesis | null {
  const supporting: Evidence[] = [];
  const contradicting: Evidence[] = [];
  if (s.probe) {
    if (s.probe.p95 >= 3000) supporting.push({ kind: 'probe', summary: `تست مستقیم ${s.probe.url}: زمان پاسخ p95=${fa(s.probe.p95)}ms (خیلی کند).`, weight: 0.7 });
    else if (s.probe.p95 >= 1500) supporting.push({ kind: 'probe', summary: `تست مستقیم ${s.probe.url}: زمان پاسخ p95=${fa(s.probe.p95)}ms (کند).`, weight: 0.5 });
    else if (s.probe.p95 < 500 && s.probe.okRatio > 0) contradicting.push({ kind: 'probe', summary: `سایت سریع پاسخ می‌دهد (p95=${fa(s.probe.p95)}ms).`, weight: 0.7 });
  }

  const slowByPath = new Map<string, number[]>();
  for (const e of accessEntries(s)) if (e.ms >= 1000) slowByPath.set(e.path, [...(slowByPath.get(e.path) ?? []), e.ms]);
  const worst = [...slowByPath.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (worst) {
    const avg = Math.round(worst[1].reduce((a, b) => a + b, 0) / worst[1].length);
    supporting.push({ kind: 'log', summary: `مسیر ${worst[0]} در لاگ‌ها ${fa(worst[1].length)} بار بیش از ۱ ثانیه طول کشیده (میانگین ${fa(avg)}ms).`, weight: 0.5 });
  }

  const query = clusterLogs(s.logs).find((c) => c.count >= 10 && /\b(SELECT|UPDATE|INSERT|DELETE)\b/i.test(c.template) && c.template.includes('<n>'));
  let nPlusOne = false;
  if (query) {
    nPlusOne = true;
    supporting.push({
      kind: 'log', at: query.firstAt,
      summary: `یک کوئری ${fa(query.count)} بار با شناسه‌های مختلف تکرار شده: «${query.template}» — الگوی N+1 (برای هر ردیف یک کوئری جدا به‌جای یک کوئری با JOIN/IN).`,
      weight: 0.6,
    });
  }

  return hypothesis({
    id: 'slow', title: nPlusOne ? `کندی سایت به‌خاطر کوئری‌های تکراری (N+1)${worst ? ` در ${worst[0]}` : ''}` : 'کندی پاسخ سایت', category: 'cause',
    supporting, contradicting,
    fixes: [
      fixes.code(
        nPlusOne ? 'ادغام کوئری‌های تکراری در یک کوئری (JOIN یا WHERE id IN)' : 'پیدا کردن بخش کند کد',
        nPlusOne ? `به‌جای ${fa(query!.count)} کوئری فقط یک کوئری اجرا می‌شود و زمان پاسخ چند برابر کم می‌شود.` : 'زمان پاسخ کم می‌شود.',
      ),
    ],
  });
}

function port(s: Snapshot): Hypothesis | null {
  const releasePort = s.releases.find((r) => r.id === s.currentReleaseId)?.port ?? s.releases[0]?.port;
  if (!releasePort) return null;
  const line = [...s.logs].reverse().find((l) => /listening (?:on )?(?:port )?:?\d{2,5}|started (?:server )?on (?:port )?:?\d{2,5}/i.test(l.message));
  const listened = line?.message.match(/(?:port|:)\s*(\d{2,5})|on (\d{2,5})/i);
  const appPort = listened ? Number(listened[1] ?? listened[2]) : undefined;
  if (!appPort) return null;
  const supporting: Evidence[] = [];
  const contradicting: Evidence[] = [];
  if (appPort !== releasePort) {
    supporting.push({ kind: 'log', at: line!.at, summary: `برنامه روی پورت ${appPort} اجرا شده («${line!.message.slice(0, 80)}») ولی لیارا درخواست‌ها را به پورت ${releasePort} می‌فرستد.`, weight: 0.9 });
    if (s.probe && s.probe.okRatio < 0.5) supporting.push({ kind: 'probe', summary: 'سایت از بیرون در دسترس نیست (درخواست‌ها شکست خوردند).', weight: 0.3 });
  } else {
    contradicting.push({ kind: 'log', summary: `برنامه روی همان پورت ${appPort} که لیارا انتظار دارد اجرا شده است.`, weight: 0.8 });
  }
  return hypothesis({
    id: 'port', title: appPort !== releasePort ? `پورت اشتباه: برنامه روی ${appPort} و لیارا روی ${releasePort}` : 'پورت اشتباه', category: 'cause', supporting, contradicting,
    fixes: [{
      action: 'redeploy_port', tier: 'T2', title: `دیپلوی دوباره با پورت ${appPort}`, args: { port: appPort },
      effect: 'لیارا درخواست‌ها را به پورت درست می‌فرستد.', risk: 'کم', downtime: 'بدون قطعی', undo: 'دیپلوی دوباره با پورت قبلی',
    }],
  });
}

const REGISTRY_RE = /(registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org|docker\.io|ghcr\.io|proxy\.golang\.org|packagist\.org|repo\.packagist|github\.com)/i;
const BLOCKED_RE = /\b(403|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|timed? ?out|Forbidden|Temporary failure in name resolution)\b/i;

function build(s: Snapshot): Hypothesis | null {
  const latest = s.releases[0];
  if (!latest || latest.createdAt < s.windowStart || !['FAILED', 'UNHEALTHY', 'TIMEDOUT'].includes(latest.state)) return null;
  const supporting: Evidence[] = [{ kind: 'release', at: latest.createdAt, summary: `آخرین دیپلوی (${latest.id}) با وضعیت ${latest.state} تمام شد${latest.failReason ? `: ${latest.failReason}` : ''}.`, weight: 0.7 }];
  const blocked = (s.buildLines ?? []).find((l) => REGISTRY_RE.test(l) && BLOCKED_RE.test(l));
  if (blocked) {
    supporting.push({ kind: 'build', at: latest.createdAt, summary: `در لاگ build، دسترسی به مخزن بسته‌ها رد شد: «${blocked.slice(0, 140)}»`, weight: 0.9 });
    return hypothesis({
      id: 'build', title: 'دسترسی به مخزن بسته‌ها (npm/pip/Docker) از ایران مسدود است', category: 'cause', supporting, contradicting: [],
      fixes: [{
        action: 'build_location', tier: 'T2', title: 'ساخت (build) در سرور آلمان لیارا', args: { location: 'germany' },
        effect: 'بسته‌ها از خارج از ایران دانلود می‌شوند و build موفق می‌شود.', risk: 'کم؛ ممکن است به پلن ویژگی (bundle) نیاز باشد',
        downtime: 'ندارد؛ نسخه‌ی قبلی تا پایان build کار می‌کند', undo: 'حذف build.location از liara.json',
      }],
    });
  }
  const lastErr = [...(s.buildLines ?? [])].reverse().find((l) => isErrorLine(l));
  if (lastErr) supporting.push({ kind: 'build', summary: `آخرین خطای build: ${lastErr.slice(0, 140)}`, weight: 0.4 });
  return hypothesis({
    id: 'build', title: latest.state === 'UNHEALTHY' ? 'نسخه‌ی جدید از health check رد شد' : 'ساخت (build) نسخه‌ی جدید شکست خورد', category: 'cause',
    supporting, contradicting: [],
    fixes: [fixes.code('رفع خطای build و دیپلوی دوباره', 'نسخه‌ی جدید با موفقیت منتشر می‌شود.')],
  });
}

function disk(s: Snapshot): Hypothesis | null {
  const supporting: Evidence[] = [];
  const full = s.disks.find((d) => d.usedRatio >= 0.9);
  if (full) supporting.push({ kind: 'metric', summary: `دیسک ${full.name} ${pct(full.usedRatio)} پر شده است.`, weight: 0.8 });
  const enospc = s.logs.find((l) => /ENOSPC|No space left on device/i.test(l.message));
  if (enospc) supporting.push({ kind: 'log', at: enospc.at, summary: `خطای پر بودن دیسک در لاگ: ${enospc.message.slice(0, 100)}`, weight: 0.9 });
  if (!supporting.length) return null;
  return hypothesis({
    id: 'disk', title: 'دیسک پر شده است', category: 'cause', supporting, contradicting: [],
    fixes: [{
      action: 'resize_disk', tier: 'manual', title: 'افزایش حجم دیسک یا پاک کردن فایل‌های اضافی',
      effect: 'برنامه دوباره می‌تواند فایل بنویسد.', risk: 'هزینه‌ی دیسک بیشتر می‌شود', downtime: 'ندارد', undo: '—',
    }],
  });
}

const DB_RE = /(ECONNREFUSED|ETIMEDOUT|connection refused|could not connect|Connection terminated|too many connections|SequelizeConnectionError|OperationalError|MongoNetworkError|getaddrinfo ENOTFOUND)/i;
const DB_HINT = /(:5432|:3306|:27017|:6379|postgres|mysql|mariadb|mongo|redis|database)/i;

function database(s: Snapshot): Hypothesis | null {
  const hits = s.logs.filter((l) => DB_RE.test(l.message) && DB_HINT.test(l.message));
  if (!hits.length) return null;
  return hypothesis({
    id: 'database', title: 'اتصال به دیتابیس برقرار نمی‌شود', category: 'cause',
    supporting: [{ kind: 'log', at: hits[0].at, summary: `${fa(hits.length)} خطای اتصال به دیتابیس در لاگ: ${hits[0].message.split('\n')[0].slice(0, 120)}`, weight: 0.7 }],
    contradicting: [],
    fixes: [{
      action: 'check_database', tier: 'manual', title: 'بررسی روشن بودن دیتابیس و درستی آدرس اتصال (DATABASE_URL)',
      effect: 'برنامه دوباره به دیتابیس وصل می‌شود.', risk: 'کم', downtime: 'ندارد', undo: '—',
    }],
  });
}

function httpErrors(s: Snapshot): Hypothesis | null {
  const supporting: Evidence[] = [];
  const contradicting: Evidence[] = [];
  const access = accessEntries(s);
  const errors5xx = access.filter((e) => e.status >= 500);
  if (errors5xx.length >= 3) supporting.push({ kind: 'log', at: errors5xx[0].at, summary: `${fa(errors5xx.length)} درخواست از ${fa(access.length)} درخواست با خطای 5xx جواب گرفتند.`, weight: 0.5 });
  if (s.probe && s.probe.okRatio < 0.8) supporting.push({ kind: 'probe', summary: `تست مستقیم سایت: فقط ${pct(s.probe.okRatio)} درخواست‌ها موفق بودند.`, weight: 0.5 });

  const errorCluster = clusterLogs(s.logs.filter((l) => isErrorLine(l.message, l.type))).find((c) => stackFrame(c.samples[0]));
  let codeHint: CodeHint | undefined;
  if (errorCluster) {
    const frame = stackFrame(errorCluster.samples[0])!;
    const firstLine = errorCluster.samples[0].split('\n')[0];
    codeHint = { ...frame, message: firstLine.slice(0, 200) };
    supporting.push({ kind: 'log', at: errorCluster.firstAt, summary: `خطای تکراری (${fa(errorCluster.count)} بار) در ${frame.file}:${frame.line}: ${firstLine.slice(0, 120)}`, weight: 0.5 });
  }
  if (!supporting.length && s.probe?.healthy) contradicting.push({ kind: 'probe', summary: 'همه‌ی درخواست‌های تست موفق بودند.', weight: 0.7 });

  return hypothesis({
    id: 'http-errors', title: codeHint ? `خطای برنامه در ${codeHint.file}:${codeHint.line}` : 'خطاهای HTTP 5xx', category: 'symptom',
    supporting, contradicting, codeHint,
    fixes: [fixes.code(codeHint ? `رفع خطا در ${codeHint.file}:${codeHint.line}` : 'بررسی خطای برنامه', 'خطاهای ۵۰۰ برطرف می‌شوند.')],
  });
}

function crashLoop(s: Snapshot): Hypothesis | null {
  const starts = s.logs.filter((l) => /listening (?:on )?(?:port )?:?\d+|server started|booting worker/i.test(l.message));
  const restarts = s.events.filter((e) => /restart|BackOff|CrashLoop|exited/i.test(e.text));
  const badApplets = s.applets.filter((a) => a.state && !/run|ready|healthy/i.test(a.state));
  const supporting: Evidence[] = [];
  if (starts.length >= 3) supporting.push({ kind: 'log', at: starts[0].at, summary: `برنامه در این بازه ${fa(starts.length)} بار از نو شروع شده است.`, weight: 0.6 });
  if (restarts.length >= 2) supporting.push({ kind: 'event', at: restarts[0].at, summary: `${fa(restarts.length)} رویداد ری‌استارت/کرش در لیارا ثبت شده.`, weight: 0.6 });
  if (badApplets.length) supporting.push({ kind: 'app', summary: `وضعیت کانتینر: ${badApplets[0].state}${badApplets[0].reason ? ` (${badApplets[0].reason})` : ''}`, weight: 0.5 });
  if (!supporting.length) return null;
  return hypothesis({ id: 'crash-loop', title: 'برنامه مدام کرش و ری‌استارت می‌شود', category: 'symptom', supporting, contradicting: [], fixes: [] });
}

const DETECTORS = [appOff, missingEnv, memory, cpu, badRelease, slow, port, build, disk, database, httpErrors, crashLoop];

export function runDetectors(s: Snapshot): Hypothesis[] {
  return DETECTORS.map((d) => d(s)).filter((h): h is Hypothesis => h !== null);
}
