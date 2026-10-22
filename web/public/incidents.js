// Incident history (screen G) and incident workspace (screen D). An incident is opened by
// a diagnose that found a problem and closed by a verify that met its targets (or by the
// user, with a reason). Decisions and executions come from the audit log.
'use strict';

const INC_STATUS = { open: ['bad', 'باز'], resolved: ['ok', 'برطرف شد'], closed: ['off', 'بسته شد بدون تأیید رفع'] };
const SEVERITY = { critical: ['bad', 'بحرانی · سایت خطا می‌دهد'], degraded: ['warn', 'افت کیفیت'], unclear: ['', 'نامشخص'] };
const EVENT_ICON = { trigger: 'alert', evidence: 'file', diagnosis: 'bug', verify: 'pulse', closed: 'check' };
const ACTION_FA = {
  restart_app: 'ری‌استارت', turn_on_app: 'روشن کردن', turn_off_app: 'خاموش کردن', set_env: 'تنظیم متغیرها', resize_plan: 'تغییر پلن',
  rollback: 'بازگشت به نسخه‌ی قبلی', deploy: 'انتشار نسخه‌ی جدید', launch_app: 'ساخت و دیپلوی', add_domain: 'اتصال دامنه', enable_ssl: 'فعال‌سازی SSL',
};
// fixes the incident page can request directly (with approval); the rest go through the chat
const DIRECT_FIX = { restart: 'restart_app', turn_on: 'turn_on_app' };
const incPrefs = { filter: 'all' };
const incView = () => $('#incidents-view');

const duration = (from, to = Date.now()) => {
  const m = Math.max(1, Math.round((to - from) / 60000));
  return m < 60 ? `${fa(m)} دقیقه` : m < 1440 ? `${fa(Math.round(m / 60))} ساعت` : `${fa(Math.round(m / 1440))} روز`;
};
const statusPill = (s) => `<span class="pill" data-state="${INC_STATUS[s][0]}"><span class="dot"></span>${INC_STATUS[s][1]}</span>`;
const severityChip = (s) => `<span class="chip-i ${SEVERITY[s][0]}">${SEVERITY[s][1]}</span>`;

async function refreshIncidentBadge() {
  try {
    const list = await (await api('/api/incidents')).json();
    const open = list.filter((i) => i.status === 'open').length;
    document.querySelectorAll('[data-open-incidents]').forEach((b) => {
      b.hidden = !open;
      b.textContent = fa(open);
    });
    return list;
  } catch {
    return [];
  }
}

// ---------- G. history ----------

async function renderIncidentList() {
  const el = incView();
  const seg = [['all', 'همه'], ['open', 'باز'], ['done', 'بسته‌شده']].map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${incPrefs.filter === k}">${l}</button>`).join('');
  el.innerHTML = `<div class="page-head row"><div><h1>حوادث</h1><p>هر بار که همیار مشکلی را بررسی می‌کند، مسیرش از شروع تا نتیجه اینجا ثبت می‌شود.</p></div><div class="seg" role="group" aria-label="فیلتر">${seg}</div></div>${loadingView()}`;
  el.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => ((incPrefs.filter = b.dataset.filter), renderIncidentList())));
  const slot = el.querySelector('.skeleton');
  try {
    const all = await refreshIncidentBadge();
    if (!slot.isConnected) return;
    const list = all.filter((i) => incPrefs.filter === 'all' || (incPrefs.filter === 'open' ? i.status === 'open' : i.status !== 'open'));
    const body = list.length
      ? `<section class="card inc-list">${list
          .map((i) => `<a class="inc-row" href="#/incidents/${esc(i.id)}">
            <span class="inc-main"><b>${bidi(i.title)}</b><small><bdi>${esc(i.app)}</bdi> · ${ago(i.openedAt)} · ${i.closedAt ? `طول کشید ${duration(i.openedAt, i.closedAt)}` : `باز از ${duration(i.openedAt)} پیش`}${i.fix ? ` · راه‌حل اول: ${esc(i.fix)}` : ''}</small></span>
            <span class="inc-tags">${severityChip(i.severity)}${statusPill(i.status)}</span>
          </a>`)
          .join('')}</section>`
      : `<div class="card empty-card">${mascot('')}<b>${all.length ? 'حادثه‌ای با این فیلتر نیست' : 'هنوز حادثه‌ای ثبت نشده'}</b><span class="muted">وقتی همیار مشکلی را بررسی کند و نشانه‌ی خطا پیدا کند، اینجا یک حادثه با مدرک‌ها، فرضیه‌ها و نتیجه ثبت می‌شود.</span>${state.app ? `<button class="btn primary" type="button" id="inc-check">${icon('bug')}بررسی ${esc(state.app)}</button>` : '<a class="btn primary" href="#/apps">سرویس‌ها</a>'}</div>`;
    slot.outerHTML = body;
    $('#inc-check')?.addEventListener('click', () => diagnoseFromPage(state.app));
  } catch (err) {
    if (err.message === 'login required' || !slot.isConnected) return;
    slot.outerHTML = failView(err, true);
    el.querySelector('[data-retry]').onclick = renderIncidentList;
  }
}

