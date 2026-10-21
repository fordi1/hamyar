# Demo video script (about 5 minutes)

Goal: show every judging criterion with a real app on Liara, in Persian, without showing source code.

| Criterion | Points | Where it is shown |
|---|---|---|
| Liara integration (deploy, management, infra ops) | 100 | Scenes 1, 3, 4, 5 |
| Intelligence (logs, diagnosis, causes, fix, verify) | 100 | Scenes 2, 3, 4 |
| UX (simple, clear, status, approvals) | 50 | every scene: chat, cards, status panel |
| Reliability and safety (monitoring, approvals, limits) | 50 | Scenes 2, 5 |

App name below: `hamyar-shop` (Liara app names are global; `broken-shop` is already answering on
`liara.run`, so pick a free name and use it everywhere).

---

## Before recording (not in the video)

```bash
cd hamyar
npm run preflight -- hamyar-shop     # everything must be ✅ except the scene-specific warnings
npm run web                          # dashboard on http://localhost:3000
```

The dashboard runs on your computer, so the agent can read `demo-app` from disk for Scene 1.

1. Account charged; Liara AI configured (`npm run preflight` shows "Liara AI answers ✅").
2. Do **not** create `hamyar-shop` yet — Scene 1 creates it live. Do one dry run on another name
   first (`hamyar-test`) to see build time, then turn that app off in the console.
3. Browser zoom 125%, dark or light theme fixed, close other tabs, notifications off.
4. Screen recorder at 1080p (OBS or Windows `Win+Alt+R`), microphone tested.
5. Open Claude Code in the `hamyar` folder and approve the `hamyar` MCP server once.

---

## Scene 0 — Intro (0:00–0:20)

Screen: dashboard home.

> «سلام. من [نام] هستم و این «همیار» است: یک همکار DevOps و SRE برای لیارا. برنامه‌نویسی که هیچ‌چیز از دیپلوی نمی‌داند، فقط با چت پروژه‌اش را بالا می‌آورد، و وقتی سایت کند شد یا خطا داد، همیار مثل یک مهندس SRE علت را با شاهد پیدا می‌کند، راه‌حل می‌دهد و فقط با اجازه‌ی خودش اجرا می‌کند.»

## Scene 1 — First deploy from zero (0:20–1:20) · Liara integration, UX

Type in the dashboard chat:
> «پوشه‌ی demo-app رو با اسم hamyar-shop روی لیارا بالا بیار»

Point at, in order:
1. The plan card from `analyze_project`: platform `node` and **why**, port, «`DATABASE_URL` لازم است ← server.js:39», recommended plan `small-g2` with monthly price and reason, balance check.
2. The approval card (cost, risk, rollback path) → **تأیید و اجرا**.
3. Live progress: packing → upload → build → deploy → probe → URL.

> «همیار نوع پروژه را دقیقاً با همان قواعد CLI خود لیارا تشخیص داد، از کاتالوگ زنده‌ی پلن‌های لیارا ارزان‌ترین پلنی را که رم کافی دارد با قیمت و دلیل پیشنهاد داد، و تا من تأیید نکردم هیچ پولی خرج نشد.»

If the build is slow, cut the waiting part in editing.

## Scene 2 — Error 500, missing env var (1:20–2:10) · Intelligence, safety

The app from Scene 1 has no `DATABASE_URL`, so it already returns 500. In the status panel turn on
**پایش خودکار**; the red bar appears. Click **بررسی کن**.

Point at:
1. Tool rows: «بررسی علت مشکل ✓».
2. The board: root cause «متغیر محیطی DATABASE_URL تنظیم نشده» with **E1** (log line) and **E2** (code line), the 500s marked as a **symptom**, rejected hypotheses with evidence.
3. The approval card with a **password field**: type the value (any demo value).

> «مقدار رمز را خودم در کارت وارد می‌کنم؛ این مقدار مستقیم به لیارا می‌رود و هیچ‌وقت به هوش مصنوعی داده نمی‌شود.»

4. After approval: `verify` table — موفق ۰٪ → ۱۰۰٪.

Fallback without AI: the same flow with the **🔥 خطای ۵۰۰** chip (runs diagnose directly).

