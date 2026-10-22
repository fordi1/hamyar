// Services list and app pages: overview, monitoring (screen C), logs and releases.
// Every number comes from Liara or Hamyar's own probe; a missing series says so.
// App buttons (restart, on/off, rollback) file an approval request and run once approved.
'use strict';

const APP_TABS = [
  ['overview', 'نمای کلی'],
  ['monitoring', 'مانیتورینگ'],
  ['logs', 'لاگ‌ها'],
  ['releases', 'نسخه‌ها'],
];
const RANGE_LABELS = { '1h': '۱ ساعت', '24h': '۲۴ ساعت', '7d': '۷ روز' };
const LOG_RANGE_LABELS = { '15m': '۱۵ دقیقه‌ی اخیر', '1h': '۱ ساعت اخیر', '6h': '۶ ساعت اخیر', '24h': '۲۴ ساعت اخیر' };
const RELEASE_STATE = { READY: ['ok', 'سالم'], FAILED: ['bad', 'ناموفق'], CANCELED: ['off', 'لغو شد'], BUILDING: ['', 'در حال ساخت'], DEPLOYING: ['', 'در حال استقرار'] };

const appsView = () => $('#apps-view');
const appPrefs = { range: '1h', logRange: '1h', level: '', q: '' };

const faInt = (n) => Number(n).toLocaleString('fa-IR', { useGrouping: false });
const when = (ms) => new Date(ms).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const logTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran', hour12: false });
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'همین حالا';
  if (s < 3600) return `${fa(Math.floor(s / 60))} دقیقه پیش`;
  if (s < 86400) return `${fa(Math.floor(s / 3600))} ساعت پیش`;
  return `${fa(Math.floor(s / 86400))} روز پیش`;
}
function bytes(v) {
  if (v >= 1024 * 1024) return `${fa(Math.round((v / 1024 / 1024) * 10) / 10)} MB`;
  if (v >= 1024) return `${fa(Math.round(v / 1024))} KB`;
  return `${fa(Math.round(v))} B`;
}

async function getJson(path) {
  const res = await api(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `خطای ${res.status}`);
  return data;
}

const loadingView = () => '<div class="skeleton" aria-label="در حال بارگذاری"></div>';
const failView = (err, retry) => `<p class="form-error" role="alert">${icon('alert')}<span>${esc(err.message)}</span></p>${retry ? `<button class="btn" type="button" data-retry>${icon('refresh')}تلاش دوباره</button>` : ''}`;

// ---------- services list ----------

async function renderAppList() {
  const el = appsView();
  el.innerHTML = `<div class="page-head row"><div><h1>سرویس‌ها</h1><p>برنامه‌های شما روی لیارا</p></div><a class="btn primary" href="#/deploy">${icon('rocket')}دیپلوی جدید</a></div>${loadingView()}`;
  try {
    const { apps } = await getJson('/api/apps');
    const list = apps.length
      ? `<div class="app-list">${apps
          .map((a) => {
            const off = a.scale === 0;
            return `<a class="app-item" href="#/apps/${encodeURIComponent(a.name)}">
              <span class="row"><b>${esc(a.name)}</b><span class="pill" data-state="${off ? 'off' : 'ok'}"><span class="dot"></span>${off ? 'خاموش' : 'روشن'}</span></span>
              <small>${esc(a.type || '—')} · پلن ${esc(a.planID || '—')}</small>
              <small class="app-url"><bdi>${esc(a.name)}.liara.run</bdi></small>
            </a>`;
          })
          .join('')}</div><p class="note-sm">«روشن/خاموش» وضعیت لیاراست؛ سلامت واقعی هر برنامه در صفحه‌ی خودش اندازه‌گیری می‌شود.</p>`
      : `<div class="card empty-card">${mascot('')}<b>هنوز برنامه‌ای روی لیارا ندارید</b><span class="muted">اولین پروژه‌تان را با چند کلیک بالا بیاورید.</span><a class="btn primary" href="#/deploy">${icon('rocket')}دیپلوی پروژه</a></div>`;
    el.querySelector('.skeleton').outerHTML = list;
  } catch (err) {
    if (err.message === 'login required') return;
    el.querySelector('.skeleton').outerHTML = failView(err, true);
    el.querySelector('[data-retry]').onclick = renderAppList;
  }
}

// ---------- app page shell ----------