function diagnoseFromPage(app, prompt) {
  location.hash = '#/';
  const text = prompt || `برنامه‌ی ${app} را بررسی کن و علت مشکلش را پیدا کن.`;
  if (state.ai) return send(text);
  // without the AI the read-only diagnose still runs (and still records the incident)
  state.app = app;
  quick(text, 'diagnose');
}

// ---------- D. workspace ----------

function hypothesisView(h, group) {
  const labels = { root: h.confidence >= 0.8 ? ['ok', 'علت تأییدشده'] : ['warn', 'علت محتمل'], other: h.category === 'symptom' ? ['', 'نشانه'] : ['warn', 'علت محتمل'], inconclusive: ['', 'نامشخص'], rejected: ['off', 'رد شد'] };
  const [cls, label] = labels[group];
  const ev = (list, against) => list.map((e) => `<li><span class="eid${against ? ' against' : ''}">${esc(e.id || '—')}</span><span>${bidi(e.summary)}</span></li>`).join('');
  return `<div class="hyp ${group}">
    <div class="hyp-head"><span class="chip-i ${cls}">${label}</span><b>${bidi(h.title)}</b>${group === 'root' || group === 'other' ? `<span class="muted">${fa(Math.round(h.confidence * 100))}٪</span>` : ''}</div>
    ${group === 'root' ? `<div class="bar ok"><i data-pct="${h.confidence}"></i></div>` : ''}
    ${h.supporting.length || h.contradicting.length ? `<ul class="evidence">${ev(h.supporting, false)}${ev(h.contradicting, true)}</ul>` : group === 'inconclusive' ? '<p class="note-sm">مدرک کافی برای تأیید یا رد پیدا نشد.</p>' : ''}
  </div>`;
}

function timelineView(inc, actions) {
  const rows = [
    ...inc.events.map((e) => ({ at: e.at, icon: EVENT_ICON[e.kind], cls: e.kind === 'closed' ? 'done' : '', text: e.text })),
    ...actions.map((a) => ({
      at: a.at,
      icon: a.outcome === 'rejected' || a.outcome === 'failed' || a.outcome === 'blocked' ? 'x' : a.outcome === 'executed' ? 'check' : 'shield',
      cls: a.outcome === 'executed' ? 'done' : a.outcome === 'rejected' || a.outcome === 'failed' || a.outcome === 'blocked' ? 'fail' : '',
      text: `${ACTION_FA[a.tool] || a.tool} — ${OUTCOMES[a.outcome] || a.outcome}${a.approvedBy ? ` · ${whoText(a.approvedBy)}` : ''}${a.detail && a.outcome !== 'executed' ? ` · «${a.detail}»` : ''}`,
    })),
  ].sort((a, b) => a.at - b.at);
  return `<ol class="tl">${rows.map((r) => `<li class="${r.cls}"><span class="st">${icon(r.icon)}</span><span>${bidi(r.text)}</span><span class="t">${clock(new Date(r.at))}</span></li>`).join('')}</ol>`;
}

