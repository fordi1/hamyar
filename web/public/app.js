// Hamyar dashboard client. Each agent turn renders as a live run card (pipeline of
// tool steps); diagnose expands into a hypothesis board; changes stop at approval cards.
'use strict';

const $ = (sel) => document.querySelector(sel);
const fa = (n) => Number(n).toLocaleString('fa-IR');
const pct = (r) => `${fa(Math.round(r * 100))}٪`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const TOOL_LABELS = {
  liara_overview: 'مرور حساب لیارا', analyze_project: 'تحلیل پروژه', app_status: 'وضعیت برنامه', get_logs: 'خواندن لاگ‌ها',
  diagnose: 'پیدا کردن علت مشکل', verify: 'بررسی نتیجه', check_domain: 'بررسی دامنه', incident_report: 'گزارش حادثه',
  audit_log: 'تاریخچه‌ی عملیات', launch_app: 'ساخت برنامه و دیپلوی', deploy: 'انتشار نسخه‌ی جدید', set_env: 'تنظیم متغیرها',
  restart_app: 'ری‌استارت', turn_on_app: 'روشن کردن برنامه', turn_off_app: 'خاموش کردن برنامه', resize_plan: 'تغییر پلن',
  rollback: 'برگشت به نسخه‌ی قبلی', add_domain: 'اتصال دامنه', enable_ssl: 'فعال‌سازی SSL',
  use_liara_dns: 'راه‌اندازی DNS لیارا', create_dns_records: 'ساخت رکوردهای DNS',
};
const PHASES = ['packing', 'uploading', 'queued', 'building', 'deploying', 'ready', 'probing', 'done'];
const PHASE_LABELS = {
  packing: 'بسته‌بندی کد', uploading: 'آپلود', queued: 'در صف ساخت', building: 'ساخت (build)', deploying: 'استقرار',
  ready: 'آماده', failed: 'ناموفق', probing: 'تست سایت', done: 'تمام',
};
const OUTCOMES = { executed: 'انجام شد', failed: 'ناموفق', rejected: 'رد شد', blocked: 'مسدود شد' };
const MODES = {
  observe: ['فقط مشاهده', 'هیچ تغییری اجرا نمی‌شود'],
  review: ['بازبینی', 'هر تغییر قبل از اجرا تأیید شما را می‌خواهد'],
  'auto-safe': ['خودکار محدود', 'کارهای کم‌خطر خودکار، تغییرات مهم با تأیید'],
};

const state = {
  app: '',
  ai: false,
  conversation: sessionStorage.getItem('hamyar_conv') || Math.random().toString(36).slice(2),
  busy: false,
  run: null,
  watchTimer: null,
  alerted: false,
};
sessionStorage.setItem('hamyar_conv', state.conversation);

// ---------- api ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('login required');
  }
  return res;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function since(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return 'کمتر از ۱ ثانیه';
  return s < 60 ? `${fa(s)} ثانیه` : `${fa(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0').replace(/\d/g, (d) => fa(d))}`;
}

// ---------- markdown-lite ----------