async function renderAppPage(app, tab) {
  if (!APP_TABS.some(([t]) => t === tab)) tab = 'overview';
  // the status panel and chat follow the app being viewed
  if (state.app !== app) {
    state.app = app;
    const select = $('#app-select');
    if ([...select.options].some((o) => o.value === app)) select.value = app;
    loadStatus();
  }
  const el = appsView();
  el.innerHTML = `
    <div class="app-header">
      <div class="app-title">${mascot()}<div><h1>${esc(app)}</h1><a href="https://${esc(app)}.liara.run" target="_blank" rel="noopener">${esc(app)}.liara.run</a></div><span class="pill" id="app-health"><span class="dot"></span>در حال بررسی…</span></div>
      <div class="toolbar" id="app-buttons">
        <button class="btn" type="button" data-action="restart_app">${icon('refresh')}ری‌استارت</button>
        <button class="btn" type="button" data-action="scale" hidden></button>
        <button class="btn" type="button" id="app-diagnose">${icon('bug')}تشخیص مشکل</button>
      </div>
    </div>
    <div id="app-action-box" class="stack"></div>
    <nav class="tabs" aria-label="بخش‌های برنامه">${APP_TABS.map(([t, label]) => `<a href="#/apps/${encodeURIComponent(app)}/${t}"${t === tab ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div id="app-tab" class="stack">${loadingView()}</div>`;
  el.querySelector('[data-action="restart_app"]').onclick = () => requestAction('restart_app', { app });
  $('#app-diagnose').onclick = () => {
    location.hash = '#/';
    const prompt = `برنامه‌ی ${app} را بررسی کن و علت مشکلش را پیدا کن.`;
    state.ai ? send(prompt) : quick(prompt, 'diagnose');
  };
  loadHeader(app);
  const render = { overview: tabOverview, monitoring: tabMonitoring, logs: tabLogs, releases: tabReleases }[tab];
  render(app, $('#app-tab'));
}

// health pill and the on/off button from one real status read
async function loadHeader(app) {
  try {
    const s = await getJson(`/api/status?app=${encodeURIComponent(app)}`);
    if (state.app !== app) return;
    const off = s.scale === 0;
    const healthy = s.probe.healthy && !off;
    const pill = $('#app-health');
    pill.dataset.state = off ? 'off' : healthy ? 'ok' : 'bad';
    pill.innerHTML = `<span class="dot"></span>${off ? 'خاموش' : healthy ? 'سالم' : 'مشکل دارد'}`;
    const scale = document.querySelector('[data-action="scale"]');
    scale.hidden = false;
    scale.innerHTML = off ? `${icon('rocket')}روشن کردن` : `${icon('stop')}خاموش کردن`;
    scale.onclick = () => requestAction(off ? 'turn_on_app' : 'turn_off_app', { app });
    appsView().dataset.status = JSON.stringify(s);
    return s;
  } catch (err) {
    const pill = $('#app-health');
    if (pill) {
      pill.dataset.state = '';
      pill.innerHTML = `<span class="dot"></span>وضعیت خوانده نشد`;
      pill.title = err.message;
    }
  }
}

// ---------- actions: request → approval card → run → result ----------

async function requestAction(tool, args) {
  const box = $('#app-action-box');
  box.innerHTML = `<div class="op-status"><span class="spin2"></span>در حال آماده‌سازی درخواست…</div>`;
  try {
    const res = await api('/api/action/request', { method: 'POST', body: { tool, args } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data.status === 'done') {
      box.innerHTML = `<div class="op-status ok">${icon('check')}انجام شد (در حالت خودکار محدود، بدون نیاز به تأیید).</div>`;
      return loadHeader(args.app);
    }
    box.innerHTML = '';
    const card = approvalCard(data, box);
    card.querySelector('.approval-head').insertAdjacentHTML('beforeend', `<span class="badge source">#${esc(data.id)}</span>`);
    card.querySelector('.approve').addEventListener('click', () => watchOperation(data.id, args.app, box, card));
    loadInbox();
  } catch (err) {
    if (err.message !== 'login required') box.innerHTML = failView(err);
  }
}

