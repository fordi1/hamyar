// Domain assistant (screen F): connect a domain, show exactly what to set at the registrar
// with copy buttons, check public DNS for real, and enable SSL. Steps that change Liara go
// through the approval card; steps at the registrar are marked as the user's to do.
'use strict';

const domView = () => $('#domains-view');
const STEP_BUTTON = {
  add: ['add_domain', 'اتصال دامنه به برنامه'],
  zone: ['use_liara_dns', 'ساخت ناحیه در DNS لیارا'],
  'dns-records': ['create_dns_records', 'ساخت رکوردها در DNS لیارا'],
  ssl: ['enable_ssl', 'فعال‌سازی SSL'],
};
const methodKey = (domain) => `hamyar_domain_method_${domain}`;
const savedMethod = (domain) => {
  try {
    return localStorage.getItem(methodKey(domain)) || '';
  } catch {
    return '';
  }
};
const saveMethod = (domain, method) => {
  try {
    localStorage.setItem(methodKey(domain), method);
  } catch {}
};

function copyField(label, value) {
  return `<div class="field"><label>${esc(label)}</label><div class="copy-row"><code class="copy-value">${esc(value)}</code><button class="btn" type="button" data-copy="${esc(value)}" aria-label="کپی ${esc(label)}">${icon('copy')}کپی</button></div></div>`;
}

// ---------- app picker, existing domains, connect form ----------

async function renderDomainHome(app) {
  const el = domView();
  el.innerHTML = `<div class="page-head"><h1>دامنه و DNS</h1><p>دامنه‌ی خودتان را به برنامه وصل کنید؛ همیار دقیقاً می‌گوید در پنل دامنه چه وارد کنید و بعد از اینترنت بررسی می‌کند.</p></div>${loadingView()}`;
  const slot = el.querySelector('.skeleton');
  try {
    const { apps } = await getJson('/api/apps');
    if (!slot.isConnected) return;
    if (!apps.length) {
      slot.outerHTML = `<div class="card empty-card">${mascot('')}<b>اول یک برنامه روی لیارا لازم است</b><span class="muted">دامنه به یک برنامه وصل می‌شود.</span><a class="btn primary" href="#/deploy">${icon('rocket')}دیپلوی پروژه</a></div>`;
      return;
    }
    app = app && apps.some((a) => a.name === app) ? app : apps.find((a) => a.name === state.app)?.name || apps[0].name;
    const domains = await getJson(`/api/apps/${encodeURIComponent(app)}/domains`).catch((err) => ({ error: err.message }));
    if (!slot.isConnected) return;
    const picker = apps.length > 1 ? `<label class="field"><span>برنامه</span><select id="dom-app">${apps.map((a) => `<option value="${esc(a.name)}"${a.name === app ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : '';
    const existing = domains.error
      ? failView(new Error(domains.error))
      : domains.length
        ? `<section class="card"><h2>دامنه‌های ${esc(app)}</h2>${domains
            .map((d) => `<a class="inc-row" href="#/domains/${encodeURIComponent(app)}/${encodeURIComponent(d.name)}"><span class="inc-main"><b><bdi>${esc(d.name)}</bdi></b><small>وضعیت لیارا: ${esc(d.status || '—')}</small></span><span class="inc-tags"><span class="pill" data-state="${d.ssl === 'ACTIVE' ? 'ok' : 'off'}"><span class="dot"></span>${d.ssl === 'ACTIVE' ? 'https فعال' : 'بدون SSL'}</span></span></a>`)
            .join('')}</section>`
        : '';
    slot.outerHTML = `${picker}${existing}
      <form class="card form" id="dom-form" novalidate>
        <h2>اتصال دامنه‌ی جدید</h2>
        <div class="field"><label for="dom-name">دامنه</label><input id="dom-name" class="ltr" placeholder="shop.ir یا www.shop.com" autocomplete="off" spellcheck="false"></div>
        <div class="sources dom-methods" role="radiogroup" aria-label="دامنه کجاست؟">
          <button type="button" class="source" role="radio" aria-checked="true" data-method="liara-dns"><span class="sicon">${icon('globe')}</span><b>دامنه‌ام در ایرنیک است</b><span>نیم‌سرورها را به DNS لیارا می‌دهیم؛ رکوردها را همیار می‌سازد</span></button>
          <button type="button" class="source" role="radio" aria-checked="false" data-method="records"><span class="sicon">${icon('server')}</span><b>دامنه در سرویس دیگری است</b><span>رکورد CNAME یا ALIAS را خودتان در پنل آن سرویس ثبت می‌کنید</span></button>
          <button type="button" class="source" role="radio" aria-checked="false" data-method="none"><span class="sicon">${icon('link')}</span><b>فعلاً دامنه نمی‌خواهم</b><span>از آدرس <bdi>${esc(app)}.liara.run</bdi> استفاده کنید</span></button>
        </div>
        <div id="dom-error"></div>
        <div class="wizard-actions"><button class="btn primary end" type="submit">ادامه ${icon('send')}</button></div>
      </form>`;
    $('#dom-app')?.addEventListener('change', (e) => (location.hash = `#/domains/${encodeURIComponent(e.target.value)}`));
    let method = 'liara-dns';
    domView().querySelectorAll('[data-method]').forEach((b) =>
      b.addEventListener('click', () => {
        method = b.dataset.method;
        domView().querySelectorAll('[data-method]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      }),
    );
    $('#dom-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (method === 'none') {
        location.hash = `#/apps/${encodeURIComponent(app)}`;
        return toast(`سایت شما روی https://${app}.liara.run در دسترس است.`);
      }
      const domain = $('#dom-name').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!/^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain)) {
        $('#dom-error').innerHTML = `<p class="form-error">${icon('alert')}<span>نام دامنه را مثل shop.ir یا www.shop.com بنویسید.</span></p>`;
        return $('#dom-name').focus();
      }
      saveMethod(domain, method);
      location.hash = `#/domains/${encodeURIComponent(app)}/${encodeURIComponent(domain)}`;
    });
  } catch (err) {
    if (err.message === 'login required' || !slot.isConnected) return;
    slot.outerHTML = failView(err, true);
    domView().querySelector('[data-retry]').onclick = () => renderDomainHome(app);
  }
}