function fixesView(inc) {
  if (!inc.fixes.length) return '';
  const tier = { T1: 'با یک تأیید', T2: 'با تأیید و پیش‌نمایش', code: 'تغییر کد', manual: 'کار دستی' };
  const rows = inc.fixes
    .map((f, i) => {
      const direct = DIRECT_FIX[f.action];
      const button = inc.status !== 'open' ? '' : direct ? `<button class="btn small" type="button" data-fix-direct="${direct}">انجام (با تأیید)</button>` : state.ai ? `<button class="btn small" type="button" data-fix-chat="${i}">از همیار بخواه</button>` : '';
      return `<li><span><b>${bidi(f.title)}</b><small>${tier[f.tier] || ''}${f.effect ? ` · ${esc(f.effect)}` : ''}</small></span>${button}</li>`;
    })
    .join('');
  return `<section class="card"><h2>راه‌حل‌های پیشنهادی به ترتیب</h2><ol class="fix-list">${rows}</ol><div id="inc-action-box" class="stack"></div></section>`;
}

function verifyView2(inc) {
  const v = inc.verifications.at(-1);
  if (!v) return `<section class="card"><h2>قبل و بعد</h2><p class="note-sm">هنوز بعد از رفع اندازه‌گیری نشده. بعد از اجرای راه‌حل، «بررسی بعد از رفع» را بزنید.</p></section>`;
  return `<section class="card"><h2>قبل و بعد <span class="chip-i ${v.passed ? 'ok' : 'bad'}">${v.passed ? 'هدف‌ها برآورده شد' : 'هنوز به هدف نرسیده'}</span></h2>
    <table class="verify-table vt"><thead><tr><th>معیار</th><th>قبل</th><th>بعد</th><th>هدف</th><th></th></tr></thead><tbody>
    ${v.rows.map((r) => `<tr><td>${esc(r.metric)}</td><td data-label="قبل">${esc(r.before)}</td><td data-label="بعد">${esc(r.after)}</td><td data-label="هدف">${esc(r.target)}</td><td>${icon(r.ok ? 'check' : 'x', r.ok ? 'ok-mark' : 'bad-mark')}</td></tr>`).join('')}
    </tbody></table><span class="src">اندازه‌گیری همیار · ${when(v.at)}</span></section>`;
}