## Scene 3 — Slow site, N+1, fixed by the coding agent (2:10–3:10) · Intelligence, integration

Before the scene: `npm run demo -- fault hamyar-shop slow` and `npm run demo -- load hamyar-shop 3 120`.

In **Claude Code** (MCP):
> «سایت hamyar-shop کند شده، علتش رو پیدا کن و درستش کن»

Point at:
1. `diagnose` board: root cause N+1 on `/products`, «یک کوئری ۵۰۰ بار تکرار شده», memory and CPU **rejected** with numbers → «پلن گران‌تر لازم نیست».
2. Claude Code edits the query in `server.js` (show the diff only briefly, not the code itself).
3. `deploy` → the **approval dialog from the MCP server** (elicitation) → approve.
4. `verify`: p95 before/after.

> «همیار علت را پیدا کرد، Coding Agent کد را درست کرد، و همیار نسخه‌ی جدید را با اجازه‌ی من منتشر کرد و با عدد نشان داد که درست شده.»

After the scene: `npm run demo -- fault hamyar-shop none`.

## Scene 4 — Bad release and rollback, plus a rejection (3:10–3:55) · Intelligence, UX, safety

Before the scene: `npm run demo -- bad-release hamyar-shop` (a real new release with a bug).

In the dashboard:
> «بعد از آپدیت آخر سایت خراب شده»

Point at:
1. Board: «نسخه‌ی جدید خراب است» — errors started N minutes after the release, none before.
2. First the agent may offer a bigger plan or restart → click **رد** and type a reason:
   «مشکل از نسخه‌ی جدید است، پول بیشتر نمی‌دهم» → the agent adapts and offers rollback.
3. Rollback card → approve → `verify` → healthy.

> «هر پیشنهادی را می‌توانم رد کنم و دلیلم را بگویم؛ همیار راه دیگری پیشنهاد می‌دهد.»

Rehearse this scene once before recording: the rollback endpoint is not in Liara's official spec.
If it fails in rehearsal, record the scene with the agent's second fix instead («رفع باگ و دیپلوی
دوباره»: Claude Code reverts the change and `deploy`), or run `npm run demo -- good-release
hamyar-shop` off camera, and say on camera that rollback is a documented limitation.

## Scene 5 — Safety, limits and domain (3:55–4:40) · Safety, integration

1. Chat: «برنامه رو کامل حذف کن» → Hamyar refuses: deletion does not exist by design.
2. Show **آخرین عملیات** timeline: who approved what, rejected actions included.
3. Click **⏹ توقف** while a card is open → «همه‌ی تأییدهای در انتظار لغو شد».
4. Chat: «می‌خوام دامنه‌ی myshop.ir رو وصل کنم» → steps: add_domain, Liara DNS with the two nameservers for **ایرنیک**, then SSL.
5. Show the **محدودیت‌ها** card.

> «همیار کارهایی را که از دسترسش خارج است — شارژ حساب، ثبت NS در ایرنیک — دقیق به من می‌گوید و بعد خودش بررسی می‌کند. حذف کردن عمداً وجود ندارد و هر عملیات در لاگ ثبت می‌شود.»

## Scene 6 — Report and wrap-up (4:40–5:00)

Chat: «گزارش حادثه رو آماده کن» → the Persian incident report (root cause, evidence, timeline,
approvals, before/after table).

> «همیار یعنی: دیپلوی با یک جمله، پیدا کردن علت با شاهد، اصلاح فقط با اجازه، و اثبات با عدد. ۲۱ ابزار MCP، ۱۲ تشخیص‌دهنده، ۱۴۰ تست. ممنون.»

---

## Optional bonus (if time allows, or for a longer cut)

Memory leak: `npm run demo -- fault hamyar-shop memory_leak` + `npm run demo -- load hamyar-shop 5 90`
→ «سایت کند و قطع‌ووصل شده» → board shows the RAM growth trend and OOM event → restart now
(T1) and upgrade card with the monthly price difference.

## After recording

```bash
npm run demo -- fault hamyar-shop none
```

Turn the demo apps off in the console when you are done, so they stop costing money.
