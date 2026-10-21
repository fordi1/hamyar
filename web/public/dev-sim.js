// Development-only UI simulation (not loaded by index.html): replays a full incident flow
// against stubbed API responses so the dashboard can be inspected without Liara or the AI.
// Load it from the browser console: await import('/dev-sim.js')
const now = Date.now();
const series = (f) => Array.from({ length: 30 }, (_, i) => ({ t: now - (30 - i) * 60000, v: f(i) }));
const realFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  const json = (b) => new Response(JSON.stringify(b));
  if (u.startsWith('/api/status')) {
    return json({ app: 'hamyar-shop', url: 'https://hamyar-shop.liara.run', status: 'RUNNING', scale: 1, platform: 'node', planID: 'small-g2', planRamGB: 0.5, planCpu: 0.5, currentRelease: '65f1a2b3c4', releases: [], envNames: ['DATABASE_URL', 'FAULT'], memory: series((i) => (95 + i * 12 + (i % 3) * 4) * 1024 * 1024), cpu: series((i) => 0.04 + (i % 5) * 0.012), probe: { okRatio: 1, p50: 22, p95: 42, healthy: true } });
  }
  if (u.startsWith('/api/approve')) return json({ ok: true });
  if (u.startsWith('/api/audit')) {
    return json([
      { at: new Date(now - 60000).toISOString(), tool: 'set_env', tier: 'T2', args: { app: 'hamyar-shop' }, outcome: 'executed', approvedBy: 'user (dashboard)' },
      { at: new Date(now - 300000).toISOString(), tool: 'resize_plan', tier: 'T2', args: { app: 'hamyar-shop' }, outcome: 'rejected', approvedBy: 'user (dashboard)' },
      { at: new Date(now - 900000).toISOString(), tool: 'launch_app', tier: 'T2', args: { app: 'hamyar-shop' }, outcome: 'executed', approvedBy: 'user (dashboard)' },
    ]);
  }
  return realFetch(url, opts);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('#app-select').innerHTML = '<option value="hamyar-shop">hamyar-shop</option>';
document.querySelector('#balance-text').textContent = '۲۵۰٬۰۰۰ تومان';
state.app = 'hamyar-shop';
await loadStatus();
await loadTimeline();

addMessage('user', 'سایتم خطای ۵۰۰ می‌دهد، علتش چیست؟');
ensureRun();
handleEvent({ type: 'tool', name: 'diagnose', status: 'start', args: { app: 'hamyar-shop' } });
await wait(300);
handleEvent({
  type: 'tool', name: 'diagnose', status: 'done', output: 'بررسی hamyar-shop: مشکل پیدا شد',
  data: {
    kind: 'board', app: 'hamyar-shop', verdict: 'problem', probe: { okRatio: 0, p95: 30 },
    root: { id: 'missing-env', title: 'متغیر محیطی DATABASE_URL تنظیم نشده', status: 'validated', category: 'cause', confidence: 0.95,
      supporting: [{ id: 'E1', kind: 'log', summary: 'لاگ برنامه ۲۵ بار گفته «DATABASE_URL» تنظیم نشده و این متغیر در تنظیمات لیارا وجود ندارد' }, { id: 'E2', kind: 'code', summary: 'کد در server.js:39 متغیر DATABASE_URL را می‌خواند ولی روی لیارا تنظیم نشده است.' }], contradicting: [] },
    others: [{ id: 'http-errors', title: 'خطای برنامه در server.js:40', category: 'symptom', status: 'validated', confidence: 0.88, supporting: [], contradicting: [] }],
    inconclusive: [],
    rejected: [
      { id: 'memory', title: 'کمبود حافظه (OOM)', status: 'invalidated', category: 'cause', confidence: 0, supporting: [], contradicting: [{ id: 'E6', kind: 'metric', summary: 'بیشترین مصرف رم ۴۵۵MB است، یعنی ۸۹٪ سقف پلن.' }] },
      { id: 'cpu', title: 'پر شدن ظرفیت CPU', status: 'invalidated', category: 'cause', confidence: 0, supporting: [], contradicting: [{ id: 'E7', kind: 'metric', summary: 'مصرف CPU فقط ۱۴٪ سقف پلن است.' }] },
    ],
    fixes: [{ title: 'تنظیم متغیر DATABASE_URL روی لیارا', tier: 'T2', action: 'set_env' }, { title: 'رفع خطا در server.js:40', tier: 'code', action: 'code_fix' }],
    codeHint: { file: 'server.js', line: 39, message: 'DATABASE_URL is read here' }, gaps: [],
  },
});
handleEvent({ type: 'tool', name: 'set_env', status: 'start', args: { app: 'hamyar-shop', keys: ['DATABASE_URL'] } });
handleEvent({ type: 'approval', id: 'sim1', tool: 'set_env', tier: 'T2', needsValues: ['DATABASE_URL'], preview: { title: 'تنظیم متغیرهای محیطی hamyar-shop', lines: ['DATABASE_URL: مقدار را خودتان وارد کنید (به هوش مصنوعی داده نمی‌شود)', 'متغیرهای فعلی حفظ می‌شوند.'], risk: 'کم', downtime: 'یک ری‌استارت کوتاه', undo: 'تغییر دوباره‌ی مقدار' } });

if (new URLSearchParams(location.search).has('pending')) throw new Error('stopped at the approval card');

const card = document.querySelector('.approval');
card.querySelector('input[data-key]').value = 'postgres://shop:demo@db:5432/shop';
card.querySelector('.approve').click();
await wait(400);
handleEvent({ type: 'tool', name: 'set_env', status: 'done', output: 'متغیرها ذخیره شدند (اضافه: DATABASE_URL). لیارا برنامه را ری‌استارت می‌کند.' });
handleEvent({ type: 'tool', name: 'verify', status: 'start', args: { app: 'hamyar-shop' } });
await wait(600);
handleEvent({ type: 'tool', name: 'verify', status: 'done', output: 'مشکل برطرف شد', data: { kind: 'verify', passed: true, rows: [
  { metric: 'درخواست‌های موفق', before: '۰٪', after: '۱۰۰٪', target: 'حداقل ۹۵٪', ok: true },
  { metric: 'زمان پاسخ (p95)', before: '۳۰ms', after: '۴۲ms', target: 'کمتر از ۲٬۰۰۰ms', ok: true },
] } });
handleEvent({ type: 'assistant', text: 'مشکل برطرف شد. علت اصلی این بود که **متغیر `DATABASE_URL` روی لیارا تنظیم نشده بود** (شاهد E1 و E2). مقدار را تنظیم کردم و بعد از ری‌استارت، همه‌ی درخواست‌ها موفق شدند (۰٪ ← ۱۰۰٪).' });
finishRun();
setHealth('ok', 'سالم');