function renderText(text) {
  const lines = esc(text).split('\n');
  const out = [];
  let table = [];
  const flush = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\|\s*-/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    out.push('<table>' + rows.map((r, i) => '<tr>' + r.map((c) => (i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('') + '</tr>').join('') + '</table>');
    table = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      table.push(line.trim());
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out
    .join('<br>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/<br>(<table>)/g, '$1')
    .replace(/(<\/table>)<br>/g, '$1');
}

// ---------- thread ----------

const thread = $('#messages');
const scroll = () => requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));

function hideWelcome() {
  const w = $('#welcome');
  if (w) w.remove();
  $('#panel-chat').classList.remove('is-empty');
}

function addMessage(role, html) {
  hideWelcome();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = role === 'assistant' ? `<span class="mark" aria-hidden="true"><svg><use href="#i-check"/></svg></span><div class="body">${html}</div>` : html;
  thread.appendChild(el);
  scroll();
  return el;
}

// ---------- run card (signature) ----------

function ensureRun() {
  if (state.run && state.run.el === thread.lastElementChild) return state.run;
  // something (an approval card, a message) came after the open run: close it, start a new one
  if (state.run) finishRun();
  hideWelcome();
  const el = document.createElement('section');
  el.className = 'run';
  el.innerHTML = `<div class="run-head"><span class="spin" aria-hidden="true"></span><b class="run-title">همیار در حال کار</b><span class="elapsed"></span></div><div class="steps"></div>`;
  thread.appendChild(el);
  const run = { el, started: Date.now(), steps: [], timer: null };
  run.timer = setInterval(() => (el.querySelector('.elapsed').textContent = since(Date.now() - run.started)), 1000);
  state.run = run;
  scroll();
  return run;
}

function refreshRunTitle(run) {
  if (!run.el.classList.contains('finished')) return;
  const waiting = run.steps.some((s) => openSteps.includes(s));
  const failed = run.steps.some((s) => s.el.classList.contains('error'));
  run.el.querySelector('.run-title').textContent = waiting ? 'منتظر تأیید شما' : failed ? 'انجام شد، با خطا' : `${fa(run.steps.length)} مرحله انجام شد`;
}

function finishRun() {
  const run = state.run;
  if (!run) return;
  clearInterval(run.timer);
  if (!run.steps.length) run.el.remove();
  else {
    run.el.classList.add('finished');
    run.el.querySelector('.elapsed').textContent = since(Date.now() - run.started);
    refreshRunTitle(run);
  }
  state.run = null;
}

function argSummary(args = {}) {
  return [args.app, args.domain, args.planID, args.releaseID, args.keys?.join('، '), args.path].filter(Boolean).join(' · ');
}

function stepStart(name, args) {
  const run = ensureRun();
  const el = document.createElement('div');
  el.className = 'step running';
  el.innerHTML = `
    <button class="step-row" type="button" aria-expanded="false">
      <span class="state" aria-hidden="true">${fa(run.steps.length + 1)}</span>
      <span class="step-label"><b>${esc(TOOL_LABELS[name] || name)}</b><small>${esc(argSummary(args))}</small></span>
      <span class="step-time"></span>
    </button>
    <div class="step-detail"></div>`;
  run.el.querySelector('.steps').appendChild(el);
  const step = { name, el, run, started: Date.now() };
  run.steps.push(step);
  openSteps.push(step);
  el.querySelector('.step-row').onclick = () => {
    if (!el.classList.contains('has-detail')) return;
    const open = el.classList.toggle('open');
    el.querySelector('.step-row').setAttribute('aria-expanded', String(open));
  };
  scroll();
  return step;
}

// Steps can outlive their run card (a change waits for approval while a new card opens),
// so look them up across every unfinished step on the page.
const openSteps = [];

function findStep(name) {
  for (let i = openSteps.length - 1; i >= 0; i--) if (openSteps[i].name === name) return openSteps[i];
  return stepStart(name, {});
}

function stepWaiting(name) {
  const step = findStep(name);
  step.el.className = 'step waiting';
  step.el.querySelector('.state').innerHTML = icon('clock');
  step.el.querySelector('small').textContent = 'منتظر تأیید شما';
}

function stepRunning(name, text) {
  const step = findStep(name);
  step.el.className = 'step running';
  step.el.querySelector('.state').textContent = fa(step.run.steps.indexOf(step) + 1);
  step.el.querySelector('small').textContent = text;
}

function stepProgress(name, phase, message) {
  const step = findStep(name);
  step.el.className = 'step running';
  step.el.querySelector('.state').textContent = fa(step.run.steps.indexOf(step) + 1);
  step.el.querySelector('small').textContent = `${PHASE_LABELS[phase] || phase}${message && phase === 'uploading' ? ` · ${message}` : ''}`;
  let bar = step.el.querySelector('.progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'progress';
    bar.innerHTML = '<span></span>';
    step.el.querySelector('.step-row').after(bar);
  }
  const i = PHASES.indexOf(phase);
  if (i >= 0) bar.firstElementChild.style.transform = `scaleX(${(i + 1) / PHASES.length})`;
}

function stepEnd(name, status, output, data) {
  const step = findStep(name);
  openSteps.splice(openSteps.indexOf(step), 1);
  const ok = status !== 'error';
  step.el.className = `step ${ok ? 'done' : 'error'}`;
  step.el.querySelector('.state').innerHTML = icon(ok ? 'check' : 'x');
  step.el.querySelector('.step-time').textContent = since(Date.now() - step.started);
  step.el.querySelector('.progress')?.remove();
  const detail = step.el.querySelector('.step-detail');

  if (data?.kind === 'board') {
    step.el.querySelector('small').textContent = data.root ? data.root.title : data.verdict === 'healthy' ? 'مشکلی پیدا نشد' : 'علت قطعی پیدا نشد';
    detail.innerHTML = boardView(data) + rawView(output);
    step.el.classList.add('has-detail', 'open');
    requestAnimationFrame(() => detail.querySelectorAll('.conf span').forEach((s) => (s.style.transform = `scaleX(${s.dataset.w})`)));
  } else if (data?.kind === 'verify') {
    step.el.querySelector('small').textContent = data.passed ? 'مشکل برطرف شد' : 'هنوز به هدف نرسیده';
    detail.innerHTML = verifyView(data);
    step.el.classList.add('has-detail', 'open');
  } else if (output) {
    const first = output.split('\n').find((l) => l.trim()) || '';
    step.el.querySelector('small').textContent = first.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 120);
    detail.innerHTML = `<pre>${renderText(output)}</pre>`;
    step.el.classList.add('has-detail');
    if (!ok) step.el.classList.add('open');
  }
  step.el.querySelector('.step-row').setAttribute('aria-expanded', String(step.el.classList.contains('open')));
  refreshRunTitle(step.run);
  scroll();
}

