---
version: 1
slug: "web-public-index-html"
primary_target: "web/public/index.html"
related_targets: ["web/public/style.css","web/public/app.js"]
---

# Surface: Hamyar dashboard (web/public)

Mode: Operate. Audience: a developer with no DevOps knowledge, on desktop and phone equally; judges watch it in the demo video. Task: ask in Persian, follow the work, decide on changes, see proof. Constraints: RTL, Vazirmatn, 375px, controls ≥44px, labels never wrap, Persian digits proportional, no build step, works without AI via quick actions.

Direction source: pinned by the user ("as close as possible to the Liara console"), so the concept roll was not run; the pinned world beats the roll. Code-led (no image generation available).

## Direction contract

THESIS: The Liara console the user already knows, with an engineer inside it. Conversation is the command line and the app's live state is one glance away. Refuses the generic chatbot bubble page and the KPI-card dashboard.

OWN-WORLD: Liara console grammar measured from console.liara.ir: ground #181818, panels #1f2027, cards #2A2C36 radius 12 with hairline #33353f, mint #87FCC4 for selected/active, the mint→sky gradient (#87FCC4→#28C1F5, dark text, radius 8) only on the primary action, round green status pill, numbered step circles with mint ring, Vazirmatn, one 1.6px-stroke SVG icon set.

STORY: The user sees whether the app is healthy, asks in plain Persian, watches each step run as a pipeline, decides on approval cards that show cost, risk and undo, and leaves with numbers proving the fix.

FIRST VIEWPORT: Desktop: 64px top bar (mark and name at the start; app switcher, status pill, balance, mode; stop at the end). Main area: conversation column (start side, max 760px) and a 340px app rail (health, response time, RAM and CPU charts against the plan limit, release, watch toggle, activity). Empty conversation: greeting, large composer, four task tiles. Mobile: compact bar, chat/status segmented control, composer docked at the bottom.

FORM: Liara console interface language (pinned; no ordered list, no seed key — roll not run because the direction is user-pinned). Signature interaction: the live pipeline run card — each agent turn's tool calls become step rows that tick in with elapsed time and a progress bar for deploy phases; the diagnose step expands into a hypothesis board with a confidence bar, evidence chips and folded rejected causes.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