// After approval the server runs the action; follow it through the operations store.
function watchOperation(approvalId, app, box, card) {
  const status = document.createElement('div');
  status.className = 'op-status';
  status.innerHTML = '<span class="spin2"></span>تأیید شد؛ در حال اجرا روی لیارا…';
  box.appendChild(status);
  const started = Date.now();
  const tick = async () => {
    // the approve call itself failed (expired, revoked): the card already says why
    if (card?.classList.contains('no')) return status.remove();
    try {
      const { active, recent } = await getJson('/api/operations');
      const op = [...active, ...recent].find((o) => o.approvalId === approvalId);
      if (op && op.finished) {
        const ok = ['VERIFIED_HEALTHY', 'DONE'].includes(op.state);
        status.className = `op-status ${ok ? 'ok' : 'bad'}`;
        status.innerHTML = `${icon(ok ? 'check' : 'x')}${ok ? 'انجام شد' : `ناموفق: ${esc(op.summary || PHASE_LABELS[op.state] || op.state)}`}`;
        loadTimeline();
        if (state.app === app) loadHeader(app);
        return;
      }
      if (op?.events?.length) status.innerHTML = `<span class="spin2"></span>${esc(PHASE_LABELS[op.events.at(-1).phase] || op.events.at(-1).phase)}${op.events.at(-1).message ? ` · ${esc(op.events.at(-1).message)}` : ''}`;
    } catch {}
    if (Date.now() - started < 15 * 60_000 && status.isConnected) setTimeout(tick, 2000);
  };
  setTimeout(tick, 1000);
}

// ---------- overview ----------

async function tabOverview(app, el) {
  try {
    const s = await getJson(`/api/status?app=${encodeURIComponent(app)}`);
    const mem = s.memory.at(-1)?.v;
    const cpu = s.cpu.at(-1)?.v;
    const memLimit = s.planRamGB ? s.planRamGB * 1024 : 0;
    const audit = await getJson('/api/audit').catch(() => []);
    const mine = audit.filter((e) => e.args?.app === app && e.outcome !== 'previewed').slice(0, 8);
    el.innerHTML = `
      <div class="grid4">
        <div class="stat"><span>درخواست موفق</span><b class="${s.probe.okRatio < 0.95 ? 'bad' : ''}">${pct(s.probe.okRatio)}</b><span class="src">بررسی همیار · ${clock()}</span></div>
        <div class="stat"><span>زمان پاسخ (p95)</span><b>${fa(s.probe.p95)} <small>ms</small></b><span class="src">بررسی همیار</span></div>
        <div class="stat"><span>حافظه</span>${mem === undefined ? '<b>—</b><span class="src">لیارا داده‌ای نداد</span>' : `<b>${fa(Math.round(mem / 1024 / 1024))} <small>${memLimit ? `/ ${fa(memLimit)} ` : ''}MB</small></b>${meter(share(mem / 1024 / 1024, memLimit), 'violet')}`}</div>
        <div class="stat"><span>پردازنده</span>${cpu === undefined ? '<b>—</b><span class="src">لیارا داده‌ای نداد</span>' : `<b>${fa(Math.round(cpu * 100) / 100)} <small>${s.planCpu ? `از ${fa(s.planCpu)} ` : ''}هسته</small></b>${meter(share(cpu, s.planCpu))}`}</div>
      </div>
      <div class="grid2">
        <section class="card"><h2>مشخصات</h2><dl class="meta">
          <dt>پلن</dt><dd>${esc(s.planID)}${s.planRamGB ? ` · ${fa(s.planRamGB)} گیگ رم` : ''}</dd>
          <dt>پلتفرم</dt><dd>${esc(s.platform || '—')}</dd>
          <dt>نسخه‌ی فعال</dt><dd><bdi>${esc(s.currentRelease || '—')}</bdi></dd>
          <dt>متغیرها</dt><dd>${s.envNames.length ? `<bdi>${esc(s.envNames.join('، '))}</bdi>` : '—'}<br><small class="muted">مقدارها نمایش داده نمی‌شوند</small></dd>
        </dl></section>
        <section class="card"><h2>عملیات این برنامه</h2><ol class="timeline">${mine.length ? mine.map(timelineItem).join('') : '<li class="muted">هنوز عملیاتی با همیار روی این برنامه انجام نشده.</li>'}</ol></section>
      </div>`;
  } catch (err) {
    if (err.message === 'login required') return;
    el.innerHTML = failView(err, true);
    el.querySelector('[data-retry]').onclick = () => tabOverview(app, el);
  }
}