const rawView = (output) => (output ? `<details class="rejected"><summary>${icon('down')}متن کامل بررسی</summary><pre>${renderText(output)}</pre></details>` : '');

function evidenceList(h) {
  const rows = [
    ...h.supporting.map((e) => `<li><span class="eid">${esc(e.id)}</span><span>${esc(e.summary)}</span></li>`),
    ...h.contradicting.map((e) => `<li><span class="eid against">${esc(e.id)}</span><span>${esc(e.summary)}</span></li>`),
  ];
  return `<ul class="evidence">${rows.join('')}</ul>`;
}

function boardView(b) {
  const out = [];
  const probe = b.probe ? ` · ${pct(b.probe.okRatio)} درخواست موفق، زمان پاسخ (p95) ${fa(b.probe.p95)}ms` : '';
  if (b.verdict === 'problem') out.push(`<div class="verdict problem">${icon('alert')}مشکل پیدا شد${probe}</div>`);
  else if (b.verdict === 'healthy') out.push(`<div class="verdict healthy">${icon('check')}برنامه سالم است${probe}</div>`);
  else out.push(`<div class="verdict">${icon('eye')}شواهد کافی برای علت قطعی نیست${probe}</div>`);

  if (b.root) {
    const c = Math.round(b.root.confidence * 100);
    out.push(`<div class="root">
      <div class="root-title"><b>${esc(b.root.title)}</b><span>اطمینان ${fa(c)}٪</span></div>
      <div class="conf" role="meter" aria-valuenow="${c}" aria-valuemin="0" aria-valuemax="100" aria-label="اطمینان"><span data-w="${c / 100}"></span></div>
      ${evidenceList(b.root)}
      ${b.codeHint ? `<span class="code-loc">${icon('code')}محل در کد: <span class="code-chip">${esc(b.codeHint.file)}:${esc(b.codeHint.line)}</span></span>` : ''}
    </div>`);
  }
  if (b.others.length) {
    out.push(`<div class="mini">${b.others.map((h) => `<div class="mini-row"><span class="tag">${h.category === 'symptom' ? 'نشانه' : 'عامل دیگر'}</span>${esc(h.title)}</div>`).join('')}</div>`);
  }
  if (b.fixes.length) {
    const tier = { T1: 'با یک تأیید', T2: 'با تأیید و پیش‌نمایش', code: 'تغییر کد', manual: 'کار دستی' };
    out.push(`<h4>راه‌حل‌ها به ترتیب پیشنهاد</h4><ol class="fixes">${b.fixes.map((f) => `<li>${esc(f.title)}<span class="tier">${tier[f.tier] || ''}</span></li>`).join('')}</ol>`);
  }
  const ruled = [...b.rejected, ...b.inconclusive];
  if (ruled.length) {
    out.push(`<details class="rejected"><summary>${icon('down')}${fa(b.rejected.length)} علت رد شد${b.inconclusive.length ? `، ${fa(b.inconclusive.length)} نامشخص` : ''}</summary>
      <div class="mini">${ruled.map((h) => `<div class="mini-row"><b>${esc(h.title)}</b></div>${evidenceList(h)}`).join('')}</div></details>`);
  }
  if (b.gaps?.length) out.push(`<p class="note">داده‌ای که در دسترس نبود: ${esc(b.gaps.join('؛ '))}</p>`);
  return `<div class="board">${out.join('')}</div>`;
}

