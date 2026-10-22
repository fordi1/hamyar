// Deploy wizard (screen B): source → analysis and plan → settings → approval, progress, result.
// Shares helpers with app.js ($, esc, icon, mascot, fa, api, toast, state, send, quick).
// Env values live only in memory here and go to the server once, with the approve click.
'use strict';

const WIZ_STEPS = ['منبع کد', 'بررسی و پلن', 'تنظیمات', 'دیپلوی'];
const ORIGINS = {
  zip: { icon: 'upload', title: 'آپلود فایل ZIP', hint: 'پوشه‌ی پروژه را زیپ کنید و اینجا بکشید' },
  github: { icon: 'github', title: 'GitHub', hint: 'آدرس یک ریپازیتوری عمومی' },
  local: { icon: 'folder', title: 'پروژه‌ی محلی', hint: 'پوشه‌ای روی همین کامپیوتر' },
};
const DEPLOY_PHASES = [
  ['PREPARING', 'ساخت برنامه و تنظیم متغیرها'],
  ['UPLOADING', 'بسته‌بندی و آپلود کد به لیارا'],
  ['BUILDING', 'ساخت (build) روی لیارا'],
  ['DEPLOYING', 'استقرار نسخه'],
  ['VERIFYING', 'بررسی سلامت سایت'],
];
const ROLE_LABEL = { cheaper: 'ارزان‌تر', recommended: 'پیشنهاد همیار', bigger: 'برای ترافیک بیشتر' };
const APP_NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;

// Saved across refreshes: everything except env values.
const wiz = Object.assign(
  { step: 1, origin: 'github', github: { url: '', branch: '', subdir: '' }, localPath: '', zipSubdir: '', source: null, subdir: '', analysis: null, planID: '', bundleID: '', blocked: [], app: '', request: null },
  (() => {
    try {
      return JSON.parse(sessionStorage.getItem('hamyar_wizard') || '{}');
    } catch {
      return {};
    }
  })(),
  { values: {}, busy: false, error: '', zipFile: null },
);
// a deploy that was streaming when the page was refreshed keeps running on the server
if (wiz.run?.state === 'running') wiz.run.detached = true;
const saveWiz = () => {
  const { values, busy, error, zipFile, ...keep } = wiz;
  sessionStorage.setItem('hamyar_wizard', JSON.stringify(keep));
};

const wizEl = () => $('#wizard');

function stepperView() {
  const items = WIZ_STEPS.map((label, i) => {
    const n = i + 1;
    const cls = n < wiz.step ? 'done' : '';
    return `<li class="${cls}"${n === wiz.step ? ' aria-current="step"' : ''}><i>${n < wiz.step ? icon('check') : fa(n)}</i>${label}</li>`;
  }).join('');
  return `<ol class="stepper" aria-label="مراحل دیپلوی">${items}</ol>
    <div class="step-mobile"><div class="row"><b>مرحله‌ی ${fa(wiz.step)} از ۴ · ${WIZ_STEPS[wiz.step - 1]}</b><span class="muted">${wiz.step < 4 ? `بعدی: ${WIZ_STEPS[wiz.step]}` : ''}</span></div><div class="bar"><i data-pct="${wiz.step / 4}"></i></div></div>`;
}

const errorView = () => (wiz.error ? `<p class="form-error" role="alert">${icon('alert')}<span>${esc(wiz.error)}</span></p>` : '');
const busyLabel = (text) => `<span class="spin" aria-hidden="true"></span>${esc(text)}`;

function go(step) {
  wiz.step = step;
  wiz.error = '';
  saveWiz();
  renderWizard();
  window.scrollTo(0, 0);
}

async function post(path, body) {
  const res = await api(path, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `خطای ${res.status}`);
  return data;
}

// ---------- step 1: where the code comes from ----------

