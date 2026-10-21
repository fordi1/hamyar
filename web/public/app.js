// Hamyar dashboard client: chat with streamed agent events, approval cards,
// status panel with sparklines, watch mode and the audit timeline.
'use strict';

const $ = (sel) => document.querySelector(sel);
const fa = (n) => Number(n).toLocaleString('fa-IR');
const pct = (r) => `${fa(Math.round(r * 100))}٪`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TOOL_LABELS = {
  liara_overview: 'مرور حساب', analyze_project: 'تحلیل پروژه', app_status: 'وضعیت برنامه', get_logs: 'خواندن لاگ‌ها',
  diagnose: 'بررسی علت مشکل', verify: 'بررسی نتیجه', check_domain: 'بررسی دامنه', incident_report: 'گزارش حادثه',
  audit_log: 'تاریخچه‌ی عملیات', launch_app: 'ساخت برنامه و دیپلوی', deploy: 'انتشار نسخه‌ی جدید', set_env: 'تنظیم متغیرها',
  restart_app: 'ری‌استارت', turn_on_app: 'روشن کردن', turn_off_app: 'خاموش کردن', resize_plan: 'تغییر پلن',
  rollback: 'برگشت به نسخه‌ی قبلی', add_domain: 'اتصال دامنه', enable_ssl: 'فعال‌سازی SSL',
  use_liara_dns: 'راه‌اندازی DNS لیارا', create_dns_records: 'ساخت رکوردهای DNS',
};
const PHASES = {
  packing: 'بسته‌بندی کد', uploading: 'آپلود', queued: 'در صف ساخت', building: 'ساخت (build)', deploying: 'استقرار',
  ready: 'آماده', failed: 'ناموفق', probing: 'تست سایت', done: 'تمام',
};
const OUTCOMES = { previewed: 'پیش‌نمایش', executed: 'اجرا شد', failed: 'ناموفق', rejected: 'رد شد', blocked: 'مسدود شد' };

const state = {
  app: '',
  ai: false,
  conversation: sessionStorage.getItem('hamyar_conv') || Math.random().toString(36).slice(2),
  busy: false,
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

// ---------- markdown-lite for assistant and tool text ----------

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

// ---------- chat rendering ----------

const messages = $('#messages');
const scroll = () => (messages.scrollTop = messages.scrollHeight);

function addMessage(role, html) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = html;
  messages.appendChild(el);
  scroll();
  return el;
}

const runningTools = new Map();

function toolStart(name) {
  const el = document.createElement('div');
  el.className = 'tool running';
  el.innerHTML = `<div class="tool-row"><span class="dot"></span><span class="label">در حال ${esc(TOOL_LABELS[name] || name)}…</span></div>`;
  messages.appendChild(el);
  runningTools.set(name, el);
  scroll();
  return el;
}

function toolEnd(name, status, output) {
  const el = runningTools.get(name) || toolStart(name);
  runningTools.delete(name);
  el.className = `tool ${status === 'error' ? 'error' : 'done'}`;
  const label = `${status === 'error' ? '✗' : '✓'} ${TOOL_LABELS[name] || name}`;
  el.innerHTML = `<div class="tool-row"><span class="dot"></span><span>${esc(label)}</span></div>` +
    (output ? `<details${status === 'error' ? ' open' : ''}><summary>جزئیات</summary><pre>${renderText(output)}</pre></details>` : '');
  scroll();
}

function toolProgress(name, phase, message) {
  const el = runningTools.get(name);
  if (!el) return;
  el.querySelector('.label').textContent = `${TOOL_LABELS[name] || name}: ${PHASES[phase] || phase}${message && phase === 'uploading' ? ` (${message})` : ''}…`;
}