// ---------- one domain: steps, values to copy, live check ----------

function stepRow(s, i) {
  const mark = s.state === 'done' ? icon('check') : s.state === 'manual' ? icon('alert') : fa(i + 1);
  const cls = s.state === 'done' ? 'done' : s.state === 'current' ? 'run' : s.state === 'manual' ? 'wait' : '';
  const tag = s.state === 'manual' ? '<span class="chip-i warn">این مرحله را خودتان انجام دهید</span>' : s.state === 'current' ? '<span class="chip-i">مرحله‌ی بعد</span>' : '';
  return `<li class="${cls}"><span class="st">${mark}</span><span><b>${esc(s.title)}</b>${tag}${s.detail && s.state === 'manual' ? `<small>${esc(s.detail)}</small>` : ''}</span><span></span></li>`;
}

function manualPanel(s) {
  const current = s.steps.find((x) => x.state === 'manual');
  if (!current) return '';
  if (current.key === 'ns') {
    return `<section class="card form"><h2>${esc(current.title)}</h2>
      <p class="note-sm">${bidi(s.registrar)}</p>
      ${s.liaraDns.nameServers.map((ns, i) => copyField(`نیم‌سرور ${fa(i + 1)}`, ns)).join('')}
      <p class="note-sm">نیم‌سرورهایی که الان اینترنت می‌بیند: <bdi>${esc(s.nameservers.join('، ') || 'پیدا نشد')}</bdi></p>
      <p class="note-sm">بعد از ثبت، از چند دقیقه تا ۲۴ ساعت طول می‌کشد. «بررسی اتصال» را بزنید؛ همیار وقتی نیم‌سرورهای لیارا دیده شوند ادامه می‌دهد.</p></section>`;
  }
  return `<section class="card form"><h2>${esc(current.title)}</h2>
    <p class="note-sm">${bidi(s.registrar)}</p>
    ${s.records
      .map((r) => `<div class="record ${r.visible ? 'ok' : ''}"><div class="record-head"><span class="chip-i">${esc(r.type)}</span><b>${esc(r.purpose)}</b><span class="chip-i ${r.visible ? 'ok' : 'warn'}">${r.visible ? 'روی اینترنت دیده می‌شود' : 'هنوز دیده نمی‌شود'}</span></div>
        ${copyField('نام (Host)', r.name)}${copyField('مقدار (Value)', r.value)}
        ${!r.visible && r.found.length ? `<p class="note-sm">الان اینترنت این را می‌بیند: <bdi>${esc(r.found.join('، '))}</bdi></p>` : ''}</div>`)
      .join('')}</section>`;
}