function sourceForm() {
  if (wiz.origin === 'zip') {
    const f = wiz.zipFile;
    return `
      <label class="dropzone" id="dropzone">
        ${icon('upload')}
        <b>${f ? esc(f.name) : 'فایل ZIP را اینجا بکشید یا کلیک کنید'}</b>
        <span class="muted">${f ? `${fa(Math.round(f.size / 1024))} کیلوبایت` : 'حداکثر ۵۰ مگابایت · پوشه‌های node_modules و .git لازم نیست'}</span>
        <input type="file" id="zip-input" accept=".zip,application/zip">
      </label>
      <div class="field"><label for="zip-subdir">زیرپوشه (اختیاری)</label><input id="zip-subdir" class="ltr" placeholder="apps/web" value="${esc(wiz.zipSubdir)}"><small>فقط اگر پروژه داخل یک زیرپوشه است.</small></div>`;
  }
  if (wiz.origin === 'local') {
    return `<div class="field"><label for="local-path">مسیر پوشه‌ی پروژه</label><input id="local-path" class="ltr" placeholder="C:\\projects\\my-app" value="${esc(wiz.localPath)}" required><small>مسیر کامل پوشه روی کامپیوتری که همیار روی آن اجرا شده.</small></div>`;
  }
  const g = wiz.github;
  return `
    <div class="field"><label for="gh-url">آدرس ریپازیتوری GitHub</label><input id="gh-url" class="ltr" placeholder="https://github.com/you/my-app" value="${esc(g.url)}" required autocomplete="off"></div>
    <div class="grid2">
      <div class="field"><label for="gh-branch">شاخه (اختیاری)</label><input id="gh-branch" class="ltr" placeholder="main" value="${esc(g.branch)}"><small>خالی = شاخه‌ی پیش‌فرض ریپازیتوری</small></div>
      <div class="field"><label for="gh-subdir">زیرپوشه (اختیاری)</label><input id="gh-subdir" class="ltr" placeholder="apps/web" value="${esc(g.subdir)}"></div>
    </div>
    <p class="note-sm">همیار کد را خودش از GitHub دانلود می‌کند و از راه رسمی آپلود لیارا می‌فرستد. ریپازیتوری خصوصی در این نسخه پشتیبانی نمی‌شود؛ برای آن ZIP را آپلود کنید.</p>`;
}

function stepSource() {
  const origins = Object.entries(ORIGINS)
    .filter(([key]) => key !== 'local' || state.config?.local)
    .map(([key, o]) => `<button type="button" class="source" role="radio" aria-checked="${wiz.origin === key}" data-origin="${key}"><span class="sicon">${icon(o.icon)}</span><b>${o.title}</b><span>${o.hint}</span></button>`)
    .join('');
  return `
    <div class="h-title"><h1>کدتان کجاست؟</h1><p>یکی را انتخاب کنید؛ بقیه را همیار پیدا می‌کند.</p></div>
    <div class="sources" role="radiogroup" aria-label="منبع کد">${origins}</div>
    <form class="card form" id="source-form" novalidate>
      ${sourceForm()}
      ${errorView()}
      <div class="wizard-actions"><button class="btn primary end" type="submit" ${wiz.busy ? 'disabled' : ''}>${wiz.busy ? busyLabel(wiz.busy) : `بررسی پروژه ${icon('send')}`}</button></div>
    </form>`;
}

function bindSource() {
  wizEl().querySelectorAll('.source').forEach((b) =>
    b.addEventListener('click', () => {
      wiz.origin = b.dataset.origin;
      wiz.error = '';
      saveWiz();
      renderWizard();
    }),
  );
  const zipInput = $('#zip-input');
  if (zipInput) {
    const take = (file) => {
      if (!file) return;
      if (!/\.zip$/i.test(file.name)) {
        wiz.error = 'فقط فایل با پسوند .zip پذیرفته می‌شود.';
      } else if (file.size > 50 * 1024 * 1024) {
        wiz.error = 'حجم فایل بیشتر از ۵۰ مگابایت است. پوشه‌های node_modules و .git را از ZIP حذف کنید.';
      } else {
        wiz.zipFile = file;
        wiz.error = '';
      }
      renderWizard();
    };
    zipInput.addEventListener('change', () => take(zipInput.files[0]));
    const zone = $('#dropzone');
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      take(e.dataTransfer.files[0]);
    });
  }
  $('#source-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (wiz.origin === 'github') wiz.github = { url: $('#gh-url').value.trim(), branch: $('#gh-branch').value.trim(), subdir: $('#gh-subdir').value.trim() };
    if (wiz.origin === 'local') wiz.localPath = $('#local-path').value.trim();
    if (wiz.origin === 'zip') wiz.zipSubdir = $('#zip-subdir').value.trim();
    fetchSource();
  });
}