function approvalCard(req) {
  const el = document.createElement('div');
  el.className = `approval ${req.tier === 'T1' ? 't1' : 't2'}`;
  el.dataset.id = req.id;
  const p = req.preview;
  const valueInputs = (req.needsValues || [])
    .map((k) => `<label class="field"><span>مقدار ${esc(k)} (فقط برای لیارا ارسال می‌شود، نه هوش مصنوعی)</span><input type="password" data-key="${esc(k)}" autocomplete="off" required></label>`)
    .join('');
  el.innerHTML = `
    <h3>🛑 ${esc(p.title)} <span class="tier">${req.tier === 'T1' ? 'کم‌خطر' : 'تغییر مهم'}</span></h3>
    <ul>${p.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <dl>
      ${p.cost ? `<dt>💰 هزینه</dt><dd>${esc(p.cost)}</dd>` : ''}
      <dt>⚠️ ریسک</dt><dd>${esc(p.risk)}</dd>
      <dt>⏱️ قطعی</dt><dd>${esc(p.downtime)}</dd>
      <dt>↩️ برگشت</dt><dd>${esc(p.undo)}</dd>
    </dl>
    ${valueInputs}
    <div class="actions">
      <button class="btn ok approve" type="button">✅ تأیید و اجرا</button>
      <button class="btn reject" type="button">رد</button>
    </div>
    <div class="actions reject-row" hidden>
      <input class="grow reason" placeholder="دلیل رد (اختیاری؛ به همیار کمک می‌کند راه دیگری پیشنهاد دهد)">
      <button class="btn danger confirm-reject" type="button">ثبت رد</button>
    </div>
    <div class="result" hidden></div>`;

  const decide = async (approved, reason) => {
    const values = {};
    for (const input of el.querySelectorAll('input[data-key]')) values[input.dataset.key] = input.value;
    if (approved && Object.values(values).some((v) => !v)) {
      el.querySelector('input[data-key]:placeholder-shown, input[data-key]').focus();
      return;
    }
    el.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
    const res = await api('/api/approve', { method: 'POST', body: { id: req.id, approved, reason, values } }).catch(() => null);
    el.querySelectorAll('input[data-key]').forEach((i) => (i.value = ''));
    markDecided(el, res && res.ok ? (approved ? '✅ تأیید شد؛ در حال اجرا…' : '🚫 رد شد') : 'این درخواست دیگر معتبر نیست.');
  };
  el.querySelector('.approve').onclick = () => decide(true);
  el.querySelector('.reject').onclick = () => {
    el.querySelector('.reject-row').hidden = false;
    el.querySelector('.reason').focus();
  };
  el.querySelector('.confirm-reject').onclick = () => decide(false, el.querySelector('.reason').value);
  messages.appendChild(el);
  scroll();
}

function markDecided(el, text) {
  el.classList.add('decided');
  el.querySelectorAll('.actions').forEach((a) => (a.hidden = true));
  const r = el.querySelector('.result');
  r.hidden = false;
  r.textContent = text;
}

// ---------- sending ----------

async function send(text) {
  if (state.busy || !text.trim()) return;
  if (!state.ai) return quickFallback(text);
  state.busy = true;
  $('#send-btn').disabled = true;
  addMessage('user', esc(text));
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
    state.busy = false;
    $('#send-btn').disabled = false;
    loadTimeline();
    loadStatus();
  }
}

function handleEvent(e) {
  if (e.type === 'assistant' && e.text) addMessage('assistant', renderText(e.text));
  else if (e.type === 'tool' && e.status === 'start') toolStart(e.name);
  else if (e.type === 'tool') toolEnd(e.name, e.status, e.output);
  else if (e.type === 'progress') toolProgress(e.tool, e.phase, e.message);
  else if (e.type === 'approval') approvalCard(e);
  else if (e.type === 'error') addMessage('error', esc(e.text));
}

