---
name: Hamyar
description: Persian DevOps and SRE assistant for Liara, dressed in the Liara console's own dark grammar.
colors:
  ground: "#181818"
  topbar-ground: "#1c1c1c"
  panel: "#1f2027"
  card: "#2a2c36"
  card-raised: "#32343f"
  hairline: "#33353f"
  hairline-strong: "#40424e"
  text: "#ffffff"
  text-secondary: "#c3c6cf"
  text-muted: "#9a9eab"
  mint: "#87fcc4"
  sky: "#28c1f5"
  mint-soft: "rgba(135, 252, 196, 0.13)"
  ok: "#57b36a"
  ok-soft: "rgba(87, 179, 106, 0.14)"
  warn: "#f5b54a"
  warn-soft: "rgba(245, 181, 74, 0.13)"
  danger: "#ff6b7a"
  danger-soft: "rgba(255, 107, 122, 0.13)"
  on-danger-soft: "#ffd3d8"
  on-ok-soft: "#cfe9d4"
  on-brand: "#181818"
typography:
  display:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.5
  headline:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.5
  title:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "15.5px"
    fontWeight: 600
    lineHeight: 1.6
  body:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.75
  body-sm:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.75
  caption:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
  micro:
    fontFamily: "Vazirmatn, Tahoma, sans-serif"
    fontSize: "11.5px"
    fontWeight: 700
    lineHeight: 1.8
rounded:
  inline: "5px"
  sm: "8px"
  mark: "10px"
  md: "12px"
  composer: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  card: "14px"
  lg: "16px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "44px"
  button-hover:
    backgroundColor: "{colors.card-raised}"
  button-primary:
    textColor: "{colors.on-brand}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "44px"
  button-danger:
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "44px"
  button-danger-hover:
    backgroundColor: "{colors.danger-soft}"
  status-pill:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
    height: "44px"
  status-pill-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.on-ok-soft}"
  status-pill-bad:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.on-danger-soft}"
  chip:
    textColor: "{colors.text-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 4px"
    height: "44px"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
  run-card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    height: "44px"
  composer:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.composer}"
    padding: "10px"
  task-tile:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.md}"
    padding: "14px"
    height: "72px"
  segmented-tab-active:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "7px"
    height: "44px"
---

# Design System: Hamyar

## Overview

**Creative North Star: "The Console With an Engineer Inside"**

Hamyar wears the Liara console's grammar, measured from console.liara.ir, so the user feels at home before reading a word: a near-black ground, blue-grey panels and cards separated by hairlines, mint for whatever is selected or alive, and the mint-to-sky gradient kept for the one action that moves things forward. The engineer inside shows up as conversation plus a live pipeline. Each agent turn becomes a run card whose steps tick in with elapsed time, and changes stop at an approval card that shows cost, risk and undo.

The system is dense but calm. Depth comes from tone (ground, panel, card, raised card), not from shadow. Colour carries state and rarely decorates: mint means done or selected, amber means waiting for you, coral means broken, sky marks low-risk and informational things. Everything is right-to-left Persian in Vazirmatn, dark only, and built mobile-first at 375px.

Hamyar keeps its own name and mark (a Card Slate tile with a mint check stroke). It never uses Liara's logo or claims to be Liara.

**Key Characteristics:**
- Dark only (`color-scheme: dark`), four tonal layers, 1px hairline borders.
- Mint as the single "alive / selected" signal; the brand gradient on the primary action only.
- Vazirmatn 400 to 700, body at 15px / 1.75, proportional Persian digits everywhere.
- One SVG icon set with a 1.6px round stroke; no icon fonts and no text glyphs used as icons.
- Every control is at least 44px tall and its label never wraps.
- Motion is short and settles with a single expo-out ease (`cubic-bezier(0.16, 1, 0.3, 1)`), and stops entirely under reduced motion.

## Colors

A near-neutral dark ground with blue-tinted surfaces, one cool mint signal, and a small set of soft-tinted state colours.

