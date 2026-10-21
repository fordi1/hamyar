# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary:** a developer who built an app but knows nothing about deployment or operations. They
  write requests in Persian ("put this project on Liara", "my site is slow") and want the platform
  work done for them, with control over anything that costs money or changes the live site.
- **Evaluators:** judges of the Liara agent challenge, who assess the product mainly through a
  ~5-minute demo video. Judging weights: Liara integration 100, problem-solving intelligence 100,
  UX 50, reliability/safety 50.
- Used equally on mobile and desktop: the user checks status and approves actions from a phone as
  well as a laptop.

## Product Purpose

Hamyar is a DevOps + SRE assistant for the Liara PaaS. It deploys a project from a folder (detects
the stack, recommends a plan with price, deploys after one approval), manages releases, env vars,
plans and domains, and when the site is slow or failing it investigates like an SRE: collects logs,
events and CPU/RAM metrics, ranks root causes with numbered evidence, proposes fixes, applies them
only after approval, and verifies with before/after numbers. Success: the user ships and recovers
without learning infrastructure, and always understands what happened and why.

## Positioning

Evidence-first diagnosis (deterministic detectors decide, the model only explains) plus
human-in-the-loop enforced in code (risk tiers, confirm tokens, approval cards, no delete
operations), over Liara's real APIs, in Persian.

## Operating Context

- Chat-first: the user types in Persian; tool steps appear as compact progress rows; changes appear
  as approval cards (what, cost, risk, downtime, undo) with approve / reject-with-reason.
- Live status of the selected app (health, response time, RAM/CPU, release), watch mode while the
  page is open, audit timeline, kill switch.
- The same core also runs as an MCP server inside Claude Code / Cursor (the coding agent).
- Runs locally (127.0.0.1) or on Liara with a dashboard password.

## Capabilities and Constraints

- Persian, RTL, Vazirmatn. Persian digits stay proportional (no tabular figures).
- Must work at 375px with no horizontal overflow; controls ≥ 44px, button labels never wrap.
- Plain HTML/CSS/vanilla JS served by `web/server.ts`; no build step.
- Liara AI may be unavailable; read-only quick actions must still work without it.
- Secret values are typed by the user into the approval card and never shown to the model.
- No deletion of apps, disks, databases or domains.

## Brand Commitments

- Name: همیار (Hamyar). The user asked the dashboard to look as close as possible to the Liara
  console. Hamyar keeps its own name and mark and does not use Liara's logo or claim to be Liara.

## Evidence on Hand

- Real outputs: launch plan for `demo-app`, hypothesis boards from local fault runs
  (`npm run scenario -- <fault>`), 140 passing tests, MCP end-to-end check.
- No customers, testimonials or production metrics exist; do not invent them.

## Product Principles

1. The user is never surprised: every change is previewed with cost, risk and undo before it runs.
2. Show the evidence, not just the answer.
3. Nothing extra on screen: every element helps deploy, understand, decide or recover.
4. Plain Persian first; technical terms once, explained.
5. Honest about limits: say what Hamyar cannot do and what the user must do.
