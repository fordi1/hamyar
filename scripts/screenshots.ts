// Captures dashboard screenshots at desktop (1440) and mobile (375) widths with a headless
// Edge/Chrome over the DevTools protocol. Needs the dashboard running (npm run web).
//
//   npx tsx scripts/screenshots.ts [http://localhost:3000]
//
// Shots whose name ends in "-sample" render pages that need a live app on Liara (charts,
// logs, incidents, DNS steps) from sample responses injected in the browser; the server is
// not involved. The account name is masked so images are safe to publish.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = resolve('docs/screenshots');
const BROWSERS = [
  ...(process.env.HAMYAR_BROWSER ? [process.env.HAMYAR_BROWSER] : []),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const DEMO_APP = resolve('demo-app');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- sample responses (browser-side only) ----------

const SAMPLE = `
const now = Date.now();
const pts = (n, f) => Array.from({ length: n }, (_, i) => ({ t: now - (n - i) * 60000, v: f(i) }));
window.__samples = {
  '/api/status?app=sample-shop': { app: 'sample-shop', url: 'https://sample-shop.liara.run', scale: 1, platform: 'node', planID: 'small-g2', planRamGB: 0.5, planCpu: 0.5, currentRelease: 'r3', releases: [], envNames: ['DATABASE_URL', 'SESSION_SECRET'], memory: pts(30, (i) => (180 + i) * 1048576), cpu: pts(30, (i) => 0.1 + (i % 5) / 50), probe: { okRatio: 1, p50: 90, p95: 180, healthy: true } },
  '/api/apps/sample-shop/metrics': { range: '1h', since: now - 3600000, cpu: { points: pts(60, (i) => 0.12 + Math.sin(i / 6) * 0.05), last: 0.14, limit: 0.5 }, memory: { points: pts(60, (i) => 180 + i * 0.6), last: 215, limit: 512 }, networkIn: { points: pts(60, (i) => 2000 + (i % 9) * 300), last: 2400 }, networkOut: { unavailable: 'لیارا برای این بازه داده‌ای برنگرداند.' }, disks: [{ name: 'data', usedRatio: 0.12 }], releases: [{ at: now - 1800000, current: true }] },
  '/api/apps/sample-shop/logs': { counts: { error: 38, warn: 2, info: 120 }, truncated: false, topErrors: [{ template: 'x', count: 38, lastAt: now, sample: 'Error: DATABASE_URL is not defined' }], lines: [{ at: now - 5000, level: 'error', message: 'Error: DATABASE_URL is not defined\\n    at Object.<anonymous> (/app/server.js:39:11)' }, { at: now - 9000, level: 'warn', message: 'Database connection pool warning' }, { at: now - 12000, level: 'info', message: 'GET /api/users 200 120ms' }, { at: now - 15000, level: 'error', message: 'GET /products 500 4ms' }] },
  '/api/incidents/SAMPLE01': { incident: { id: 'SAMPLE01', app: 'sample-shop', title: 'متغیر DATABASE_URL تنظیم نشده', status: 'resolved', severity: 'critical', source: 'dashboard', openedAt: now - 900000, updatedAt: now - 60000, closedAt: now - 60000, diagnoses: 1, verdict: 'problem', probe: { url: 'https://sample-shop.liara.run/products', okRatio: 0, p95: 40 },
      root: { id: 'missing_env', title: 'متغیر DATABASE_URL تنظیم نشده', status: 'validated', category: 'cause', confidence: 0.95, supporting: [{ id: 'E1', kind: 'log', summary: '۳۸ بار «DATABASE_URL is not defined» در لاگ' }, { id: 'E2', kind: 'code', summary: 'server.js:39 این متغیر را می‌خواند و روی لیارا تنظیم نشده' }], contradicting: [] },
      others: [{ id: 'http_5xx', title: 'خطای ۵۰۰ در /products', status: 'validated', category: 'symptom', confidence: 0.9, supporting: [{ id: 'E4', kind: 'probe', summary: '۰ از ۳ درخواست موفق' }], contradicting: [] }],
      inconclusive: [{ id: 'database', title: 'کندی پایگاه داده', status: 'inconclusive', category: 'cause', confidence: 0.3, supporting: [], contradicting: [] }],
      rejected: [{ id: 'bad_release', title: 'نسخه‌ی بد', status: 'invalidated', category: 'cause', confidence: 0.1, supporting: [], contradicting: [{ id: 'E3', kind: 'release', summary: 'خطاها ۲ ساعت بعد از انتشار شروع شد، نه بلافاصله' }] }],
      fixes: [{ title: 'تنظیم DATABASE_URL', tier: 'T2', action: 'set_env', effect: 'خطای ۵۰۰ رفع می‌شود' }], codeHint: { file: 'server.js', line: 39 }, gaps: [], logs: [{ count: 38, sample: 'Error: DATABASE_URL is not defined' }],
      events: [{ at: now - 900000, kind: 'trigger', text: 'پایش خودکار: ۰٪ درخواست موفق' }, { at: now - 899000, kind: 'evidence', text: 'جمع‌آوری مدرک: لاگ، رویدادها، CPU/RAM، نسخه‌ها و بررسی زنده' }, { at: now - 898000, kind: 'diagnosis', text: 'علت: متغیر DATABASE_URL تنظیم نشده (اطمینان ۹۵٪)' }, { at: now - 60000, kind: 'verify', text: 'بررسی بعد از رفع: همه‌ی هدف‌ها برآورده شد' }, { at: now - 60000, kind: 'closed', text: 'حادثه بسته شد: رفع با اندازه‌گیری تأیید شد' }],
      verifications: [{ at: now - 60000, passed: true, rows: [{ metric: 'درخواست‌های موفق', before: '۰٪', after: '۱۰۰٪', target: 'حداقل ۹۵٪', ok: true }, { metric: 'زمان پاسخ (p95)', before: '—', after: '۱۸۲ms', target: 'کمتر از ۲٬۰۰۰ms', ok: true }] }] },
    actions: [{ at: now - 700000, tool: 'restart_app', outcome: 'rejected', approvedBy: 'user (dashboard)', detail: 'ری‌استارت مشکل را حل نمی‌کند' }, { at: now - 600000, tool: 'set_env', outcome: 'approved', approvedBy: 'user (dashboard)' }, { at: now - 590000, tool: 'set_env', outcome: 'executed', approvedBy: 'user (dashboard)' }],
    report: '# گزارش حادثه — sample-shop\\n\\n**وضعیت:** برطرف شد' },
  '/api/apps/sample-shop/domain?': { domain: 'shop.ir', zone: 'shop.ir', apex: true, irnic: true, onLiara: true, liaraStatus: 'PENDING', method: 'liara-dns', ready: false, notes: [], registrar: 'دامنه‌های .ir در پنل ایرنیک (nic.ir) مدیریت می‌شوند: وارد nic.ir شوید ← دامنه‌ها ← shop.ir ← تغییر سرورهای نام (DNS).', records: [{ type: 'ALIAS', name: '@', value: 'sample-shop.liara.run', purpose: 'هدایت دامنه به برنامه در لیارا', visible: false, found: [] }], nameservers: ['ns1.irnic-parking.ir', 'ns2.irnic-parking.ir'], liaraDns: { status: 'PENDING', nameServers: ['ns1.liara.ir', 'ns2.liara.ir'], active: false, missing: ['ALIAS @'] }, steps: [{ key: 'add', title: 'اضافه شدن دامنه به برنامه در لیارا', state: 'done' }, { key: 'zone', title: 'ساخت ناحیه‌ی دامنه در DNS لیارا', state: 'done' }, { key: 'ns', title: 'عوض کردن نیم‌سرورها در پنل ایرنیک', state: 'manual', detail: 'این مرحله را خودتان انجام دهید. تغییر نیم‌سرور از چند دقیقه تا ۲۴ ساعت طول می‌کشد.' }, { key: 'dns-records', title: 'ساخت رکوردهای لازم در DNS لیارا', state: 'todo' }, { key: 'ssl', title: 'فعال‌سازی SSL (https)', state: 'todo' }] },
};
const real = window.fetch;
window.fetch = (url, opts) => { const k = Object.keys(window.__samples).find((x) => String(url).startsWith(x)); return k ? Promise.resolve(new Response(JSON.stringify(window.__samples[k]), { status: 200 })) : real(url, opts); };
`;

const WIZARD_APPROVAL = `
wiz.analysis = wiz.analysis || { app: 'sample-shop', existingApps: [], env: { required: [], optional: [] }, plans: [] };
wiz.request = { id: 'SAMPLE', keys: ['DATABASE_URL'], preview: { title: 'ساخت برنامه‌ی sample-shop و اولین دیپلوی', lines: ['پلتفرم: node، پورت: 3000', 'پلن: small-g2 — ۰٫۵ گیگ رم، ۰٫۵ CPU', 'آدرس: https://sample-shop.liara.run', 'متغیرهایی که قبل از دیپلوی تنظیم می‌شوند: DATABASE_URL (مقدارها فقط به لیارا می‌رود، نه هوش مصنوعی)'], cost: 'ماهانه حدود ۴۷۵٬۰۰۰ تومان (ساعتی ۶۶۰ تومان)', risk: 'از موجودی حساب کسر می‌شود', undo: 'خاموش کردن برنامه با همیار، یا حذف از کنسول لیارا' } };
wiz.values = { DATABASE_URL: 'x' }; wiz.app = 'sample-shop'; wiz.run = null; wiz.step = 4; renderWizard();
`;

const WIZARD_PROGRESS = `${WIZARD_APPROVAL}
wiz.run = { phase: 'BUILDING', message: 'npm ci … added 214 packages', state: 'running', times: { PREPARING: Date.now() - 80000, UPLOADING: Date.now() - 70000, BUILDING: Date.now() - 55000 }, result: null, error: '' }; renderWizard();
`;

const WIZARD_RESULT = `${WIZARD_APPROVAL}
wiz.run = { phase: 'VERIFYING', state: 'verified', times: {}, result: { state: 'VERIFIED_HEALTHY', url: 'https://sample-shop.liara.run', verification: { rounds: 3, okRatio: 1, p95: 182 } } }; renderWizard();
`;

const LOCAL_ANALYSIS = `
document.querySelector('[data-origin="local"]').click();
await new Promise((r) => setTimeout(r, 200));
document.querySelector('#local-path').value = ${JSON.stringify(DEMO_APP)};
document.querySelector('#source-form').requestSubmit();
await new Promise((r) => setTimeout(r, 5000));
`;

interface Shot {
  name: string;
  hash: string;
  setup?: string;
  wait?: number;
}

const SHOTS: Shot[] = [
  { name: '01-home', hash: '#/' },
  { name: '02-deploy-source', hash: '#/deploy', setup: "sessionStorage.removeItem('hamyar_wizard'); resetWizard(); renderWizard();" },
  { name: '03-deploy-analysis', hash: '#/deploy', setup: "sessionStorage.removeItem('hamyar_wizard'); resetWizard(); renderWizard();" + LOCAL_ANALYSIS },
  { name: '04-deploy-approval-sample', hash: '#/deploy', setup: WIZARD_APPROVAL },
  { name: '05-deploy-progress-sample', hash: '#/deploy', setup: WIZARD_PROGRESS },
  { name: '06-deploy-result-sample', hash: '#/deploy', setup: WIZARD_RESULT },
  { name: '07-monitoring-sample', hash: '#/', setup: `${SAMPLE} location.hash = '#/apps/sample-shop/monitoring';`, wait: 2500 },
  { name: '08-logs-sample', hash: '#/', setup: `${SAMPLE} location.hash = '#/apps/sample-shop/logs';`, wait: 2500 },
  { name: '09-incident-sample', hash: '#/', setup: `${SAMPLE} location.hash = '#/incidents/SAMPLE01';`, wait: 2500 },
  { name: '10-domain-sample', hash: '#/', setup: `${SAMPLE} location.hash = '#/domains/sample-shop/shop.ir';`, wait: 2500 },
  { name: '11-approvals', hash: '#/approvals' },
];

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
  { label: 'mobile', width: 375, height: 812, scale: 2, mobile: true },
];