// Without the AI, quick actions still run the read-only tools directly.
async function quickFallback(text, tool) {
  addMessage('user', esc(text));
  const name = tool || 'diagnose';
  if (!state.app && name !== 'liara_overview') return addMessage('assistant', 'اول یک برنامه انتخاب کنید.');
  toolStart(name);
  const res = await api('/api/quick', { method: 'POST', body: { tool: name, args: { app: state.app, errorsOnly: true } } });
  const data = await res.json();
  toolEnd(name, data.error ? 'error' : 'done', data.output || data.error);
  loadTimeline();
}

// ---------- status panel ----------

function sparkline(points, max, color) {
  if (!points.length) return '<p class="muted small">داده‌ای نیست</p>';
  const w = 300, h = 44;
  const top = Math.max(max || 0, ...points.map((p) => p.v)) || 1;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const xy = points.map((p) => `${(((p.t - t0) / Math.max(1, t1 - t0)) * w).toFixed(1)},${(h - (p.v / top) * (h - 4) - 2).toFixed(1)}`);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="2" points="${xy.join(' ')}"/></svg>`;
}

async function loadStatus() {
  if (!state.app) return;
  const body = $('#status-body');
  try {
    const s = await (await api(`/api/status?app=${encodeURIComponent(state.app)}`)).json();
    if (s.error) throw new Error(s.error);
    const healthy = s.probe.healthy && s.scale !== 0;
    const mem = s.memory.map((p) => ({ t: p.t, v: p.v / 1024 / 1024 }));
    const memMax = s.planRamGB ? s.planRamGB * 1024 : 0;
    const lastMem = mem.length ? mem[mem.length - 1].v : 0;
    const lastCpu = s.cpu.length ? s.cpu[s.cpu.length - 1].v : 0;
    body.innerHTML = `
      <div class="health ${healthy ? 'ok' : 'bad'}"><span class="light"></span>${healthy ? 'سالم' : s.scale === 0 ? 'خاموش' : 'مشکل دارد'}</div>
      <dl class="kv">
        <dt>آدرس</dt><dd><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace('https://', ''))}</a></dd>
        <dt>پلن</dt><dd>${esc(s.planID)}${s.planRamGB ? ` (${fa(s.planRamGB)} گیگ رم)` : ''}</dd>
        <dt>پاسخ</dt><dd>${pct(s.probe.okRatio)} موفق، p95 ${fa(s.probe.p95)}ms</dd>
        <dt>نسخه</dt><dd>${esc(s.currentRelease || '—')}</dd>
        <dt>متغیرها</dt><dd>${s.envNames.length ? esc(s.envNames.join('، ')) : '—'}</dd>
      </dl>
      <div class="spark"><div class="spark-head"><span>رم (۳۰ دقیقه)</span><span>${fa(Math.round(lastMem))}MB${memMax ? ` از ${fa(memMax)}MB` : ''}</span></div>${sparkline(mem, memMax, 'var(--primary)')}</div>
      <div class="spark"><div class="spark-head"><span>CPU (۳۰ دقیقه)</span><span>${fa(Math.round(lastCpu * 100) / 100)}${s.planCpu ? ` از ${fa(s.planCpu)}` : ''}</span></div>${sparkline(s.cpu, s.planCpu, 'var(--warn)')}</div>`;
  } catch (err) {
    if (err.message !== 'login required') body.innerHTML = `<p class="error small">${esc(err.message)}</p>`;
  }
}

async function loadTimeline() {
  try {
    const entries = await (await api('/api/audit')).json();
    const list = $('#timeline');
    if (!entries.length) return;
    list.innerHTML = entries
      .filter((e) => e.outcome !== 'previewed')
      .slice(0, 12)
      .map((e) => {
        const when = new Date(e.at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' });
        const who = e.approvedBy ? ` — ${esc(e.approvedBy)}` : '';
        return `<li><span class="when">${when}</span><span>${esc(TOOL_LABELS[e.tool] || e.tool)}${e.args?.app ? ` (${esc(e.args.app)})` : ''}: <b>${OUTCOMES[e.outcome] || e.outcome}</b>${who}</span></li>`;
      })
      .join('') || '<li class="muted">هنوز عملیاتی انجام نشده.</li>';
  } catch {}
}

// ---------- watch mode ----------

function setWatch(on) {
  clearInterval(state.watchTimer);
  state.alerted = false;
  $('#watch-text').textContent = on ? 'روشن: سایت هر ۳۰ ثانیه تست می‌شود.' : 'وقتی روشن باشد و این صفحه باز باشد، سایت مرتب تست می‌شود و اگر مشکلی پیش بیاید خبر می‌دهد.';
  if (!on) return;
  const tick = async () => {
    if (!state.app) return;
    try {
      const p = await (await api(`/api/probe?app=${encodeURIComponent(state.app)}`)).json();
      if (!p.healthy && !state.alerted) {
        state.alerted = true;
        $('#alert-text').textContent = `⚠️ سایت ${state.app} مشکل دارد: ${pct(p.okRatio)} درخواست موفق، p95 ${fa(p.p95)}ms`;
        $('#alert').hidden = false;
      } else if (p.healthy) {
        state.alerted = false;
        $('#alert').hidden = true;
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
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $('#panel-chat').classList.toggle('active', name === 'chat');
  $('#panel-status').classList.toggle('active', name === 'status');
}

document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
document.querySelectorAll('.chip').forEach((c) => {
  c.onclick = () => (state.ai ? send(c.dataset.prompt) : quickFallback(c.textContent.trim(), c.dataset.quick));
});

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#input').value;
  $('#input').value = '';
  send(text);
};
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#app-select').onchange = (e) => {
  state.app = e.target.value;
  loadStatus();
};
$('#refresh-btn').onclick = () => loadStatus();
$('#watch-toggle').onchange = (e) => setWatch(e.target.checked);
$('#alert-btn').onclick = () => {
  $('#alert').hidden = true;
  selectTab('chat');
  const prompt = `سایت ${state.app} مشکل دارد، بررسی کن.`;
  state.ai ? send(prompt) : quickFallback(prompt, 'diagnose');
};
$('#stop-btn').onclick = async () => {
  await api('/api/stop', { method: 'POST' }).catch(() => {});
  document.querySelectorAll('.approval:not(.decided)').forEach((el) => markDecided(el, '⏹ با دکمه‌ی توقف لغو شد.'));
  addMessage('assistant', '⏹ همه‌ی تأییدهای در انتظار لغو شد و هیچ عملیاتی اجرا نمی‌شود.');
};

async function init() {
  try {
    const config = await (await api('/api/config')).json();
    state.ai = config.ai;
    $('#mode-badge').textContent = { observe: '👁 فقط مشاهده', review: '🛡 بازبینی', 'auto-safe': '⚡ خودکار محدود' }[config.mode] || config.mode;
    $('#mode-badge').title = { observe: 'هیچ تغییری اجرا نمی‌شود', review: 'هر تغییر قبل از اجرا تأیید شما را می‌خواهد', 'auto-safe': 'کارهای کم‌خطر خودکار؛ تغییرات مهم با تأیید' }[config.mode] || '';
    if (!config.ai) addMessage('assistant', 'هوش مصنوعی لیارا هنوز تنظیم نشده؛ دکمه‌های سریع پایین (بررسی مشکل، وضعیت، لاگ) بدون آن هم کار می‌کنند.');

    const { balance, apps } = await (await api('/api/apps')).json();
    $('#balance-badge').textContent = `💰 ${fa(Math.round(balance))} ت`;
    const select = $('#app-select');
    select.innerHTML = apps.length
      ? apps.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}${a.scale === 0 ? ' (خاموش)' : ''}</option>`).join('')
      : '<option value="">برنامه‌ای ندارید</option>';
    state.app = apps[0]?.name || '';
    loadStatus();
    loadTimeline();
  } catch (err) {
    if (err.message !== 'login required') addMessage('error', esc(`خطا در بارگذاری: ${err.message}`));
  }
}

init();