// ---------- monitoring ----------

function bigChart(lines, { limit, markers = [], since, until }) {
  const all = lines.flatMap((l) => l.points);
  if (!all.length) return '';
  const w = 600, h = 160, pad = 6;
  const t0 = since ?? all[0].t, t1 = until ?? Date.now();
  const top = Math.max(limit || 0, ...all.map((p) => p.v)) * 1.1 || 1;
  const x = (t) => (((t - t0) / Math.max(1, t1 - t0)) * w).toFixed(1);
  const y = (v) => (h - pad - (v / top) * (h - pad * 2)).toFixed(1);
  const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${w}" y1="${(h * f).toFixed(1)}" y2="${(h * f).toFixed(1)}" stroke="#e4e7f2"/>`).join('');
  const marks = markers.map((m) => `<line x1="${x(m.at)}" x2="${x(m.at)}" y1="0" y2="${h}" stroke="#8b5cf6" stroke-dasharray="4 4" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`).join('');
  const limitLine = limit ? `<line x1="0" x2="${w}" y1="${y(limit)}" y2="${y(limit)}" stroke="#d42a40" stroke-opacity=".6" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>` : '';
  const paths = lines
    .map((l) => {
      const pts = l.points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ');
      return `${l.fill ? `<polygon fill="${l.color}" fill-opacity=".1" points="${x(l.points[0].t)},${h} ${pts} ${x(l.points.at(-1).t)},${h}"/>` : ''}<polyline fill="none" stroke="${l.color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${pts}"/>`;
    })
    .join('');
  return `<div class="chart-big"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${grid}${limitLine}${marks}${paths}</svg></div>
    <div class="chart-axis"><span>${when(t0)}</span><span>اکنون</span></div>`;
}

const unavailCard = (title, why) => `<div class="unavail">${icon('alert')}<span><b>${title}</b><br>${esc(why)}</span></div>`;

function metricCard(title, series, { color, swatch, unit, format, limitLabel, markers, since }) {
  if (series.unavailable) return `<section class="card chart-card"><h3>${title}</h3>${unavailCard('داده‌ای نیست', series.unavailable)}</section>`;
  return `<section class="card chart-card">
    <div class="chart-head"><h3>${title}</h3><b>${format(series.last)}${series.limit ? ` از ${format(series.limit)}` : ''} ${unit}</b></div>
    <div class="legend"><span><i class="sw ${swatch}"></i>مقدار</span>${series.limit ? `<span><i class="sw sw-danger"></i>${limitLabel}</span>` : ''}${markers.length ? '<span><i class="sw sw-violet"></i>انتشار نسخه</span>' : ''}<span>منبع: لیارا</span></div>
    ${bigChart([{ points: series.points, color, fill: true }], { limit: series.limit, markers, since })}
  </section>`;
}