### Primary
- **Console Mint** (`mint`): the "alive / selected / done" colour. Used for links, the focus ring, the caret, text selection, completed step circles, tile icons, the confidence percentage, the approved result, the switch-on thumb and the RAM chart line. It never fills large areas; its soft tint (`mint-soft`) carries done states and evidence IDs.
- **Liara Gradient** (`linear-gradient(92deg, #87fcc4 0%, #28c1f5 98.77%)`, CSS `--brand`): the primary button fill (with dark `on-brand` text) and nothing else; progress and confidence fills are solid mint. This is a CSS gradient, not a colour token.

### Secondary
- **Signal Sky** (`sky`): low-risk / informational. Used for tier-1 approval borders, badges and icons, code-location icons, and the CPU chart line.

### Tertiary (state colours)
- **Healthy Green** (`ok`, with `ok-soft`): only the healthy status pill dot and the "healthy" verdict icon.
- **Waiting Amber** (`warn`, with `warn-soft`): approval cards that need a decision, waiting step circles, "off" status dot, tags and rejected timeline dots.
- **Fault Coral** (`danger`, with `danger-soft`, text `on-danger-soft`): failures, the stop and danger buttons, alert banners, chart plan-limit lines, bad stats.

### Neutral
- **Console Ground** (`ground`): page background, input wells, code/output wells inside step details.
- **Header Ground** (`topbar-ground`): the sticky top bar, which is opaque so scrolled content never shows through.
- **Panel Slate** (`panel`): run cards, the composer, the segmented control, login card, stat and fact tiles.
- **Card Slate** (`card`): rail cards, task tiles, user messages, approval cards, default buttons.
- **Raised Slate** (`card-raised`): button hover, the toast, inline code, the switch track.
- **Hairline** (`hairline`) and **Strong Hairline** (`hairline-strong`): 1px dividers and borders; the strong one goes on buttons, inputs and inactive state rings.
- **Text** (`text`), **Secondary Text** (`text-secondary`), **Muted Text** (`text-muted`): primary copy, supporting copy, then meta, labels, timestamps and placeholders.

### Named Rules
**The One Signal Rule.** Mint means selected, active or done, and nothing else. A mint element that is not in one of those states is a bug.

**The Gradient Earns Its Place Rule.** The Liara gradient goes only on the primary action. Never on text, borders, cards or backgrounds.

**The State Speaks in Tint Rule.** State containers use the soft tint background plus a lighter on-tint text or a 0.35 to 0.45 alpha border of the state colour. Never a saturated solid fill.

## Typography

**Display Font:** Vazirmatn (with Tahoma, sans-serif)
**Body Font:** Vazirmatn (same family; loaded weights 400, 500, 600, 700)

**Character:** One humanist Persian family carries every role, as in the Liara console. Hierarchy comes from weight and small size steps, not from a second face.

### Hierarchy
- **Display** (600, 26px, 1.5): the empty-conversation greeting only.
- **Headline** (700, 18px): the brand name in the top bar; the selected app name in the rail uses 700 at 17px.
- **Title** (600, 15.5px, 1.6): the approval card question and the leading root-cause title on the hypothesis board.
- **Body** (400, 15px, 1.75): conversation and general copy. The welcome paragraph is capped at 62ch.
- **Body Small** (400, 13px): run heads, evidence lines, chips, pills, tables, facts, meta lists, the timeline.
- **Label** (600, 14px): buttons, switch labels, rail card headings.
- **Caption** (400, 12.5px, 1.6): tile subtitles, step summaries, step times, chart heads, board sub-headings.
- **Micro** (700, 11.5px, 1.8): evidence IDs and tier tags.

### Named Rules
**The Proportional Digits Rule.** Persian numbers (prices, times, percentages, counters) use proportional figures. Never set `tabular-nums` or `font-variant-numeric: tabular-nums`. The only allowed exception is a grid that truly needs vertical column alignment, scoped to that element alone.

**The Isolated Latin Rule.** URLs, code, evidence IDs and file paths sit in an LTR, bidi-isolated span (`direction: ltr; unicode-bidi: isolate`) inside the RTL flow.

## Layout

Mobile-first, one column. Below 960px the top bar is one row: the mark (no name), the app switcher carrying a status dot, and an icon-only stop button; the status pill and the balance and mode chips are hidden. The document is the only scroller. A two-tab segmented control (conversation / app status) switches between the panels, and the composer stays sticky 12px above the bottom. At 960px and up, the segmented control goes away and the layout becomes the conversation column (thread and composer centred, max 760px) beside a 340px scrolling status rail, with a 24px gap under the 64px sticky top bar. Below 480px the send button drops its label and shows only the icon.