function verifyView(v) {
  return `<div class="verify-box">
    <div class="verdict ${v.passed ? 'healthy' : 'problem'}">${icon(v.passed ? 'check' : 'alert')}${v.passed ? 'هدف‌ها برآورده شد' : 'هنوز به هدف نرسیده‌ایم'}</div>
    <table class="verify-table"><tr><th>معیار</th><th>قبل</th><th>بعد</th><th>هدف</th><th></th></tr>
    ${v.rows.map((r) => `<tr><td>${esc(r.metric)}</td><td>${esc(r.before)}</td><td>${esc(r.after)}</td><td>${esc(r.target)}</td><td>${icon(r.ok ? 'check' : 'x', r.ok ? 'ok-mark' : 'bad-mark')}</td></tr>`).join('')}
    </table></div>`;
}

// ---------- approval card ----------

function approvalCard(req) {
  stepWaiting(req.tool);
  const p = req.preview;
  const el = document.createElement('section');
  el.className = `approval ${req.tier === 'T1' ? 't1' : 't2'}`;
  el.setAttribute('aria-label', 'درخواست تأیید');
  const fact = (cls, ic, label, value) => (value ? `<div class="fact ${cls}">${icon(ic)}<div><span>${label}</span><b>${esc(value)}</b></div></div>` : '');
  const secrets = (req.needsValues || [])
    .map((k) => `<div class="secret"><label for="v-${req.id}-${esc(k)}">${icon('key')}مقدار ${esc(k)} — فقط برای لیارا فرستاده می‌شود، نه هوش مصنوعی</label><input type="password" id="v-${req.id}-${esc(k)}" data-key="${esc(k)}" autocomplete="off" required></div>`)
    .join('');
  el.innerHTML = `
    <div class="approval-head">${icon('shield')}<h3>${esc(p.title)}</h3><span class="badge">${req.tier === 'T1' ? 'کم‌خطر' : 'تغییر مهم'}</span></div>
    <ul>${p.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="facts">
      ${fact('cost', 'coin', 'هزینه', p.cost)}
      ${fact('', 'alert', 'ریسک', p.risk)}
      ${fact('', 'clock', 'قطعی سایت', p.downtime)}
      ${fact('', 'undo', 'راه برگشت', p.undo)}
    </div>
    ${secrets}
    <div class="actions main-actions">
      <button class="btn primary approve" type="button">${icon('check')}تأیید و اجرا</button>
      <button class="btn ghost reject" type="button">رد</button>
    </div>
    <div class="actions reject-row" hidden>
      <input class="grow reason" placeholder="چرا؟ (اختیاری؛ همیار راه دیگری پیشنهاد می‌دهد)" aria-label="دلیل رد">
      <button class="btn danger confirm-reject" type="button">ثبت رد</button>
    </div>
    <div class="result" hidden></div>`;

  const decide = async (approved, reason) => {
    const values = {};
    for (const input of el.querySelectorAll('input[data-key]')) values[input.dataset.key] = input.value;
    const empty = [...el.querySelectorAll('input[data-key]')].find((i) => !i.value);
    if (approved && empty) {
      empty.focus();
      return;
    }
    el.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
    const res = await api('/api/approve', { method: 'POST', body: { id: req.id, approved, reason, values } }).catch(() => null);
    el.querySelectorAll('input[data-key]').forEach((i) => (i.value = ''));
    if (!res || !res.ok) return markDecided(el, false, 'این درخواست دیگر معتبر نیست.');
    markDecided(el, approved, approved ? 'تأیید شد؛ در حال اجرا' : `رد شد${reason ? `: ${reason}` : ''}`);
    if (approved) stepRunning(req.tool, 'تأیید شد؛ در حال اجرا');
  };
  el.querySelector('.approve').onclick = () => decide(true);
  el.querySelector('.reject').onclick = () => {
    el.querySelector('.reject-row').hidden = false;
    el.querySelector('.reason').focus();
  };
  el.querySelector('.confirm-reject').onclick = () => decide(false, el.querySelector('.reason').value.trim());
  el.querySelector('.reason').addEventListener('keydown', (e) => e.key === 'Enter' && el.querySelector('.confirm-reject').click());
  thread.appendChild(el);
  scroll();
  (el.querySelector('input[data-key]') || el.querySelector('.approve')).focus({ preventScroll: true });
}