async function tabMonitoring(app, el) {
  const seg = Object.entries(RANGE_LABELS).map(([r, label]) => `<button type="button" data-range="${r}" aria-pressed="${appPrefs.range === r}">${label}</button>`).join('');
  el.innerHTML = `<div class="toolbar"><div class="seg" role="group" aria-label="بازه‌ی زمانی">${seg}</div><button class="btn" type="button" id="probe-now">${icon('pulse')}بررسی سلامت الان</button></div>
    <div id="probe-box"></div><div id="metrics-box" class="stack">${loadingView()}</div>`;
  el.querySelectorAll('[data-range]').forEach((b) => (b.onclick = () => ((appPrefs.range = b.dataset.range), tabMonitoring(app, el))));
  $('#probe-now').onclick = async () => {
    const box = $('#probe-box');
    box.innerHTML = `<div class="op-status"><span class="spin2"></span>در حال ارسال درخواست به سایت…</div>`;
    try {
      const p = await getJson(`/api/probe?app=${encodeURIComponent(app)}`);
      box.innerHTML = `<div class="op-status ${p.healthy ? 'ok' : 'bad'}">${icon(p.healthy ? 'check' : 'alert')}${p.healthy ? 'سالم' : 'مشکل دارد'} · ${pct(p.okRatio)} درخواست موفق · زمان پاسخ (p95) ${fa(p.p95)}ms · ${clock()}</div>`;
    } catch (err) {
      box.innerHTML = failView(err);
    }
  };
  const box = $('#metrics-box');
  try {
    const m = await getJson(`/api/apps/${encodeURIComponent(app)}/metrics?range=${appPrefs.range}`);
    const markers = m.releases;
    const opts = { markers, since: m.since };
    const disks = m.disks.length
      ? `<section class="card"><h2>دیسک</h2>${m.disks.map((d) => `<div class="split"><bdi>${esc(d.name)}</bdi><b>${pct(d.usedRatio)}</b></div>${meter(d.usedRatio)}`).join('')}<span class="src">منبع: لیارا</span></section>`
      : '';
    box.innerHTML = `
      <div class="grid2">
        ${metricCard('پردازنده', m.cpu, { ...opts, swatch: 'sw-primary', color: '#3d4ee8', unit: 'هسته', format: (v) => fa(Math.round(v * 100) / 100), limitLabel: 'سقف پلن' })}
        ${metricCard('حافظه', m.memory, { ...opts, swatch: 'sw-violet', color: '#8b5cf6', unit: 'MB', format: (v) => fa(Math.round(v)), limitLabel: 'سقف پلن' })}
        ${metricCard('ترافیک ورودی', m.networkIn, { ...opts, swatch: 'sw-info', color: '#2f80ed', unit: '', format: bytes, limitLabel: '' })}
        ${metricCard('ترافیک خروجی', m.networkOut, { ...opts, swatch: 'sw-success', color: '#12a150', unit: '', format: bytes, limitLabel: '' })}
      </div>
      ${disks}
      ${unavailCard('تعداد درخواست‌ها و کدهای وضعیت', 'لیارا این آمار را از API نمی‌دهد و همیار عدد ساختگی نشان نمی‌دهد. برای خطاها «لاگ‌ها» را ببینید؛ برای سلامت لحظه‌ای «بررسی سلامت الان» را بزنید.')}
      <p class="note-sm">واحد ترافیک شبکه همان چیزی است که لیارا برمی‌گرداند و هنوز روی یک برنامه‌ی واقعی تأیید نشده است.</p>`;
  } catch (err) {
    if (err.message === 'login required') return;
    box.innerHTML = failView(err, true);
    box.querySelector('[data-retry]').onclick = () => tabMonitoring(app, el);
  }
}

// ---------- logs ----------