// ---------- DevTools protocol ----------

async function main() {
  const browser = BROWSERS.find((b) => existsSync(b));
  if (!browser) throw new Error('Edge or Chrome not found');
  const profile = mkdtempSync(join(tmpdir(), 'hamyar-shots-'));
  // --remote-debugging-pipe talks over fds 3/4 (NUL-separated JSON), so no TCP port is opened
  const proc = spawn(browser, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--lang=fa', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  proc.on('exit', (code) => console.error(`browser exited (code ${code})`));
  // keeps the process alive while waiting for the browser
  const keepAlive = setInterval(() => {}, 1000);
  const toBrowser = proc.stdio[3] as NodeJS.WritableStream;
  const fromBrowser = proc.stdio[4] as NodeJS.ReadableStream;
  try {
    let seq = 0;
    let sessionId: string | undefined;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    let buffer = '';
    fromBrowser.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const p = msg.id && pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      }
    });
    const call = (method: string, params: Record<string, unknown> = {}, session?: string) =>
      new Promise<any>((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        toBrowser.write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0');
      });
    let pageTarget: any;
    for (let i = 0; i < 40 && !pageTarget; i++) {
      await sleep(250);
      pageTarget = (await call('Target.getTargets')).targetInfos.find((t: any) => t.type === 'page');
    }
    if (!pageTarget) throw new Error('browser did not start');
    sessionId = (await call('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })).sessionId;
    const send = (method: string, params: Record<string, unknown> = {}) => call(method, params, sessionId);
    const run = async (expression: string) => {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result?.value;
    };

    mkdirSync(OUT, { recursive: true });
    for (const vp of VIEWPORTS) {
      for (const shot of SHOTS) {
        await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile });
        await send('Page.navigate', { url: 'about:blank' });
        await sleep(200);
        await send('Page.navigate', { url: `${BASE}/${shot.hash}` });
        await sleep(2500);
        if (shot.setup) await run(shot.setup);
        await sleep(shot.wait ?? 1200);
        // publishable: no real name on the image
        await run("const n = document.querySelector('#account-name'); if (n) n.textContent = 'حساب نمونه'; const a = document.querySelector('#account-avatar'); if (a) a.textContent = 'ح'; window.scrollTo(0, 0);");
        const height = Math.min(2600, Math.max(vp.height, await run('return document.documentElement.scrollHeight;')));
        await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height, deviceScaleFactor: vp.scale, mobile: vp.mobile });
        await sleep(400);
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        const file = join(OUT, `${shot.name}-${vp.label}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        console.log('saved', file);
      }
    }
  } finally {
    clearInterval(keepAlive);
    proc.kill();
    await sleep(1500);
    // Windows may still hold the profile for a moment; a leftover temp folder is harmless
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