function markDecided(el, yes, text) {
  el.classList.add('decided', yes ? 'yes' : 'no');
  el.querySelectorAll('.actions, .secret').forEach((a) => (a.hidden = true));
  const r = el.querySelector('.result');
  r.hidden = false;
  r.innerHTML = `${icon(yes ? 'check' : 'x')}<span>${esc(text)}</span>`;
}

// ---------- sending ----------

function handleEvent(e) {
  if (e.type === 'assistant' && e.text) {
    finishRun();
    addMessage('assistant', renderText(e.text));
  } else if (e.type === 'tool' && e.status === 'start') stepStart(e.name, e.args);
  else if (e.type === 'tool') stepEnd(e.name, e.status, e.output, e.data);
  else if (e.type === 'progress') stepProgress(e.tool, e.phase, e.message);
  else if (e.type === 'approval') approvalCard(e);
  else if (e.type === 'error') {
    finishRun();
    addMessage('error', esc(e.text));
  }
}

async function send(text) {
  text = text.trim();
  if (state.busy || !text) return;
  if (!state.ai) return quick(text, 'diagnose');
  state.busy = true;
  $('#send-btn').disabled = true;
  addMessage('user', esc(text));
  ensureRun();
  try {
    const res = await api('/api/chat', { method: 'POST', body: { message: text, app: state.app, conversation: state.conversation } });
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
        if (line) handleEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    if (err.message !== 'login required') addMessage('error', esc(`ارتباط قطع شد: ${err.message}`));
  } finally {
    finishRun();
    state.busy = false;
    $('#send-btn').disabled = false;
    loadTimeline();
    loadStatus();
  }
}

// Without the AI, task tiles and the watch alert still run read-only tools directly.
async function quick(text, tool) {
  addMessage('user', esc(text));
  if (!state.app && tool !== 'liara_overview') {
    addMessage('assistant', 'اول یک برنامه انتخاب کنید. اگر هنوز برنامه‌ای ندارید، از «دیپلوی پروژه» شروع کنید.');
    return;
  }
  ensureRun();
  stepStart(tool, { app: state.app });
  try {
    const res = await api('/api/quick', { method: 'POST', body: { tool, args: { app: state.app, errorsOnly: true } } });
    const data = await res.json();
    stepEnd(tool, data.error ? 'error' : 'done', data.output || data.error, data.data);
  } catch (err) {
    if (err.message !== 'login required') stepEnd(tool, 'error', err.message);
  }
  finishRun();
  loadTimeline();
}

// ---------- status rail ----------