async function tabLogs(app, el) {
  const ranges = Object.entries(LOG_RANGE_LABELS).map(([r, l]) => `<option value="${r}"${appPrefs.logRange === r ? ' selected' : ''}>${l}</option>`).join('');
  const levels = [['', 'همه‌ی سطح‌ها'], ['error', 'فقط خطا'], ['warn', 'فقط هشدار'], ['info', 'فقط اطلاعات']].map(([v, l]) => `<option value="${v}"${appPrefs.level === v ? ' selected' : ''}>${l}</option>`).join('');
  el.innerHTML = `
    <form class="toolbar" id="log-form" role="search">
      <input class="grow" id="log-q" type="search" placeholder="جست‌وجو در لاگ‌ها" value="${esc(appPrefs.q)}" aria-label="جست‌وجو در لاگ‌ها">
      <select id="log-level" aria-label="سطح">${levels}</select>
      <select id="log-range" aria-label="بازه">${ranges}</select>
      <button class="btn" type="submit">${icon('refresh')}تازه‌سازی</button>
    </form>
    <div id="log-box" class="stack">${loadingView()}</div>`;
  const reload = () => {
    appPrefs.q = $('#log-q').value.trim();
    appPrefs.level = $('#log-level').value;
    appPrefs.logRange = $('#log-range').value;
    tabLogs(app, el);
  };
  $('#log-form').onsubmit = (e) => {
    e.preventDefault();
    reload();
  };
  $('#log-level').onchange = reload;
  $('#log-range').onchange = reload;
  const box = $('#log-box');
  try {
    const q = new URLSearchParams({ range: appPrefs.logRange, ...(appPrefs.level ? { level: appPrefs.level } : {}), ...(appPrefs.q ? { q: appPrefs.q } : {}) });
    const r = await getJson(`/api/apps/${encodeURIComponent(app)}/logs?${q}`);
    const counts = `<div class="chips"><span class="chip-i ${r.counts.error ? 'bad' : 'ok'}">${fa(r.counts.error)} خطا</span><span class="chip-i warn">${fa(r.counts.warn)} هشدار</span><span class="chip-i">${fa(r.counts.info)} اطلاعات</span><span class="note-sm">${LOG_RANGE_LABELS[appPrefs.logRange]}</span></div>`;
    const top = r.topErrors[0];
    const insight = top
      ? `<section class="insight"><div class="insight-head"><b>${mascot()}تحلیل همیار</b><span class="pill" data-state="bad">${fa(top.count)} بار در این بازه</span></div>
          <span>پرتکرارترین خطا:</span><code>${esc(top.sample.split('\n')[0].slice(0, 300))}</code>
          <span class="note-sm">این فقط شمارش لاگ است، نه تشخیص علت. برای پیدا کردن علت با مدرک، بررسی کامل را اجرا کنید.</span>
          <div class="toolbar"><button class="btn primary" type="button" id="log-diagnose">${icon('bug')}بررسی کامل و پیشنهاد رفع</button></div></section>`
      : '';
    const lines = r.lines.length
      ? `<section class="card log-list">${r.lines.map((l) => `<div class="log-line"><time>${logTime(l.at)}</time><span class="lvl ${l.level}">${l.level.toUpperCase()}</span><span>${esc(l.message)}</span></div>`).join('')}</section>`
      : `<p class="empty">${icon('file')}${appPrefs.q || appPrefs.level ? 'هیچ خطی با این فیلتر پیدا نشد.' : 'در این بازه لاگی ثبت نشده است.'}</p>`;
    box.innerHTML = counts + insight + lines + (r.truncated ? '<p class="note-sm">فقط ۳۰۰ خط آخر نمایش داده شده؛ برای دیدن بقیه، فیلتر یا جست‌وجو را دقیق‌تر کنید.</p>' : '');
    $('#log-diagnose')?.addEventListener('click', () => {
      location.hash = '#/';
      const prompt = `در لاگ‌های ${app} این خطا ${top.count} بار تکرار شده: «${top.sample.split('\n')[0].slice(0, 160)}». علتش را پیدا کن و راه رفع پیشنهاد بده.`;
      state.ai ? send(prompt) : quick(prompt, 'diagnose');
    });
  } catch (err) {
    if (err.message === 'login required') return;
    box.innerHTML = failView(err, true);
    box.querySelector('[data-retry]').onclick = () => tabLogs(app, el);
  }
}

// ---------- releases ----------

async function tabReleases(app, el) {
  try {
    const list = await getJson(`/api/apps/${encodeURIComponent(app)}/releases`);
    if (!list.length) {
      el.innerHTML = `<p class="empty">${icon('server')}هنوز نسخه‌ای منتشر نشده است.</p>`;
      return;
    }
    el.innerHTML = `<section class="card">${list
      .map((r) => {
        const [cls, label] = RELEASE_STATE[r.state] || ['', r.state];
        return `<div class="release">
          <span class="pill" data-state="${cls}"><span class="dot"></span>${label}</span>
          <span><b>${r.current ? 'نسخه‌ی فعال · ' : ''}${esc(when(r.createdAt))}</b><small>${ago(r.createdAt)} · <span class="id">${esc(r.id)}</span></small>${r.failReason ? `<small>علت شکست: ${esc(r.failReason)}</small>` : ''}</span>
          ${r.canRollback ? `<button class="btn" type="button" data-rollback="${esc(r.id)}">${icon('undo')}بازگشت به این نسخه</button>` : '<span></span>'}
        </div>`;
      })
      .join('')}</section>
      <p class="note-sm">بازگشت فقط به نسخه‌های سالم ممکن است و قبل از اجرا تأیید شما را می‌خواهد. بعد از بازگشت، همیار سلامت سایت را دوباره می‌سنجد.</p>`;
    el.querySelectorAll('[data-rollback]').forEach((b) => (b.onclick = () => requestAction('rollback', { app, releaseID: b.dataset.rollback })));
  } catch (err) {
    if (err.message === 'login required') return;
    el.innerHTML = failView(err, true);
    el.querySelector('[data-retry]').onclick = () => tabReleases(app, el);
  }
}

// ---------- entry ----------

function renderApps(app, tab) {
  if (!appsView()) return;
  if (app) renderAppPage(app, tab);
  else renderAppList();
}

window.renderApps = renderApps;
if (!$('[data-page="apps"]').hidden) {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  renderApps(parts[1], parts[2]);
}