async function renderDomain(app, domain) {
  const el = domView();
  el.innerHTML = `<a class="btn ghost back" href="#/domains/${encodeURIComponent(app)}">${icon('undo')}دامنه‌های ${esc(app)}</a>${loadingView()}`;
  const slot = el.querySelector('.skeleton');
  try {
    const method = savedMethod(domain);
    const s = await getJson(`/api/apps/${encodeURIComponent(app)}/domain?d=${encodeURIComponent(domain)}${method ? `&method=${method}` : ''}`);
    if (!slot.isConnected) return;
    const next = s.next && STEP_BUTTON[s.steps.find((x) => x.state === 'current')?.key];
    const other = s.method === 'records' ? 'liara-dns' : 'records';
    const canSwitch = !s.liaraDns;
    slot.outerHTML = `
      <div class="app-header">
        <div><h1 class="inc-title"><bdi>${esc(domain)}</bdi></h1><p class="note-sm">برنامه: <a href="#/apps/${encodeURIComponent(app)}"><bdi>${esc(app)}</bdi></a> · روش: ${s.method === 'liara-dns' ? 'DNS لیارا' : 'رکورد در پنل دامنه'} · وضعیت در لیارا: ${esc(s.liaraStatus || 'هنوز اضافه نشده')}</p></div>
        <div class="inc-tags"><span class="pill" data-state="${s.ready ? 'ok' : 'off'}"><span class="dot"></span>${s.ready ? 'آماده با https' : 'در حال راه‌اندازی'}</span></div>
      </div>
      ${s.ready ? `<div class="op-status ok">${icon('check')}دامنه وصل است و https فعال است: <a href="https://${esc(domain)}" target="_blank" rel="noopener"><bdi>https://${esc(domain)}</bdi></a></div>` : ''}
      <div class="inc-grid">
        <section class="card"><h2>مراحل</h2><ol class="tl dom-steps">${s.steps.map(stepRow).join('')}</ol>
          <div class="toolbar">
            ${next ? `<button class="btn primary" type="button" id="dom-next">${esc(next[1])}</button>` : ''}
            <button class="btn" type="button" id="dom-check">${icon('refresh')}بررسی اتصال</button>
          </div>
          <p class="note-sm">آخرین بررسی DNS عمومی (1.1.1.1 و 8.8.8.8): ${clock()}</p>
          <div id="dom-action-box" class="stack"></div>
        </section>
        <div class="stack">
          ${manualPanel(s)}
          ${s.notes.map((n) => `<p class="form-warn">${icon('alert')}<span>${bidi(n)}</span></p>`).join('')}
          ${canSwitch ? `<button class="btn ghost" type="button" id="dom-switch">${other === 'liara-dns' ? 'به‌جایش از DNS لیارا استفاده کن' : 'رکوردها را خودم در پنل دامنه ثبت می‌کنم'}</button>` : ''}
        </div>
      </div>`;
    $('#dom-check').onclick = () => renderDomain(app, domain);
    $('#dom-switch')?.addEventListener('click', () => {
      saveMethod(domain, other);
      renderDomain(app, domain);
    });
    $('#dom-next')?.addEventListener('click', () => requestAction(next[0], { app, domain }, $('#dom-action-box'), () => setTimeout(() => renderDomain(app, domain), 1500)));
    domView().querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('کپی شد.'))));
  } catch (err) {
    if (err.message === 'login required' || !slot.isConnected) return;
    slot.outerHTML = failView(err, true);
    domView().querySelector('[data-retry]').onclick = () => renderDomain(app, domain);
  }
}

// ---------- entry ----------

function renderDomains(app, domain) {
  if (!domView()) return;
  if (app && domain) renderDomain(app, domain);
  else renderDomainHome(app);
}

window.renderDomains = renderDomains;
if (!$('[data-page="domains"]').hidden) {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  renderDomains(parts[1], parts[2]);
}