function areaChart(points, limit, color) {
  if (!points.length) return '<p class="note">داده‌ای هنوز ثبت نشده</p>';
  const w = 300, h = 64, pad = 4;
  const top = Math.max(limit || 0, ...points.map((p) => p.v)) * 1.08 || 1;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const x = (t) => (((t - t0) / Math.max(1, t1 - t0)) * w).toFixed(1);
  const y = (v) => (h - pad - (v / top) * (h - pad * 2)).toFixed(1);
  const line = points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ');
  const id = `g${Math.random().toString(36).slice(2, 7)}`;
  const last = points[points.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${limit ? `<line x1="0" x2="${w}" y1="${y(limit)}" y2="${y(limit)}" stroke="#ff6b7a" stroke-opacity=".55" stroke-dasharray="4 4" stroke-width="1"/>` : ''}
    <polygon fill="url(#${id})" points="0,${h} ${line} ${w},${h}"/>
    <polyline fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" points="${line}"/>
    <circle cx="${x(last.t)}" cy="${y(last.v)}" r="3" fill="${color}"/>
  </svg>`;
}

function setHealth(stateName, text) {
  $('#health-pill').dataset.state = stateName;
  $('#switch-dot').dataset.state = stateName;
  $('#switch-label').dataset.state = stateName;
  $('#switch-label').textContent = text;
  $('#health-text').textContent = text;
}

async function loadStatus() {
  const card = $('#app-card');
  if (!state.app) return;
  try {
    const s = await (await api(`/api/status?app=${encodeURIComponent(state.app)}`)).json();
    if (s.error) throw new Error(s.error);
    const off = s.scale === 0;
    const healthy = s.probe.healthy && !off;
    setHealth(off ? 'off' : healthy ? 'ok' : 'bad', off ? 'خاموش' : healthy ? 'سالم' : 'مشکل دارد');
    const mem = s.memory.map((p) => ({ t: p.t, v: p.v / 1024 / 1024 }));
    const memLimit = s.planRamGB ? s.planRamGB * 1024 : 0;
    const lastMem = mem.length ? mem[mem.length - 1].v : 0;
    const lastCpu = s.cpu.length ? s.cpu[s.cpu.length - 1].v : 0;
    card.innerHTML = `
      <div class="app-head">
        <div style="min-width:0"><h2>${esc(s.app)}</h2>
          <a class="app-url" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace('https://', ''))}${icon('link')}</a></div>
        <span class="pill" data-state="${off ? 'off' : healthy ? 'ok' : 'bad'}"><span class="dot"></span>${off ? 'خاموش' : healthy ? 'سالم' : 'مشکل دارد'}</span>
      </div>
      <div class="stats">
        <div class="stat"><span>درخواست موفق</span><b class="${s.probe.okRatio < 0.95 ? 'bad' : 'good'}">${pct(s.probe.okRatio)}</b></div>
        <div class="stat"><span>زمان پاسخ (p95)</span><b class="${s.probe.p95 > 1500 ? 'bad' : ''}">${fa(s.probe.p95)}ms</b></div>
      </div>
      <div class="chart"><div class="chart-head"><span>رم، ۳۰ دقیقه‌ی اخیر</span><b>${fa(Math.round(lastMem))}MB${memLimit ? ` از ${fa(memLimit)}MB` : ''}</b></div>${areaChart(mem, memLimit, '#87fcc4')}</div>
      <div class="chart"><div class="chart-head"><span>CPU، ۳۰ دقیقه‌ی اخیر</span><b>${fa(Math.round(lastCpu * 100) / 100)}${s.planCpu ? ` از ${fa(s.planCpu)} هسته` : ''}</b></div>${areaChart(s.cpu, s.planCpu, '#28c1f5')}</div>
      <dl class="meta">
        <dt>پلن</dt><dd>${esc(s.planID)}${s.planRamGB ? ` · ${fa(s.planRamGB)} گیگ رم` : ''}</dd>
        <dt>پلتفرم</dt><dd>${esc(s.platform || '—')}</dd>
        <dt>نسخه</dt><dd>${esc(s.currentRelease || '—')}</dd>
        <dt>متغیرها</dt><dd>${s.envNames.length ? esc(s.envNames.join('، ')) : '—'}</dd>
      </dl>`;
  } catch (err) {
    if (err.message === 'login required') return;
    setHealth('unknown', 'نامشخص');
    card.innerHTML = `<div class="empty-rail">${icon('alert')}<p>وضعیت برنامه خوانده نشد: ${esc(err.message)}</p></div>`;
  }
}

async function loadTimeline() {
  try {
    const entries = (await (await api('/api/audit')).json()).filter((e) => e.outcome !== 'previewed').slice(0, 10);
    if (!entries.length) return;
    $('#timeline').innerHTML = entries
      .map((e) => {
        const when = new Date(e.at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' });
        const who = e.approvedBy ? `<span class="who">تأیید: ${esc(e.approvedBy.replace('user', 'شما').replace('(dashboard)', '(داشبورد)').replace('(elicitation)', '(Claude Code)'))}</span>` : '';
        return `<li class="${e.outcome}"><span class="tdot"></span><span>${esc(TOOL_LABELS[e.tool] || e.tool)}${e.args?.app ? ` · ${esc(e.args.app)}` : ''} — ${OUTCOMES[e.outcome] || e.outcome}${who}</span><span class="when">${when}</span></li>`;
      })
      .join('');
  } catch {}
}

// ---------- watch mode ----------

function setWatch(on) {
  clearInterval(state.watchTimer);
  state.alerted = false;
  $('#watch-text').textContent = on ? 'هر ۳۰ ثانیه سایت تست می‌شود' : 'خاموش';
  if (!on) return;
  const tick = async () => {
    if (!state.app) return;
    try {
      const p = await (await api(`/api/probe?app=${encodeURIComponent(state.app)}`)).json();
      $('#watch-text').textContent = `آخرین تست ${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}: ${p.healthy ? 'سالم' : 'مشکل'}`;
      if (!p.healthy && !state.alerted) {
        state.alerted = true;
        setHealth('bad', 'مشکل دارد');
        $('#alert-text').textContent = `سایت ${state.app} مشکل دارد: ${pct(p.okRatio)} درخواست موفق، زمان پاسخ ${fa(p.p95)}ms`;
        $('#alert').hidden = false;
      } else if (p.healthy) {
        state.alerted = false;
        $('#alert').hidden = true;
        setHealth('ok', 'سالم');
      }
    } catch {}
  };
  tick();
  state.watchTimer = setInterval(tick, 30_000);
}

// ---------- login ----------

function showLogin() {
  $('#login').hidden = false;
  $('#login-password').focus();
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#login-password').value }) });
  if (res.ok) {
    $('#login').hidden = true;
    init();
  } else {
    $('#login-error').hidden = false;
    $('#login-error').textContent = 'رمز اشتباه است.';
  }
};

// ---------- wiring ----------

function selectTab(name) {
  document.querySelectorAll('.seg').forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $('#panel-chat').classList.toggle('active', name === 'chat');
  $('#panel-status').classList.toggle('active', name === 'status');
}

document.querySelectorAll('.seg').forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
document.querySelectorAll('.tile').forEach((tile) => {
  tile.onclick = () => (state.ai ? send(tile.dataset.prompt) : quick(tile.querySelector('b').textContent, tile.dataset.quick));
});

const input = $('#input');
const grow = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
};
input.addEventListener('input', grow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  grow();
  send(text);
};
$('#app-select').onchange = (e) => {
  state.app = e.target.value;
  loadStatus();
};
$('#watch-toggle').onchange = (e) => setWatch(e.target.checked);
$('#alert-btn').onclick = () => {
  $('#alert').hidden = true;
  selectTab('chat');
  const prompt = `سایت ${state.app} مشکل دارد، بررسی کن.`;
  state.ai ? send(prompt) : quick(prompt, 'diagnose');
};
$('#stop-btn').onclick = async () => {
  await api('/api/stop', { method: 'POST' }).catch(() => {});
  document.querySelectorAll('.approval:not(.decided)').forEach((el) => markDecided(el, false, 'با دکمه‌ی توقف لغو شد'));
  toast('همه‌ی تأییدهای در انتظار لغو شد؛ هیچ عملیاتی اجرا نمی‌شود.');
};

async function init() {
  try {
    const config = await (await api('/api/config')).json();
    state.ai = config.ai;
    const [label, hint] = MODES[config.mode] || [config.mode, ''];
    $('#mode-text').textContent = label;
    $('#mode-chip').title = hint;

    const { balance, apps } = await (await api('/api/apps')).json();
    $('#balance-text').textContent = `${fa(Math.round(balance))} تومان`;
    const select = $('#app-select');
    select.innerHTML = apps.length
      ? apps.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}${a.scale === 0 ? ' (خاموش)' : ''}</option>`).join('')
      : '<option value="">برنامه‌ای ندارید</option>';
    state.app = apps[0]?.name || '';
    if (!apps.length) setHealth('unknown', 'بدون برنامه');
    loadStatus();
    loadTimeline();
  } catch (err) {
    if (err.message !== 'login required') addMessage('error', esc(`خطا در بارگذاری: ${err.message}`));
  }
}

init();