async function renderIncident(id) {
  const el = incView();
  el.innerHTML = `<a class="btn ghost back" href="#/incidents">${icon('undo')}همه‌ی حوادث</a>${loadingView()}`;
  try {
    const res = await api(`/api/incidents/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const { incident: inc, actions, report } = data;
    const groups = [
      ...(inc.root ? [hypothesisView(inc.root, 'root')] : ['<p class="note-sm">هیچ علتی با اطمینان کافی تأیید نشد.</p>']),
      ...inc.others.map((h) => hypothesisView(h, 'other')),
      ...inc.inconclusive.map((h) => hypothesisView(h, 'inconclusive')),
      ...inc.rejected.map((h) => hypothesisView(h, 'rejected')),
    ].join('');
    const logs = inc.logs.length
      ? `<section class="card"><h2>لاگ‌های مرتبط</h2><div class="log-list">${inc.logs.map((l) => `<div class="log-line"><span class="lvl error">${fa(l.count)}×</span><span></span><span>${esc(l.sample)}</span></div>`).join('')}</div><a class="btn ghost small" href="#/apps/${encodeURIComponent(inc.app)}/logs">همه‌ی لاگ‌های ${esc(inc.app)}</a></section>`
      : '';
    el.innerHTML = `
      <a class="btn ghost back" href="#/incidents">${icon('undo')}همه‌ی حوادث</a>
      <div class="app-header">
        <div><h1 class="inc-title">${bidi(inc.title)}</h1><p class="note-sm"><a href="#/apps/${encodeURIComponent(inc.app)}"><bdi>${esc(inc.app)}</bdi></a> · شروع ${when(inc.openedAt)} · ${inc.closedAt ? `طول کشید ${duration(inc.openedAt, inc.closedAt)}` : `باز از ${duration(inc.openedAt)} پیش`} · ${fa(inc.diagnoses)} بار بررسی · #${esc(inc.id)}</p></div>
        <div class="inc-tags">${severityChip(inc.severity)}${statusPill(inc.status)}</div>
      </div>
      ${inc.status === 'open' ? `<div class="toolbar">
        <button class="btn primary" type="button" id="inc-verify">${icon('pulse')}بررسی بعد از رفع</button>
        <button class="btn" type="button" id="inc-rediagnose">${icon('refresh')}بررسی دوباره</button>
        <button class="btn" type="button" id="inc-close">${icon('x')}بستن حادثه</button>
      </div>
      <div class="toolbar" id="inc-close-row" hidden><input class="grow" id="inc-close-reason" placeholder="چرا بدون تأیید رفع بسته می‌شود؟" aria-label="دلیل بستن"><button class="btn danger" type="button" id="inc-close-confirm">ثبت و بستن</button></div>` : ''}
      <div id="inc-status-box"></div>
      <div class="inc-grid">
        <section class="card"><h2>فرضیه‌ها و مدرک‌ها</h2><div class="stack">${groups}</div>
          ${inc.codeHint ? `<p class="code-loc">${icon('code')}محل در کد: <span class="code-chip">${esc(inc.codeHint.file)}:${esc(inc.codeHint.line)}</span></p>` : ''}
          ${inc.gaps.length ? `<p class="note-sm">داده‌ای که در دسترس نبود: ${esc(inc.gaps.join('، '))}</p>` : ''}</section>
        <section class="card"><h2>خط زمانی</h2>${timelineView(inc, actions)}</section>
      </div>
      ${fixesView(inc)}
      ${verifyView2(inc)}
      ${logs}
      <details class="card details report"><summary>${icon('file')}گزارش حادثه (فارسی)</summary>
        <div class="report-body">${renderText(report.replace(/^#+ (.*)$/gm, '**$1**'))}</div>
        <div class="toolbar"><button class="btn" type="button" id="inc-copy">${icon('copy')}کپی متن</button><button class="btn" type="button" id="inc-download">${icon('download')}دانلود ‎.md‎</button></div>
      </details>`;
    bindIncident(inc, report);
  } catch (err) {
    if (err.message === 'login required') return;
    el.querySelector('.skeleton').outerHTML = failView(err, true);
    el.querySelector('[data-retry]').onclick = () => renderIncident(id);
  }
}

function bindIncident(inc, report) {
  const statusBox = $('#inc-status-box');
  $('#inc-verify')?.addEventListener('click', async () => {
    statusBox.innerHTML = `<div class="op-status"><span class="spin2"></span>در حال اندازه‌گیری دوباره‌ی سایت (چند دور، حدود ۱۵ ثانیه)…</div>`;
    try {
      const r = await (await api('/api/quick', { method: 'POST', body: { tool: 'verify', args: { app: inc.app } } })).json();
      if (r.error) throw new Error(r.error);
      renderIncident(inc.id);
      refreshIncidentBadge();
    } catch (err) {
      statusBox.innerHTML = failView(err);
    }
  });
  $('#inc-rediagnose')?.addEventListener('click', () => diagnoseFromPage(inc.app));
  $('#inc-close')?.addEventListener('click', () => {
    $('#inc-close-row').hidden = false;
    $('#inc-close-reason').focus();
  });
  $('#inc-close-confirm')?.addEventListener('click', async () => {
    const reason = $('#inc-close-reason').value.trim();
    await api(`/api/incidents/${encodeURIComponent(inc.id)}/close`, { method: 'POST', body: { reason } }).catch(() => {});
    toast('حادثه بسته شد.');
    renderIncident(inc.id);
    refreshIncidentBadge();
  });
  incView().querySelectorAll('[data-fix-direct]').forEach((b) => (b.onclick = () => requestAction(b.dataset.fixDirect, { app: inc.app }, $('#inc-action-box'))));
  incView().querySelectorAll('[data-fix-chat]').forEach((b) => {
    b.onclick = () => diagnoseFromPage(inc.app, `برای حادثه‌ی ${inc.id} در ${inc.app}، راه‌حل «${inc.fixes[Number(b.dataset.fixChat)].title}» را اجرا کن (با پیش‌نمایش و تأیید من).`);
  });
  $('#inc-copy')?.addEventListener('click', () => navigator.clipboard.writeText(report).then(() => toast('گزارش کپی شد.')));
  $('#inc-download')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([report], { type: 'text/markdown;charset=utf-8' }));
    a.download = `incident-${inc.app}-${inc.id}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

// ---------- entry ----------

function renderIncidents(id) {
  if (!incView()) return;
  if (id) renderIncident(id);
  else renderIncidentList();
}

window.renderIncidents = renderIncidents;
refreshIncidentBadge();
setInterval(refreshIncidentBadge, 30_000);
if (!$('[data-page="incidents"]').hidden) renderIncidents(location.hash.split('/')[2]);