async function fetchSource() {
  wiz.error = '';
  try {
    if (wiz.origin === 'github' && !wiz.github.url) throw new Error('آدرس ریپازیتوری را وارد کنید.');
    if (wiz.origin === 'local' && !wiz.localPath) throw new Error('مسیر پوشه را وارد کنید.');
    if (wiz.origin === 'zip' && !wiz.zipFile) throw new Error('اول فایل ZIP را انتخاب کنید.');
    wiz.busy = wiz.origin === 'github' ? 'در حال دانلود از GitHub…' : wiz.origin === 'zip' ? 'در حال آپلود و باز کردن ZIP…' : 'در حال خواندن پوشه…';
    renderWizard();
    let data;
    if (wiz.origin === 'zip') {
      const res = await fetch(`/api/source/zip?name=${encodeURIComponent(wiz.zipFile.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: wiz.zipFile });
      data = await res.json().catch(() => ({}));
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error(data.error || `خطای ${res.status}`);
    } else if (wiz.origin === 'github') {
      data = await post('/api/source/github', { url: wiz.github.url, branch: wiz.github.branch });
    } else {
      data = await post('/api/source/local', { path: wiz.localPath });
    }
    wiz.source = data.source;
    wiz.subdir = wiz.origin === 'github' ? wiz.github.subdir : wiz.origin === 'zip' ? wiz.zipSubdir : '';
    wiz.busy = 'در حال بررسی پروژه…';
    renderWizard();
    wiz.analysis = await post('/api/wizard/analyze', { sourceId: wiz.source.id, subdir: wiz.subdir, blocked: wiz.blocked });
    const rec = wiz.analysis.plans.find((p) => p.role === 'recommended');
    wiz.planID = (rec?.affordable ? rec : wiz.analysis.plans.find((p) => p.affordable) || rec)?.id || '';
    wiz.app = wiz.analysis.app;
    wiz.busy = false;
    go(2);
  } catch (err) {
    wiz.busy = false;
    if (err.message !== 'login required') wiz.error = err.message;
    renderWizard();
  }
}

// ---------- step 2: what Hamyar found and which plan ----------

// the plan and feature plan the user picked (defaults: Hamyar's recommendation, cheapest bundle with rollback)
const chosenPlan = () => (wiz.analysis?.catalog || []).find((p) => p.id === wiz.planID) || wiz.analysis?.plans.find((p) => p.id === wiz.planID);
const chosenBundle = (p) => (p?.bundles?.length ? p.bundles.find((b) => b.id === wiz.bundleID) || p.bundle : undefined);
const totals = (p, b) => ({ monthly: p.monthly + (b?.monthly ?? 0), hourly: p.hourly + (b?.hourly ?? 0) });
const canAfford = (p, b) => wiz.analysis.balance >= totals(p, b).hourly * 24;
const ramLabel = (gb) => (gb < 1 ? `${fa(gb * 1024)} مگابایت` : `${fa(gb)} گیگابایت`);

function bundlePicker(p) {
  if (!p?.bundles?.length) return p ? '<p class="note-sm">این پلن از نسل قدیمی لیاراست و پلن امکانات جداگانه ندارد؛ قیمتش همان قیمت کامل است.</p>' : '';
  const current = chosenBundle(p);
  return `<div class="bundles" role="radiogroup" aria-label="پلن امکانات">${p.bundles
    .map((b) => `<button type="button" class="bundle" role="radio" aria-checked="${b.id === current?.id}" data-bundle="${esc(b.id)}">
      <b>${esc(b.id)}</b><span class="price">+${fa(b.monthly)} <small>تومان در ماه</small></span>
      <small>${b.rollback ? 'برگشت به نسخه‌ی قبلی دارد' : 'برگشت به نسخه‌ی قبلی ندارد'} · ${b.zeroDowntime ? 'دیپلوی بدون قطعی دارد' : 'دیپلوی بدون قطعی ندارد'} · لاگ ${fa(b.logsDays)} روز</small>
    </button>`)
    .join('')}</div>`;
}

function catalogList(a) {
  return `<details class="details card" ${wiz.showAll ? 'open' : ''} id="all-plans"><summary>همه‌ی پلن‌هایی که حساب شما می‌تواند بخرد (${fa(a.catalog.length)})</summary>
    <div class="plan-rows" role="radiogroup" aria-label="همه‌ی پلن‌ها">${a.catalog
      .map((p) => `<button type="button" class="plan-row" role="radio" aria-checked="${p.id === wiz.planID}" data-plan="${esc(p.id)}">
        <b>${esc(p.id)}</b>
        <span>${ramLabel(p.ramGB)} رم · ${fa(p.cpu)} هسته</span>
        <span class="price">${fa(p.totalMonthly)} <small>تومان در ماه${p.bundle ? ' با امکانات' : ''}</small></span>
        <span class="tags">${p.generation === 'g2' ? '<span class="chip-i">نسل جدید g2</span>' : '<span class="chip-i warn">نسل قدیمی</span>'}${p.fits ? '' : '<span class="chip-i bad">رم کمتر از نیاز</span>'}${p.affordable ? '' : '<span class="chip-i bad">موجودی کافی نیست</span>'}</span>
      </button>`)
      .join('')}</div></details>`;
}

function planCard(p) {
  const checked = p.id === wiz.planID;
  return `<button type="button" class="plan ${p.role}" role="radio" aria-checked="${checked}" ${p.affordable ? '' : 'aria-disabled="true"'} data-plan="${esc(p.id)}">
    <div class="plan-head"><b>${esc(p.id)}</b>${p.role === 'recommended' ? `<span class="rec">${ROLE_LABEL.recommended}</span>` : `<span class="note-sm">${ROLE_LABEL[p.role]}</span>`}</div>
    <ul><li>${icon('cpu')}${fa(p.cpu)} هسته پردازنده</li><li>${icon('ram')}${p.ramGB < 1 ? `${fa(p.ramGB * 1024)} مگابایت` : `${fa(p.ramGB)} گیگابایت`} حافظه</li></ul>
    <span class="price">${fa(p.totalMonthly ?? p.monthly)} <small>تومان در ماه</small></span>
    ${p.bundle ? `<span class="why">سرور ${fa(p.monthly)} + امکانات «${esc(p.bundle.id)}» ${fa(p.bundle.monthly)}${p.bundle.rollback ? ' · برگشت به نسخه‌ی قبلی' : ''} · لاگ ${fa(p.bundle.logsDays)} روز</span>` : ''}
    ${p.affordable ? '' : '<span class="why bad">موجودی برای یک روز این پلن کافی نیست</span>'}
  </button>`;
}

function stepPlan() {
  const a = wiz.analysis;
  const d = a.detection;
  const chips = [
    `<span class="chip-i">${esc(d.platform)}${d.version ? ` ${esc(d.version)}` : ''}</span>`,
    `<span class="chip-i">پورت ${Number(d.port).toLocaleString('fa-IR', { useGrouping: false })}</span>`,
    d.startCommand ? `<span class="chip-i"><bdi>${esc(d.startCommand)}</bdi></span>` : '',
    a.healthPath ? `<span class="chip-i ok">مسیر سلامت <bdi>${esc(a.healthPath)}</bdi></span>` : `<span class="chip-i warn">مسیر سلامت ندارد؛ صفحه‌ی اصلی بررسی می‌شود</span>`,
    a.env.required.length ? `<span class="chip-i warn">${icon('key')}${fa(a.env.required.length)} متغیر محیطی لازم است</span>` : '<span class="chip-i ok">متغیر محیطی لازم ندارد</span>',
  ].join('');
  const warnings = [...(d.conflict ? [d.conflict] : []), ...d.warnings].map((w) => `<p class="form-warn">${icon('alert')}<span>${esc(w)}</span></p>`).join('');
  const none = !(a.catalog || a.plans).some((p) => p.affordable);
  const selected = chosenPlan();
  const bundle = chosenBundle(selected);
  const sum = selected ? totals(selected, bundle) : undefined;
  return `
    <div class="h-title"><h1>تحلیل پروژه کامل شد</h1><p>${esc(wiz.source.label)}${wiz.subdir ? ` / ${esc(wiz.subdir)}` : ''} · ${fa(a.fileCount)} فایل</p></div>
    <section class="card">
      <div class="analysis-head"><b>چه چیزی پیدا شد</b><button class="btn ghost small" type="button" data-go="1">تغییر منبع</button></div>
      <div class="chips">${chips}</div>
      ${warnings ? `<div class="stack mt">${warnings}</div>` : ''}
      <details class="details"><summary>جزئیات فنی</summary><ul>${d.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul><pre>${esc(JSON.stringify(a.liaraJson, null, 2))}</pre></details>
    </section>
    <h2 class="h-title plans-title">پلن پیشنهادی همیار</h2>
    ${wiz.blocked.length ? `<p class="form-warn">${icon('alert')}<span>لیارا این پلن‌ها را برای حساب شما نساخت و از فهرست کنار گذاشته شدند: ${esc(wiz.blocked.join('، '))}</span></p>` : ''}
    <div class="plans" role="radiogroup" aria-label="پلن">${a.plans.map(planCard).join('')}</div>
    ${a.catalog ? catalogList(a) : ''}
    ${selected ? `<section class="card"><h2>پلن امکانات برای <bdi>${esc(selected.id)}</bdi></h2>${bundlePicker(selected)}
      <p class="choice">انتخاب شما: <bdi>${esc(selected.id)}</bdi>${bundle ? ` + امکانات «${esc(bundle.id)}»` : ''} = <b>${fa(sum.monthly)} تومان در ماه</b> (ساعتی حدود ${fa(Math.round(sum.hourly))} تومان)${selected.fits ? '' : ' · ⚠️ رم این پلن از نیاز پروژه کمتر است'}</p></section>` : ''}
    <details class="details card"><summary>چرا این پلن؟</summary><ul>${a.planReasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>
    <p class="note-sm center">قیمت‌ها از فهرست زنده‌ی پلن‌های لیارا · موجودی حساب: ${fa(Math.round(a.balance))} تومان</p>
    ${none ? `<p class="form-warn">${icon('wallet')}<span>موجودی حساب برای هیچ‌کدام از این پلن‌ها کافی نیست. همیار نمی‌تواند حساب را شارژ کند؛ از کنسول لیارا شارژ کنید و بعد «بررسی دوباره‌ی موجودی» را بزنید.</span></p>` : ''}
    ${errorView()}
    <div class="wizard-actions">
      <button class="btn" type="button" data-go="1">قبلی</button>
      ${none ? `<a class="btn" href="https://console.liara.ir" target="_blank" rel="noopener">${icon('link')}کنسول لیارا</a><button class="btn" type="button" id="recheck">${wiz.busy ? busyLabel('در حال بررسی…') : 'بررسی دوباره‌ی موجودی'}</button>` : ''}
      <button class="btn primary end" type="button" id="plan-next" ${selected && canAfford(selected, bundle) ? '' : 'disabled'}>ادامه</button>
    </div>`;
}

function bindPlan() {
  wizEl().querySelectorAll('.plan, .plan-row').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      wiz.planID = b.dataset.plan;
      wiz.bundleID = '';
      wiz.showAll = Boolean(b.closest('#all-plans'));
      saveWiz();
      renderWizard();
    }),
  );
  wizEl().querySelectorAll('.bundle').forEach((b) =>
    b.addEventListener('click', () => {
      wiz.bundleID = b.dataset.bundle;
      saveWiz();
      renderWizard();
    }),
  );
  $('#all-plans')?.addEventListener('toggle', (e) => (wiz.showAll = e.target.open));
  $('#plan-next').addEventListener('click', () => go(3));
  $('#recheck')?.addEventListener('click', async () => {
    wiz.busy = true;
    renderWizard();
    try {
      wiz.analysis = await post('/api/wizard/analyze', { sourceId: wiz.source.id, subdir: wiz.subdir, blocked: wiz.blocked });
      wiz.planID = (wiz.analysis.plans.find((p) => p.role === 'recommended' && p.affordable) || wiz.analysis.plans.find((p) => p.affordable) || {}).id || wiz.planID;
    } catch (err) {
      wiz.error = err.message;
    }
    wiz.busy = false;
    saveWiz();
    renderWizard();
  });
}

// ---------- step 3: name and env values ----------

function nameProblem(name) {
  if (name.length < 3) return 'دست‌کم ۳ حرف';
  if (name.length > 32) return 'حداکثر ۳۲ حرف';
  if (!APP_NAME.test(name)) return 'فقط حروف کوچک انگلیسی، عدد و خط تیره؛ با حرف شروع شود';
  if (wiz.analysis.existingApps.includes(name)) return 'برنامه‌ای با این نام را از قبل دارید';
  return '';
}

function stepSettings() {
  const a = wiz.analysis;
  const problem = nameProblem(wiz.app);
  const envFields = a.env.required
    .map((e) => `<div class="field"><label for="env-${esc(e.name)}"><bdi>${esc(e.name)}</bdi></label><input type="password" id="env-${esc(e.name)}" data-env="${esc(e.name)}" class="ltr" autocomplete="off" value="${esc(wiz.values[e.name] || '')}"><small>در <bdi>${esc(e.location)}</bdi> خوانده می‌شود${e.documented ? ' · در .env.example هم آمده' : ''}</small></div>`)
    .join('');
  const optional = a.env.optional.length
    ? `<details class="details"><summary>${fa(a.env.optional.length)} متغیر اختیاری (مقدار پیش‌فرض دارند)</summary><ul>${a.env.optional.map((e) => `<li><bdi>${esc(e.name)}</bdi> — <bdi>${esc(e.location)}</bdi></li>`).join('')}</ul></details>`
    : '';
  return `
    <div class="h-title"><h1>تنظیمات دیپلوی</h1><p>فقط چیزهایی که کد شما لازم دارد.</p></div>
    <form class="card form" id="settings-form" novalidate>
      <div class="field">
        <label for="app-name">نام برنامه روی لیارا</label>
        <input id="app-name" class="ltr" value="${esc(wiz.app)}" autocomplete="off" spellcheck="false" aria-describedby="app-name-hint">
        <small id="app-name-hint" class="${problem ? 'bad' : ''}">${problem ? esc(problem) : `آدرس: <bdi>${esc(wiz.app)}.liara.run</bdi>`}</small>
      </div>
      ${
        a.env.required.length
          ? `<p class="note-sm">${icon('lock')} مقدارها فقط به لیارا فرستاده می‌شوند؛ هوش مصنوعی، فایل‌های همیار و گزارش‌ها آن‌ها را نمی‌بینند.</p>${envFields}`
          : '<p class="note-sm">کد شما متغیر محیطی لازمی نمی‌خواند.</p>'
      }
      ${optional}
      ${errorView()}
      <div class="wizard-actions">
        <button class="btn" type="button" data-go="2">قبلی</button>
        <button class="btn primary end" type="submit" ${wiz.busy ? 'disabled' : ''}>${wiz.busy ? busyLabel('در حال آماده‌سازی…') : 'بازبینی و تأیید'}</button>
      </div>
    </form>`;
}

function bindSettings() {
  const name = $('#app-name');
  name.addEventListener('input', () => {
    wiz.app = name.value.trim().toLowerCase();
    const problem = nameProblem(wiz.app);
    const hint = $('#app-name-hint');
    hint.className = problem ? 'bad' : '';
    hint.innerHTML = problem ? esc(problem) : `آدرس: <bdi>${esc(wiz.app)}.liara.run</bdi>`;
    saveWiz();
  });
  wizEl().querySelectorAll('[data-env]').forEach((i) => i.addEventListener('input', () => (wiz.values[i.dataset.env] = i.value)));
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const problem = nameProblem(wiz.app);
    if (problem) return name.focus();
    const empty = [...wizEl().querySelectorAll('[data-env]')].find((i) => !i.value.trim());
    if (empty) {
      wiz.error = `مقدار ${empty.dataset.env} را وارد کنید. بدون آن، سایت احتمالاً بعد از دیپلوی خطا می‌دهد.`;
      renderWizard();
      return $(`[data-env="${empty.dataset.env}"]`).focus();
    }
    wiz.busy = true;
    wiz.error = '';
    renderWizard();
    try {
      wiz.request = await post('/api/wizard/request', { sourceId: wiz.source.id, subdir: wiz.subdir, app: wiz.app, planID: wiz.planID, bundlePlanID: chosenBundle(chosenPlan())?.id, keys: wiz.analysis.env.required.map((x) => x.name) });
      wiz.busy = false;
      go(4);
    } catch (err) {
      wiz.busy = false;
      if (err.message !== 'login required') wiz.error = err.message;
      renderWizard();
    }
  });
}

// ---------- step 4: approval, progress, result ----------

function approvalView() {
  const p = wiz.request.preview;
  const fact = (ic, label, value) => (value ? `<div class="fact">${icon(ic)}<div><span>${label}</span><b>${esc(value)}</b></div></div>` : '');
  return `
    <section class="approval t2" aria-label="درخواست تأیید">
      <div class="approval-head">${icon('shield')}<h3>${esc(p.title)}</h3><span class="badge">تغییر مهم · #${esc(wiz.request.id)}</span></div>
      <div class="approval-body">
        <ul>${p.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <div class="facts">${fact('coin', 'هزینه', p.cost)}${fact('alert', 'ریسک', p.risk)}${fact('clock', 'قطعی سایت', 'ندارد (برنامه‌ی جدید)')}${fact('undo', 'راه برگشت', p.undo)}</div>
        ${errorView()}
        <div class="actions" id="approve-actions">
          <button class="btn primary" type="button" id="wiz-approve">${icon('check')}تأیید و اجرا</button>
          <button class="btn" type="button" id="wiz-edit">${icon('edit')}ویرایش</button>
          <button class="btn danger" type="button" id="wiz-reject">${icon('x')}رد کردن</button>
        </div>
        <div class="actions" id="reject-row" hidden>
          <input class="grow" id="reject-reason" placeholder="چرا؟ (اختیاری)" aria-label="دلیل رد">
          <button class="btn danger" type="button" id="wiz-reject-confirm">ثبت رد</button>
        </div>
        <p class="note-sm">این کار فقط با تأیید شما اجرا می‌شود و در تاریخچه‌ی تأییدها ثبت می‌شود.</p>
      </div>
    </section>`;
}

function progressView() {
  const r = wiz.run;
  const at = DEPLOY_PHASES.findIndex(([ph]) => ph === r.phase);
  const failed = r.state === 'failed';
  const rows = DEPLOY_PHASES.map(([ph, label], i) => {
    const cls = failed && i === Math.max(at, 0) ? 'fail' : i < at || r.state === 'verified' ? 'done' : i === at ? 'run' : '';
    const mark = cls === 'done' ? icon('check') : cls === 'fail' ? icon('x') : cls === 'run' ? '<span class="spin2"></span>' : fa(i + 1);
    const msg = i === at && r.message ? `<small><bdi>${esc(r.message)}</bdi></small>` : '';
    const next = DEPLOY_PHASES.slice(i + 1).map(([p]) => r.times[p]).find(Boolean);
    const t = r.times[ph] ? `<span class="t">${since((next ?? r.ended ?? Date.now()) - r.times[ph])}</span>` : '<span></span>';
    return `<li class="${cls}"><span class="st">${mark}</span><span><b>${label}</b>${msg}</span>${t}</li>`;
  }).join('');
  return `
    <div class="h-title"><h1>${failed ? 'دیپلوی کامل نشد' : `در حال دیپلوی ${esc(wiz.app)}…`}</h1><p>${failed ? '' : 'می‌توانید صفحه را ببندید؛ همیار کار را روی لیارا دنبال می‌کند.'}</p></div>
    <section class="card"><ol class="tl">${rows}</ol></section>
    ${r.detached && !failed ? `<p class="form-warn">${icon('alert')}<span>صفحه تازه‌سازی شد و اتصال به این دیپلوی قطع شد. دیپلوی روی سرور ادامه دارد؛ نتیجه را در «آخرین عملیات» صفحه‌ی اصلی ببینید.</span></p><div class="wizard-actions"><button class="btn" type="button" id="wiz-new">دیپلوی پروژه‌ی دیگر</button><button class="btn primary end" type="button" id="wiz-home">رفتن به داشبورد</button></div>` : ''}
    ${failed ? `<p class="form-error" role="alert">${icon('alert')}<span>${esc(r.error)}</span></p>
      <div class="wizard-actions"><button class="btn" type="button" id="wiz-home">بازگشت به داشبورد</button>${r.phase === 'PREPARING' ? `<button class="btn" type="button" id="wiz-other-plan">${icon('server')}انتخاب پلن دیگر</button>` : ''}<button class="btn primary end" type="button" id="wiz-diagnose">${icon('bug')}بررسی علت</button></div>` : ''}`;
}

function resultView() {
  const r = wiz.run.result;
  const v = r.verification || {};
  const url = r.url || `https://${wiz.app}.liara.run`;
  return `
    <div class="result-hero">
      ${mascot('')}
      <h1>سایت شما آنلاین و سالم است</h1>
      <p>${v.rounds ? `${fa(v.rounds)} دور بررسی موفق · ` : ''}${v.p95 !== undefined ? `زمان پاسخ (p95) ${fa(v.p95)} میلی‌ثانیه · ` : ''}نسخه‌ی جدید فعال است</p>
      <div class="url-box"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a><button class="btn" type="button" id="copy-url" aria-label="کپی آدرس">${icon('copy')}</button></div>
    </div>
    <div class="next-actions">
      <button type="button" id="next-domain">${icon('globe')}<b>اتصال دامنه</b><small>دامنه‌ی خودتان را وصل کنید</small></button>
      <button type="button" id="next-watch">${icon('pulse')}<b>روشن کردن پایش</b><small>هر ۳۰ ثانیه سلامت سایت را چک کن</small></button>
      <button type="button" id="next-status">${icon('server')}<b>وضعیت سرویس</b><small>حافظه، پردازنده و نسخه</small></button>
    </div>
    <div class="wizard-actions"><button class="btn" type="button" id="wiz-new">دیپلوی پروژه‌ی دیگر</button><button class="btn primary end" type="button" id="wiz-home">رفتن به داشبورد</button></div>`;
}

function stepDeploy() {
  if (!wiz.request) return '<p class="empty">درخواستی نیست؛ از مرحله‌ی قبل دوباره شروع کنید.</p>';
  if (wiz.run?.state === 'verified') return resultView();
  if (wiz.run) return progressView();
  return `<div class="h-title"><h1>آماده‌ی دیپلوی</h1><p>یک بار بخوانید و تأیید کنید.</p></div>${approvalView()}`;
}

async function selectApp(app) {
  const { apps } = await (await api('/api/apps')).json();
  $('#app-select').innerHTML = apps.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}${a.scale === 0 ? ' (خاموش)' : ''}</option>`).join('');
  $('#app-select').value = app;
  state.app = app;
  loadStatus();
}

function resetWizard() {
  sessionStorage.removeItem('hamyar_wizard');
  Object.assign(wiz, { step: 1, run: null, source: null, subdir: '', analysis: null, planID: '', bundleID: '', blocked: [], app: '', request: null, values: {}, run: null, error: '', busy: false, zipFile: null });
}

function bindDeploy() {
  $('#wiz-approve')?.addEventListener('click', startWizardDeploy);
  $('#wiz-edit')?.addEventListener('click', async () => {
    await post('/api/wizard/cancel', { id: wiz.request.id, reason: 'کاربر برگشت و تنظیمات را ویرایش کرد' }).catch(() => {});
    wiz.request = null;
    loadInbox();
    go(3);
  });
  $('#wiz-reject')?.addEventListener('click', () => {
    $('#approve-actions').hidden = true;
    $('#reject-row').hidden = false;
    $('#reject-reason').focus();
  });
  $('#wiz-reject-confirm')?.addEventListener('click', async () => {
    const reason = $('#reject-reason').value.trim();
    await api('/api/approve', { method: 'POST', body: { id: wiz.request.id, approved: false, reason } }).catch(() => {});
    toast(`دیپلوی رد شد${reason ? `: ${reason}` : ''}. هیچ تغییری روی لیارا انجام نشد.`);
    resetWizard();
    loadInbox();
    loadTimeline();
    location.hash = '#/';
  });
  $('#wiz-home')?.addEventListener('click', () => (location.hash = '#/'));
  $('#wiz-new')?.addEventListener('click', () => {
    resetWizard();
    renderWizard();
  });
  // creation failed (nothing was built): back to the plans; Liara's g2 refusal removes that family
  $('#wiz-other-plan')?.addEventListener('click', async () => {
    if (/g2/.test(wiz.run?.error || '') && !wiz.blocked.includes('g2')) wiz.blocked.push('g2');
    wiz.run = null;
    wiz.request = null;
    wiz.bundleID = '';
    wiz.busy = 'در حال خواندن دوباره‌ی پلن‌ها…';
    try {
      wiz.analysis = await post('/api/wizard/analyze', { sourceId: wiz.source.id, subdir: wiz.subdir, blocked: wiz.blocked });
      wiz.planID = (wiz.analysis.plans.find((p) => p.role === 'recommended') || wiz.analysis.catalog[0] || {}).id || '';
      wiz.busy = false;
      go(2);
    } catch (err) {
      wiz.busy = false;
      wiz.error = err.message;
      go(2);
    }
  });
  $('#wiz-diagnose')?.addEventListener('click', () => {
    const app = wiz.app;
    location.hash = '#/';
    selectApp(app).catch(() => {});
    const prompt = `دیپلوی ${app} کامل نشد، علتش را پیدا کن.`;
    state.ai ? send(prompt) : quick(prompt, 'diagnose');
  });
  $('#copy-url')?.addEventListener('click', () => navigator.clipboard.writeText(wiz.run.result.url || `https://${wiz.app}.liara.run`).then(() => toast('آدرس کپی شد.')));
  $('#next-domain')?.addEventListener('click', () => (location.hash = `#/domains/${encodeURIComponent(wiz.app)}`));
  $('#next-watch')?.addEventListener('click', async () => {
    await selectApp(wiz.app).catch(() => {});
    $('#watch-toggle').checked = true;
    setWatch(true);
    toast(`پایش ${wiz.app} روشن شد.`);
  });
  $('#next-status')?.addEventListener('click', async () => {
    await selectApp(wiz.app).catch(() => {});
    openStatus();
  });
}

async function startWizardDeploy() {
  wiz.run = { phase: 'PREPARING', message: '', state: 'running', times: { PREPARING: Date.now() }, result: null, error: '' };
  saveWiz();
  renderWizard();
  // keep the per-step timers moving between server events
  const tick = setInterval(() => (wiz.run?.state === 'running' && wiz.step === 4 && !$('[data-page="deploy"]').hidden ? renderWizard() : null), 1000);
  const values = wiz.values;
  wiz.values = {};
  try {
    const res = await api('/api/wizard/start', { method: 'POST', body: { id: wiz.request.id, values } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onDeployEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    if (err.message !== 'login required') onDeployEvent({ type: 'error', text: `ارتباط قطع شد: ${err.message}. وضعیت دیپلوی در «آخرین عملیات» دنبال می‌شود.` });
  }
  clearInterval(tick);
  loadTimeline();
  loadInbox();
}

function onDeployEvent(e) {
  const r = wiz.run;
  if (e.type === 'progress') {
    if (DEPLOY_PHASES.some(([ph]) => ph === e.phase)) {
      if (e.phase !== r.phase) r.times[e.phase] = Date.now();
      r.phase = e.phase;
    }
    r.message = e.message || '';
    if (['FAILED', 'HEALTH_FAILED', 'CANCELED'].includes(e.phase)) r.lastFailure = e.message;
  } else if (e.type === 'done') {
    r.ended = Date.now();
    r.result = e.result;
    if (e.result?.state === 'VERIFIED_HEALTHY') {
      r.state = 'verified';
      selectApp(wiz.app).catch(() => {});
    } else {
      r.state = 'failed';
      const why = e.result?.verification?.reason || r.lastFailure;
      r.error = `${PHASE_LABELS[e.result?.state] || e.result?.state}${why ? `: ${why}` : ''}. برنامه‌ی ${wiz.app} روی لیارا ساخته شده و هزینه‌ی ساعتی دارد.`;
    }
  } else if (e.type === 'error') {
    r.ended = Date.now();
    r.state = 'failed';
    r.error = e.text;
  }
  saveWiz();
  renderWizard();
}

// ---------- render ----------

function renderWizard() {
  const el = wizEl();
  if (!el) return;
  // a refresh loses the analysis only if it was never saved; send the user back to the start
  if (wiz.step > 1 && !wiz.analysis) wiz.step = 1;
  if (wiz.step === 4 && !wiz.request) wiz.step = 3;
  // env values are never saved; after a refresh they must be typed again, so the old request goes
  if (wiz.step === 4 && !wiz.run && wiz.request.keys.some((k) => !wiz.values[k])) {
    post('/api/wizard/cancel', { id: wiz.request.id, reason: 'صفحه تازه‌سازی شد و مقدار متغیرها باید دوباره وارد شود' }).catch(() => {});
    wiz.request = null;
    wiz.step = 3;
    wiz.error = 'برای امنیت، مقدار متغیرها جایی ذخیره نمی‌شود؛ بعد از تازه‌سازی صفحه دوباره واردشان کنید.';
    saveWiz();
  }
  const body = [stepSource, stepPlan, stepSettings, stepDeploy][wiz.step - 1]();
  el.innerHTML = stepperView() + body;
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.go))));
  [bindSource, bindPlan, bindSettings, bindDeploy][wiz.step - 1]();
}

window.renderWizard = renderWizard;
if (!$('[data-page="deploy"]').hidden) renderWizard();
