# Liara Agent Challenge — 300-point readiness

This scorecard maps the judging rubric to behavior that can be demonstrated and tested. It is an
evidence checklist, not a guarantee of the judges' final score.

## 1. Technical performance and Liara integration — 100 / 100 coverage

- Official Liara APIs are used for account data, plans and prices, apps, releases, source upload,
  build logs, environment variables, scaling, restart, domains, DNS, SSL, logs, events, and metrics.
- The deploy wizard accepts a local folder, ZIP, or public GitHub repository; detects the stack and
  port; finds required environment variables; recommends an affordable plan; uploads and deploys;
  follows the build; and reports success only after a live health check.
- Service operations include deploy, restart, on/off, plan resize, rollback, environment variables,
  domain connection, DNS records, and SSL.
- CodeCraft API is configured as an OpenAI-compatible provider with a tool-capable model. The
  preflight check requires a real tool call, not merely a text response.

Demo evidence: complete one live deploy, open the generated URL, then show the release and health
result in Hamyar.

## 2. Intelligence and problem solving — 100 / 100 coverage

- Diagnosis collects logs, events, container state, CPU/RAM, releases, and a live probe.
- Twelve deterministic detectors rank root causes and keep symptoms separate from causes.
- Every conclusion cites numbered evidence; rejected and inconclusive hypotheses stay visible.
- Fixes are ranked by impact and risk. After a fix, Hamyar compares before/after measurements
  against targets chosen before the change.
- Code-related failures carry an exact `file:line` hint and a proposed change. A coding agent using
  Hamyar over MCP edits the source; Hamyar then asks for deploy approval and verifies the result.

Demo evidence: use one reproducible fault such as `missing_env` or `slow`; show evidence, reject or
approve a proposed action, and finish with the verification table.

## 3. User experience — 50 / 50 coverage

- Persian `fa-IR`, true RTL, Vazirmatn, Persian display digits, and LTR isolation for technical
  values.
- Non-technical home actions, a four-step deploy wizard, compact progress rows, clear empty/loading/
  error states, and no raw provider error dumps.
- Approval cards explain the change, cost, risk, downtime, and undo path in plain language.
- The settings page shows the active agent, safety mode, operation limits, API limitations, and the
  emergency stop without revealing secrets.
- Responsive checks cover 320, 360, 390, 375, and 1440 px; screenshot generation fails on horizontal
  overflow.

Demo evidence: show the same approval and incident views once on desktop and once on mobile.

## 4. Reliability, maintainability, and operational security — 50 / 50 coverage

- Health, response time, CPU, RAM, network, disk, release markers, logs, and release history are
  monitored. Watch mode refreshes every 30 seconds while the dashboard is open.
- Repetitive deploy, verification, DNS, environment, and recovery steps are automated and recorded
  as resumable operations.
- Read-only actions run directly; every state/cost action is bound to an exact, expiring, single-use
  approval. Destructive deletion is not implemented.
- Secrets do not enter model context, previews, screenshots, or audit logs. Dashboard authentication,
  same-origin mutation checks, CSP, upload limits, path traversal protection, and login throttling
  are covered by tests.
- Safety limits are enforced across dashboard and MCP: 3 deploys / 10 minutes, 1 restart per app /
  5 minutes, and 10 total changes / hour. Provider `401`, `403`, `404`, `429`, timeout, and `5xx`
  failures become short Persian recovery messages.
- Missing Liara metrics are labelled unavailable instead of being invented.

Demo evidence: show a pending approval, reject it with a reason, approve a new one, then show the
audit trail and emergency stop.

## Before submission

1. Rotate any API key that was pasted into chat, then update only the ignored `.env` file.
2. Run `npm test`, `npm run typecheck`, and `npm run preflight -- <live-app>`.
3. Record at least one real Liara deploy and one fault-to-verification flow.
4. Keep the dashboard password set when deploying Hamyar publicly.
5. State the honest API limitations during the demo; do not claim 24/7 monitoring when the browser
   watch mode is the feature being shown.
