# Hamyar — DevOps + SRE agent for Liara

**Hamyar** (همیار, *helper*) takes a developer with no DevOps knowledge from "I have code" to
"my site is live on my domain" on the [Liara](https://liara.ir) PaaS — and when the site gets slow
or starts failing, it investigates like a Site Reliability Engineer: it reads logs, events and
CPU/RAM metrics, ranks root causes with evidence, proposes fixes, applies them **only after the
user approves**, and proves the result with before/after numbers.

It ships as two front ends over one core:

- **MCP server** for Claude Code, Cursor or Claude Desktop — the coding agent finds the bug with
  Hamyar, fixes the code, and Hamyar redeploys and verifies.
- **Persian web dashboard** (RTL, mobile-first) — chat, approval cards, live status, watch mode.

> Full design: [docs/TECHNICAL.md](docs/TECHNICAL.md)

---

## What it does

| Area | What Hamyar does |
|---|---|
| **First deploy** | Detects the platform exactly like `liara deploy` (ported from the Liara CLI), finds env vars the code reads but are not set, recommends the cheapest *available* plan with enough RAM from the live plan catalogue (with price and reasons), checks the balance, shows one approval card, then creates the app, uploads, follows the build and probes the live URL. |
| **Releases & operations** | Deploy new versions, set env vars (merged, never wiping existing ones), restart, turn on/off, change plan (with monthly price difference), roll back. |
| **Domains** | Connects a domain, tells the user the exact records or IRNIC nameservers to set, checks public DNS until they appear, can run the domain on Liara DNS and create the records itself, then enables SSL. |
| **SRE investigation** | Collects logs, events, container state, CPU/RAM series, release history and a live HTTP probe; runs 12 deterministic detectors; builds a **hypothesis board** (validated / rejected / inconclusive) with numbered evidence (E1, E2…) and a root cause; ranks fixes; writes a Persian incident report. |
| **Fix → verify** | Success targets are fixed *before* a change; afterwards the site is measured again and shown as a before/after table. |
| **Human-in-the-loop** | Risk tiers enforced in code; persistent approval requests that only a human can decide (dashboard, MCP elicitation or an interactive terminal), bound to exact arguments, single use, expiring; rate limits, kill switch, audit log. Deletion is not implemented at all. |

### The 12 detectors

app turned off · missing env var · memory (OOM, leak trend) · CPU at plan limit · bad release ·
slow endpoint and N+1 queries · wrong port · build failure / package registry blocked from Iran ·
disk full · database connection · HTTP 5xx with the code location · crash loop.

The LLM never decides the root cause. It explains the board, citing evidence ids; a cause that
started *after* the incident began is treated as a symptom.

---

## Quick start

Requirements: Node.js ≥ 20, a Liara account.

```bash
cd hamyar
npm install
cp .env.example .env
```

Fill `.env` (never commit it):

| Variable | |
|---|---|
| `LIARA_API_TOKEN` | Liara console → **API** → create key |
| `LIARA_AI_API_KEY` + `LIARA_AI_BASE_URL` | Liara AI key and `https://ai.liara.ir/api/<workspaceID>/v1` — or only `LIARA_AI_WORKSPACE_ID`, and the console token is used |
| `LIARA_AI_MODEL` | e.g. `openai/gpt-4.1` |
| `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL` | any OpenAI-compatible provider when Liara AI is not set, e.g. `https://ai.boxapi.ir/ai/v1` with `openai/gpt-6-sol` (also set `AI_REASONING_EFFORT=none` for that model) |
| `HAMYAR_MODE` | `observe`, `review` (default) or `auto-safe` |
| `HAMYAR_DASHBOARD_PASSWORD` | required when the dashboard runs on a server |

Check the connection (read-only):

```bash
npm run smoke
```

### Use it from Claude Code (MCP)

`hamyar/.mcp.json` registers the server. Open the `hamyar` folder in Claude Code and approve the
`hamyar` server, or add it to any MCP client:

```json
{ "mcpServers": { "hamyar": { "command": "npx", "args": ["tsx", "mcp/server.ts"], "cwd": "/path/to/hamyar" } } }
```

Then just talk: *"deploy ./my-shop to Liara"*, *"my site returns 500, find out why"*.

### Use the web dashboard

```bash
npm run web
```

Open http://localhost:3000. Without a password the dashboard only listens on `127.0.0.1`.
To run it on Liara, deploy this folder as a `node` app with `HAMYAR_DASHBOARD_PASSWORD` set.

### Command-line helpers

```bash
npm run analyze -- ./demo-app broken-shop      # launch plan for a folder (read-only)
npm run diagnose -- broken-shop --path /products   # hypothesis board for a Liara app (read-only)
npm run scenario -- slow                        # run the demo app locally with a fault and diagnose it
npm test                                        # unit tests
```

---

## How the user interacts

**1. First deploy**
> «این پوشه رو روی لیارا بالا بیار»

Hamyar answers with a plan card: platform `node`, port `3000`, `DATABASE_URL` is read in
`server.js:39` but not set, recommended plan `small-g2` (0.5 GB RAM, ~475,000 toman/month) and why,
balance check, proposed `liara.json` with a health check. One click → app created, built, probed:
«سایت شما آنلاین است».

**2. Incident**
> «سایتم کند شده»

```
🎯 Root cause: slow /products because of repeated queries (N+1) — confidence 94%
   + E1 live probe /products: p95 = 3,426 ms
   + E2 /products took > 1 s 24 times in the logs (avg 3,373 ms)
   + E3 one query repeated 500 times with different ids: SELECT * FROM prices WHERE product_id = <n>
🚫 Rejected: bad release (E4: no errors after it) · wrong port (E5: app listens on the expected port)
🛠 Fix: merge the queries into one (JOIN / WHERE id IN) — code change
```
(Real output of `npm run scenario -- slow`, translated. On Liara the board also tests memory and CPU
from the metrics API.)

In Claude Code the coding agent edits the query, Hamyar asks for approval to deploy, then `verify`
shows p95 before/after.

**3. Approval**
Every change shows a card: what will happen, cost difference, risk, expected downtime and how to
undo it — **Approve** or **Reject (with a reason)**. A rejection reason is sent back to the agent so
it proposes something else. For env vars the model only names the key; the user types the value in
a password field and it goes straight to Liara.

---

## Liara integration

All calls use `Authorization: Bearer <token>` against the official APIs
([developers.liara.ir](https://developers.liara.ir)); the client retries reads only and turns every
error into a Persian explanation.

| Capability | Endpoint |
|---|---|
| Account, **plan catalogue with prices**, balance | `GET /v1/me` (`plans.projects`), `GET /v1/billing` |
| Apps | `GET/POST /v1/projects`, `GET /v1/projects/{name}` |
| Deploy | `POST /v2/projects/{name}/sources` (tar.gz) → `POST /v2/projects/{name}/releases` |
| Build progress | `GET /v2/releases/{id}/build-logs` (used by the official CLI) |
| Operations | `.../actions/restart`, `.../actions/scale`, `.../resize`, `POST /v1/projects/update-envs` |
| Observability | `.../logs`, `.../events`, `.../applets`, `.../metrics/{summary,cpu,memory}`, `.../releases` |
| Domains | `GET/POST /v1/domains`, `GET /v1/domains/{id}/check`, `POST /v1/domains/provision-ssl-certs` |
| Liara DNS | `dns-service.liara.ir/api/v1/zones`, `.../zones/{zone}/dns-records` |
| Liara AI | OpenAI-compatible chat completions with tool calling (`ai.liara.ir`) |

Platform detection, default ports, ignore rules and the release body are ported from the official
[Liara CLI](https://github.com/liara-cloud/cli) so Hamyar deploys exactly like `liara deploy`.

---

## Safety model

| Tier | Examples | Behaviour |
|---|---|---|
| T0 read-only | status, logs, metrics, diagnose, verify, domain check | runs automatically |
| T1 low risk | restart, turn on, enable SSL | approval (automatic in `auto-safe` mode) |
| T2 state / cost | deploy, launch, env, plan change, rollback, turn off, domain, DNS | preview + approval, always |
| T3 destructive | delete app / disk / database / domain | **not implemented** — the user does it in the console |

- **Approval requests**: stored on disk and shared by MCP, dashboard and terminal; decided only by a
  human in the dashboard, an MCP elicitation answer, or `npm run approve -- <id>` in an interactive
  terminal. Bound to a salted hash of the exact arguments, single use, 10-minute expiry. The id
  alone never authorizes anything.
- **MCP elicitation**: when the client supports it, the server asks the human directly.
- **Rate limits**: 3 deploys / 10 min, one restart per app / 5 min, 10 changes / hour.
- **Kill switch**: «توقف» revokes every pending and approved-but-unused request.
- **Deploy truth**: success is reported only as VERIFIED_HEALTHY (probe rounds passed and Liara
  serves the new release); otherwise HEALTH_FAILED with the measured reason.
- **Secrets**: `.env` files are never uploaded with the code; env values never reach the model,
  previews or the audit log; log text is redacted (tokens, passwords in URLs, emails, IPs) before the
  model sees it.
- **Audit log**: `audit.jsonl` records previewed / executed / failed / rejected / blocked actions and
  who approved them.
- **Dashboard**: localhost-only without a password; with one (12+ characters): expiring HttpOnly
  session, login rate limit, same-origin JSON-only writes, strict CSP.

---

## Limitations (stated to the user in the product)

- Hamyar cannot charge the Liara account, buy a domain, or log into a registrar such as IRNIC; it
  tells the user exactly what to enter and then verifies it.
- Monitoring runs only while the dashboard is open (watch mode every 30 s) or when asked; it is not a
  24/7 service.
- Without request tracing, causes inside the code are inferred from logs and metrics; every claim
  cites evidence so the user can check it.
- Not in Liara's official OpenAPI spec, verified on first real use: rollback
  (`POST /v2/projects/{name}/releases/{id}/rollback`), build logs, DNS record `contents` format.
- Liara AI's free `base` workspace is documented but rejected by the API (`plan must be one of
  [standard, pro]`, checked 2026-10-21), so Liara AI needs a charged account. Hamyar therefore
  accepts any OpenAI-compatible provider; the demo runs on boxapi.ir (`openai/gpt-6-sol`). Quick
  actions (diagnose, status, logs) work without any AI.

---

## Verification

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 179 passing: detection, env scan, plan advisor, packing, deploy state machine and verification, detectors, RCA board, verify, postmortem, approvals, policy, actions (launch, rollback), operations, dashboard security, agent loop, redaction, domains |
| Real Liara API (read-only) | `/v1/me` (42 plans), `/v1/billing`, `/v1/projects`, Liara DNS zones, Liara AI workspaces |
| MCP end to end (`npm run mcp-smoke`) | request filed → callback before approval not executed → approved with different args blocked → executed → reuse blocked → elicitation "no" audited with reason → elicitation "yes" executed |
| Dashboard | checked in a browser at desktop and 375 px (no horizontal overflow, no wrapped buttons) |

Demo app ("Broken Shop") run locally with real traffic and real logs (`npm run scenario -- <fault>`):

| Fault | Root cause found | Confidence | First fix |
|---|---|---|---|
| `missing_env` | `DATABASE_URL` not set, `server.js:39` | 95% | set env (approval) |
| `slow` | N+1: 500 repeated queries on `/products` | 94% | code fix (not a bigger plan) |
| `bad_release` | new release broken | 82% | roll back to previous release |
| `memory_leak` | memory leak, +192 MB in 4 s | 84% | restart now, bigger plan, fix leak |
| healthy | no problem; all hypotheses rejected with evidence | — | — |

Live runs against a deployed app on Liara are added here after the first deploy.

---

## Project layout

```
core/            Liara client, detection, env scan, plan advisor, packer, deployer,
                 policy (tiers, rate limits, audit), approvals, operations, actions, domain logic, agent loop, shared ops
core/sre/        snapshot collector, log clustering, detectors, RCA board, verify, postmortem
mcp/server.ts    MCP server (21 tools)
web/             dashboard server and RTL UI
demo-app/        Broken Shop with switchable faults (FAULT=memory_leak|slow|bad_release)
scripts/         smoke test, analyze, diagnose, local scenarios, MCP end-to-end check
docs/            technical design
```