Spacing runs in small steps (4, 6, 8, 10, 12, 14, 16, 20, 24). Cards pad 14px 16px, rows pad 10px 14px, and the thread stacks items 14px apart. Toolbars and action rows use `flex-wrap` with `align-items: stretch`: the growing element (the app switcher, the secret field) takes `flex: 1 1 <basis>` and buttons keep their content width. Grids of tiles and facts use `repeat(auto-fit, minmax(170px | 150px, 1fr))`.

### Named Rules
**The One Row Toolbar Rule.** Toolbar and action rows are `flex flex-wrap items-stretch`. Never a rigid grid that forces one child full-width and leaves a half-width button stranded. Check every such row with 1, 2 and 3 controls at 375px.

**The 44px Floor Rule.** Every interactive control (buttons, pill, chips, app switcher, segmented tabs, inputs, the composer field, switches) is at least 44px tall, and controls in one row share a height. Nothing interactive goes below this, including disclosure summaries and banner buttons.

## Elevation & Depth

Depth is tonal. Ground (#181818) sits under panel, then card, then raised card, with 1px hairlines doing the separating. Shadows appear in exactly two places: a faint lift under the sticky top bar, and an ambient shadow under the floating toast. Status dots use a soft halo ring (a spread box-shadow) as a state signal, not as elevation. The login overlay dims the page with a 72% near-black scrim and a 6px backdrop blur.

### Shadow Vocabulary
- **Header lift** (`box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1)`): the sticky top bar only.
- **Floating ambient** (`box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1), 0 10px 30px rgba(0, 0, 0, 0.22)`, CSS `--shadow`): the toast, the only floating element.
- **Status halo** (`box-shadow: 0 0 0 4px rgba(87, 179, 106, 0.18)`): the healthy pill dot; the failing dot pulses with a coral halo instead.

### Named Rules
**The Tone Before Shadow Rule.** To lift a surface, step it up one tonal layer and give it a hairline. Shadows are kept for things that float above the scroll (the sticky bar and the toast).

## Shapes

Soft, consistent corners: 12px on cards, run cards, tiles, approval cards and alerts; 8px on buttons, inputs, chips, the app switcher, stat/fact tiles and output wells; 10px on the brand mark, the segmented track and the toast; 14px on the composer and the large mark; 5px on inline code, evidence IDs and tags; fully round on the status pill, badges, the switch and step/status circles. User messages keep 12px corners except one tighter 4px corner on the leading-bottom side, like a speech tail. A decided approval card switches its border to dashed so it reads as a settled record. Borders are always 1px (step state rings are 1.5px).

## Components

### Buttons
Firm and quiet; the gradient marks the one action that moves the work forward.
- **Shape:** gently rounded (8px), at least 44px tall, `0 18px` padding, label 600 at 14px, `white-space: nowrap`, icon and label 8px apart.
- **Default:** Card Slate fill, Strong Hairline border; hover steps up to Raised Slate; press nudges 1px down.
- **Primary:** Liara gradient fill, no border, dark text at 700; hover brightens by 6%. Used for send, login and approve.
- **Danger / Stop:** transparent with coral text and a 0.4 to 0.45 alpha coral border; hover fills with `danger-soft`. The stop button sits at the end of the top bar.
- **Ghost:** transparent with a Strong Hairline border.
- **Disabled:** 50% opacity, not-allowed cursor.
- **Focus:** the global 2px mint outline at 2px offset.

### Status Pill and Chips
- **Pill:** fully round, at least 44px, 13px text, an 8px dot. Healthy has an `ok-soft` fill with a green dot and halo; failing has a `danger-soft` fill with a pulsing coral dot; off has an amber dot; unknown has a muted dot on Card Slate.
- **Chip:** 8px corners, hairline outline with no fill, a 16px muted icon and 13px secondary text; used for account balance and review mode.
- **Badge:** fully round, 12px, `warn-soft` fill with amber text (sky for tier 1).

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** Card Slate for rail cards, approval cards and tiles; Panel Slate for run cards, the composer and nested stat/fact tiles.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** rail cards and tiles use a border in their own fill colour (invisible at rest, so hover can colour it in without the size shifting); run cards and the composer use a hairline; approval cards use a 0.45 alpha amber border, or sky for tier 1.
- **Internal Padding:** 14px 16px.

### Inputs / Fields
- **Style:** Console Ground well, Strong Hairline border, 8px corners, `10px 12px` padding, at least 44px tall, mint caret, muted placeholder.
- **Focus:** the border turns mint; the composer's border turns 0.5 alpha mint when focus is inside it.
- **Label:** 13px secondary text above the field, 6px gap.

### Navigation
- **Top bar:** 64px sticky, opaque Header Ground, a hairline below it and the header lift shadow. The brand mark (34px Card Slate tile with a mint check) and name sit at the start, the controls row in the middle, the stop button at the end.
- **App switcher:** a Card Slate box at least 44px tall with a server icon, a 600-weight select and a chevron; its border turns mint on focus.
- **Segmented control (mobile):** Panel Slate track with 4px padding and 10px corners; the active tab is Card Slate with an inset Strong Hairline ring and white text; inactive tabs are muted.

### Run Card (signature)
The live pipeline. A Panel Slate card with a 12px radius and hairline. The head row shows a spinner (mint top arc) and elapsed time at the far end. Step rows are at least 48px tall and start with a 24px round state circle: a hairline ring when pending, a numbered mint ring (Persian digit) with a soft pulsing halo while running, a `mint-soft` fill with a mint check when done (with a small pop), a `danger-soft` fill when failed, an amber ring when waiting. Deploy steps get a 3px mint progress bar that grows from the right (RTL). Rows with detail expand into a Console Ground output well with a caret that rotates 180°.

### Hypothesis Board (signature)
Inside the diagnose step. The leading cause sits in a Card Slate block with a 0.35 alpha mint border, a 15.5px title, a mint confidence percentage, a 6px mint confidence bar and an evidence list tagged with LTR micro IDs (`mint-soft` for supporting evidence, Raised Slate for evidence against). Rejected causes fold into a disclosure and are shown struck through. Fixes are a numbered list using Persian numerals (`list-style-type: persian`).

### Approval Card
A Card Slate card with an amber border (sky for tier 1), a 22px state icon, a 15.5px question, a badge, and a fact grid (cost, risk, downtime, undo) on Panel Slate tiles. Actions wrap in one row, with the reason field growing. Once decided, the border turns dashed (mint when approved).

### Task Tiles
At least 72px tall, Card Slate with a 22px mint icon, a 600-weight title and a caption subtitle. On hover: a 0.55 alpha mint border, a faint mint top wash and a 1px lift.

### Watch Switch
A 42 by 24px round track; when on, it gets a `mint-soft` fill and a mint thumb that slides along the inline axis (RTL aware). The whole label row is at least 44px tall.

## Do's and Don'ts

### Do:
- **Do** build every surface from ground, panel and card tones with 1px hairlines before reaching for anything else.
- **Do** keep mint for selected, active and done states, and the Liara gradient for the primary action only.
- **Do** show state with soft tints (`mint-soft`, `ok-soft`, `warn-soft`, `danger-soft`) and an alpha border of the same hue.
- **Do** make every control at least 44px with a label that never wraps, and verify every row at 375px with no horizontal overflow.
- **Do** use logical properties (`inset-inline-start`, `margin-inline`, `padding-inline-start`, `text-align: start`) so the layout stays correct in RTL.
- **Do** draw icons from the one inline SVG sprite: 18px default, 1.6px round stroke, `currentColor`.
- **Do** wrap Latin URLs, code and evidence IDs in an LTR, bidi-isolated span.

### Don't:
- **Don't** set `tabular-nums` on Persian numerals.
- **Don't** add a light theme; the system is dark only.
- **Don't** use Liara's logo or present Hamyar as Liara.
- **Don't** put the gradient on text, borders or card backgrounds.
- **Don't** fill state containers with saturated colour; use the soft tint.
- **Don't** add shadows to cards; depth is tonal, and shadows belong only to the sticky bar and the toast.
- **Don't** use a rigid grid for toolbars that strands a half-width button.
