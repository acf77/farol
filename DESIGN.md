---
name: BuildFlow
description: A desktop terminal workspace with runnable shell and AI pipelines.
colors:
  accent-signal-blue: "#0a84ff"
  accent-signal-blue-hover: "#2492ff"
  status-run-green: "#32d74b"
  status-fail-red: "#ff453a"
  status-ai-violet: "#bf5af2"
  status-ai-violet-soft: "#d7a5f7"
  status-stale-amber: "#ffd60a"
  surface-terminal-pitch: "#151516"
  surface-pane-well: "#0f0f10"
  surface-empty: "#161617"
  surface-tab-active: "#1a1a1c"
  surface-app: "#1c1c1e"
  surface-sidebar: "#202022"
  surface-chrome: "#29292b"
  surface-panel: "#2c2c2e"
  text-strong: "#f0f0f2"
  text-default: "#e8e8ea"
  text-soft: "#d4d4d8"
  text-muted: "#9a9aa0"
  text-dim: "#8e8e93"
  text-faint: "#6e6e73"
  text-fainter: "#5c5c61"
  text-step: "#e0e0e4"
  text-row: "#c8c8cc"
  text-glyph: "#7c7c82"
  accent-signal-blue-soft: "#c8d8ee"
  status-stale-amber-dim: "#8e6b2f"
  neutral-grey: "#636366"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "1.3"
    letterSpacing: "normal"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "1.35"
    letterSpacing: "normal"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: "1.4"
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "1.45"
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "15px"
    letterSpacing: "normal"
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: "1.4"
    letterSpacing: "0.02em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "1.5"
    letterSpacing: "normal"
rounded:
  xs: "3px"
  sm: "4px"
  md: "5px"
  lg: "6px"
  xl: "7px"
  panel: "8px"
  pill: "11px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
components:
  button-primary:
    backgroundColor: "{colors.accent-signal-blue}"
    textColor: "#ffffff"
    typography: "{typography.title}"
    rounded: "{rounded.xl}"
    padding: "0 16px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.accent-signal-blue-hover}"
    textColor: "#ffffff"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.md}"
    padding: "0 6px"
  icon-button-hover:
    backgroundColor: "#ffffff14"
    textColor: "#ffffff"
  input-field:
    backgroundColor: "#ffffff0d"
    textColor: "{colors.text-default}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  input-field-focus:
    backgroundColor: "#ffffff0d"
    textColor: "{colors.text-default}"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "0px"
    padding: "0 12px"
  tab-active:
    backgroundColor: "{colors.surface-tab-active}"
    textColor: "{colors.text-default}"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-default}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  menu-item-hover:
    backgroundColor: "{colors.accent-signal-blue}"
    textColor: "#ffffff"
  sidebar-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "6px 8px"
  sidebar-row-hover:
    backgroundColor: "#ffffff0f"
    textColor: "{colors.text-default}"
  overlay-panel:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.text-default}"
    rounded: "{rounded.panel}"
    padding: "12px 14px 8px"
---

# Design System: BuildFlow

## 1. Overview

**Creative North Star: "The Control Surface"**

BuildFlow is an aircraft panel, not a webpage. Every indicator earns its space, every reading is unambiguous, and the whole surface is legible under pressure at a glance. The instrument is dense because density is correct here: an operator who has to hunt for the state of a run has been failed by the panel. Small type, tight gaps, and exact alignment are the vocabulary. What makes it a control surface rather than clutter is that no element is present for decoration, and every value is deliberate.

The panel is dark, but not for atmosphere. It is dark because the thing it houses, a real terminal at `#151516`, is the darkest surface in the app, and everything else steps up from it in near-black tints. Depth is built by stacking surfaces, not by painting shadows. The chrome around the terminal is a slightly lighter grey; the sidebar a shade between; a floating panel a shade above that. This is why the system reads as one machined object rather than a stack of cards.

Color is almost absent, and that absence is the design. The surface is a run of neutral greys, and the only saturated values in the entire system are signal: blue for what is selected or actionable, green for pass, red for fail, violet for an AI step, amber for a result that has gone stale. A screen where more than a sliver is colored is a screen where the signals have stopped meaning anything. This system explicitly rejects the neon hacker terminal, the AI-product gradient, the CI dashboard's badge soup, and the generic Electron app that forgot which platform it was running on.

**Key Characteristics:**
- Near-black tonal layering, seven surface steps from `#0f0f10` to `#2c2c2e`
- One accent (`#0a84ff`), four status colors, nothing else saturated
- Dense native type ramp, 9px to 15px, weights 600 and 700 only
- Small radii (3px to 8px), hairline `rgba(255,255,255,0.12)` borders
- Flat at rest; shadows exist only under things that float
- macOS system fonts and materials, never a substitute stack

## 2. Colors

A near-monochrome field of near-black greys, interrupted only where the interface has something to report.

### Primary
- **Signal Blue** (`#0a84ff`): The system's single accent, the macOS system blue. It marks exactly three things: what is selected (active tab glyph, focused input border, menu item under the cursor), what is the primary action in a dialog, and the `head` line kind in a run log. It is never a fill for decoration and never a background for a large area. Its hover state, **Signal Blue Raised** (`#2492ff`), is the only lift a primary button gets.

### Secondary
The status quartet. These are not brand colors and must never be repurposed as decoration; each one is a reading on the panel.
- **Run Green** (`#32d74b`): A step or pipeline passed. Nothing else.
- **Fail Red** (`#ff453a`): A step failed, or an action is destructive. Destructive controls carry it at 12% as a hover wash (`rgba(255,69,58,0.12)`), never as a fill at rest.
- **AI Violet** (`#bf5af2`): An AI step, in the pipeline chain and in the run log. **AI Violet Soft** (`#d7a5f7`) is its lighter reading for text on darker surfaces. Violet identifies a step type; it is not a "powered by AI" flourish and must never appear as a gradient or a glow.
- **Stale Amber** (`#ffd60a`): A result whose branch has moved on, or a warning the user must read before acting. Amber means "this was true, and may no longer be."

### Neutral
The seven surface steps, darkest to lightest. Each step is a layer of the instrument, and the ordering is the depth model.
- **Pane Well** (`#0f0f10`): The recess behind panes in a split, the floor of the app.
- **Terminal Pitch** (`#151516`): The terminal and run-log content. Deliberately the darkest content surface so the user's own shell colors sit at maximum contrast. Stays fully opaque even under Liquid Glass.
- **Empty Field** (`#161617`): The no-project state.
- **Tab Active** (`#1a1a1c`): The selected tab, keyed to read as continuous with the pane below it.
- **App Ground** (`#1c1c1e`): The window's base color.
- **Sidebar Slate** (`#202022`): The pipeline sidebar, one step up from ground so it reads as attached chrome.
- **Chrome Grey** (`#29292b`): The toolbar and tab strip, the topmost fixed layer.
- **Panel Grey** (`#2c2c2e`): Menus and dialogs. The only surface allowed to float.

Text runs a seven-step ramp on those surfaces: **Text Strong** (`#f0f0f2`) for the one thing that matters most on a screen, **Text Default** (`#e8e8ea`) for ordinary labels, **Text Soft** (`#d4d4d8`) for secondary rows, **Text Muted** (`#9a9aa0`) and **Text Dim** (`#8e8e93`) for metadata, **Text Faint** (`#6e6e73`) for inactive glyphs, and **Text Fainter** (`#5c5c61`) for placeholders only. **Neutral Grey** (`#636366`) is the skipped-step marker.

### Named Rules

**The Signal Rule.** Saturated color is a reading, never a finish. Blue, green, red, violet, and amber appear only where the interface is reporting state or offering the primary action. If a saturated color appears anywhere it is not reporting something, delete it. A typical screen is under 5% saturated pixels.

**The Pitch Floor Rule.** Terminal and run-log surfaces stay at `#151516`, fully opaque, always. When the window is running native Liquid Glass and every other surface goes translucent, content panes do not. Contrast under the user's own shell theme outranks the material effect.

**The Status Never Alone Rule.** Green, red, amber, and grey always travel with a glyph or a word. "Passed", "Failed", "Skipped", "Not run on feature/x". A user who cannot distinguish the hues must still read the panel correctly.

## 3. Typography

**UI Font:** `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif`
**Mono Font:** `ui-monospace, 'SF Mono', Menlo, monospace`

**Character:** The platform's own voice, unmodified. SF Pro Text carries every label, and SF Mono carries anything that is or refers to code: commands, branch names, run output, the `❯` mark. The pairing is invisible on macOS by design, which is the point. A user should never notice the app chose a typeface.

The ramp is compressed, 9px to 15px, because this is an instrument panel and the information density is the feature. Compression means hierarchy cannot come from size alone: it comes from weight (600 and 700 against 400) and from the text color ramp. There is no light weight anywhere in the system.

### Hierarchy
- **Display** (600, 15px, 1.3): The single largest text on any screen. Empty-state headlines only, as in "No Project Open". At most one per view.
- **Headline** (600, 13px, 1.35): Dialog titles and section heads.
- **Title** (600, 12.5px, 1.4): Buttons and menu items. The interactive ramp.
- **Body** (400, 12px, 1.45): The workhorse. Field values, descriptions, list content. Prose is rare here; where it appears, cap it at 65 to 75ch.
- **Label** (600, 11px, 15px): Tab titles, sidebar rows, field labels, inline status. The densest and most-used step.
- **Caption** (600, 10px, 0.02em tracking): Step numbers, badges, branch tags, metadata. Below this, only glyphs.
- **Mono** (400, 11px, 1.5): Commands, paths, branch names, run output.

### Named Rules

**The Weight-Not-Size Rule.** The ramp spans six points from top to bottom, so scale cannot carry hierarchy. Promote with weight (600) or with the text color ramp; never by inventing a size step outside the ladder above.

**The Mono Means Code Rule.** SF Mono is reserved for text the machine will read or did emit: commands, paths, branch names, run output, prompt marks. Monospace on a label, a heading, or a button is decoration borrowed from the hacker-terminal aesthetic, and is prohibited.

**The Nine-Pixel Floor Rule.** Nothing below 9px, and 9px only for non-essential metadata that repeats elsewhere. Any text carrying meaning that appears nowhere else is 11px or larger.

## 4. Elevation

This system is tonally layered and flat at rest. Depth is communicated by surface lightness, not by shadow: the eight neutral steps from Pane Well (`#0f0f10`) up to Panel Grey (`#2c2c2e`) are a literal z-order, and moving a surface up the ramp is how you raise it. Separation between adjacent layers is reinforced by hairline borders at `rgba(255,255,255,0.08)` to `rgba(255,255,255,0.12)`, never by a shadow between them.

Shadows are reserved for the two things that genuinely float above the application: menus and dialogs. There are exactly two in the system, and no third should be added without removing one.

### Shadow Vocabulary
- **Menu Drop** (`box-shadow: 0 12px 32px rgba(0,0,0,0.5)`): Popover menus, the branch picker, context menus.
- **Dialog Drop** (`box-shadow: 0 18px 48px rgba(0,0,0,0.55)`): Modal dialogs. Deeper and wider because a dialog sits further from the panel.

### Named Rules

**The Two-Shadow Rule.** The system has two shadows. Menus get Menu Drop, dialogs get Dialog Drop, and everything else gets none. A hover state that reaches for a shadow is a hover state that should have changed its background instead. The one exception is a canvas node (`0 8px 24px rgba(0,0,0,0.35)`), which is genuinely lifted off a world plane rather than layered in the chrome.

**The Ramp-Is-The-Z-Order Rule.** To raise a surface, move it up the neutral ramp; to recess one, move it down. Never simulate depth on an in-flow element with a shadow, an inner glow, or a gradient.

**The Glass Exception.** When native Liquid Glass is active, chrome surfaces become translucent tints of `rgba(28,28,30,0.38–0.42)` and panels `rgba(44,44,46,0.72)`, but the layer ordering is unchanged and content panes stay opaque. Glass is a platform material the window receives, never an effect the interface applies for looks.

## 5. Components

### Buttons
Compact and unambiguous. A button looks like a control, not like a card.
- **Shape:** Small radius, 7px (`{rounded.xl}`) for primary actions, 5px to 6px for everything smaller.
- **Primary:** Signal Blue fill (`#0a84ff`), white text at 600/12.5px, 28px tall, `0 16px` padding, no border.
- **Hover / Focus:** Background lifts to Signal Blue Raised (`#2492ff`). No transform, no shadow, no scale. Focus shows a visible ring; disabled drops the pointer cursor and does not change color alone.
- **Icon buttons:** Transparent at rest with Text Dim glyph; on hover, an `rgba(255,255,255,0.08)` wash and white glyph. This wash, in the 5% to 14% range, is the universal hover language of the app.
- **Destructive:** Never a red fill at rest. Fail Red text with an `rgba(255,69,58,0.12)` hover wash.

### Inputs / Fields
- **Style:** 24px tall, `0 8px` padding, 5px radius, `rgba(255,255,255,0.05)` background, `1px solid rgba(255,255,255,0.1)` border. Fields are recessed washes on the surface, not raised boxes.
- **Focus:** The border alone shifts to Signal Blue (`#0a84ff`). No glow, no ring expansion, no background change.
- **Placeholder:** Text Fainter (`#5c5c61`) only.
- **Error:** A lightened Fail Red (`#ff8b80`) message beneath the field at 11px. The message names what is wrong; the border does not carry the error by itself.
- **Prompt fields** (multi-line AI step prompts) use the same treatment with `auto` height; command fields switch to SF Mono at 11px.

### Tabs
The signature component. Tabs read as physically continuous with the pane below them.
- **Style:** `0 12px` padding, 190px max width, 7px gap, no radius and no border. The active tab is distinguished purely by its surface, `#1a1a1c` against transparent chrome, keyed to the pane beneath.
- **Leading glyph:** SF Mono at 10px. Signal Blue when active, `#7c7c82` when not.
- **Hover:** `rgba(255,255,255,0.05)` wash. The close affordance is a 15px, 4px-radius target that brightens to white on `rgba(255,255,255,0.12)`.
- **Branch tag:** Run tabs carry the branch they ran on at caption scale, turning Stale Amber once the checkout has moved past it.

### Menus
- **Style:** Panel Grey (`#2c2c2e`) surface, 8px radius, Menu Drop shadow, `1px solid rgba(255,255,255,0.12)` border.
- **Items:** `6px 10px` padding, 5px radius, 12.5px text. Hover fills the item with Signal Blue and sets text to white. This is the one place a saturated fill covers a whole element, and it is justified because it marks the single item under the cursor.

### Sidebar
- **Style:** Sidebar Slate (`#202022`) with a `1px solid rgba(255,255,255,0.08)` edge against the pane area.
- **Rows:** `6px 8px` padding, 6px radius, Label type. Hover is an `rgba(255,255,255,0.06)` wash. Rows carry their run status as a glyph plus a word, per the Status Never Alone Rule.

### Pipeline Editor (Canvas)
A pipeline is authored on a node canvas, not in a list. This is the app's one spatial surface and the only place a bezier curve is permitted.
- **Ground:** Empty Field (`#161617`) under a 22px dot grid at `rgba(255,255,255,0.06)`, scaled and offset with the camera so the grid reads as world space rather than wallpaper.
- **Nodes:** 8px radius, `1px solid rgba(255,255,255,0.12)`, Sidebar Slate (`#202022`) for shell steps and `rgba(191,90,242,0.12)` for AI steps. Selected takes a Signal Blue border plus a `0 0 0 3px rgba(10,132,255,0.18)` ring. A node carries a caption-scale kind label (`SHELL`, `AI · Claude`, suffixed `· GATE`) above its name.
- **Ports:** 10px circles centred on the top and bottom edges. The outbound port is solid Signal Blue, the inbound is `rgba(10,132,255,0.85)`. Ports must grow on node hover; a target this small cannot rely on a tooltip alone.
- **Wires:** cubic beziers at `rgba(10,132,255,0.55)`, 2.5px and full Signal Blue when selected, with a transparent 14px stroke beneath for hit area. A wire in flight is a dashed straight line. Selecting a wire reveals an 18px round remove button at its midpoint.
- **Inspector:** a 280px right rail on Sidebar Slate holding step type, name, command or prompt, and the Gate toggle. It appears only on selection, which is the canvas's progressive disclosure.
- Node shadows (`0 8px 24px rgba(0,0,0,0.35)`) are the documented exception to the Two-Shadow Rule: a node is a thing lifted off the canvas, and the shadow is what sells the plane.

### Pipeline Chain (Detail)
The read-only counterpart in the sidebar, rendering the graph's resolved order as a vertical chain.
- Steps carry a zero-padded mono index (`01`, `02`) and are joined by a lowercase `then`, or `and` where two steps share a parent. The failing step is marked and its descendants are annotated `skipped` in Neutral Grey (`#636366`).
- Step kind is a badge, not a color alone: `SH` on `rgba(255,255,255,0.08)`, or the provider name on `rgba(191,90,242,0.18)` in AI Violet.
- Status is a glyph at the row's end (`✓`, `✗`, `–`) or a Signal Blue spinner while running.
- This view must express what the graph expresses. Where the canvas has branches or parallel paths, the chain shows them; it never flattens a graph into a false linear order.

### Run Log
- Content surface is Terminal Pitch (`#151516`), monospace at 11px.
- Ten line kinds carry distinct colors: default `#d6d6d9`, dim `#8e8e93`, command `#ffffff` bold, head `#0a84ff` bold, step `#e8e8ea` bold, ok `#32d74b`, error `#ff453a`, ai `#bf5af2`, warn `#ffd60a`, echo `#b8b8bc`. Command, head, and step are bold; the rest are regular. Weight and prefix, not hue alone, separate the kinds.
- In-progress steps use the `bfspin` rotation (`.8s linear infinite`) or the `bfpulse` opacity cycle. Both must degrade under `prefers-reduced-motion` to a static indicator that still shows the step is running.

## 6. Do's and Don'ts

### Do:
- **Do** build depth by moving surfaces along the neutral ramp (`#0f0f10` → `#2c2c2e`), reinforced with hairline `rgba(255,255,255,0.08–0.12)` borders.
- **Do** keep terminal and run-log panes fully opaque at `#151516`, including when Liquid Glass is active.
- **Do** use `rgba(255,255,255,0.05–0.14)` background washes for every hover state. That wash is the app's hover language.
- **Do** pair every status color with a glyph or word: "Passed", "Failed", "Skipped", "Not run on feature/x".
- **Do** reserve SF Mono for commands, paths, branch names, and run output.
- **Do** promote with weight (600) and the text color ramp, since the type ramp spans only 9px to 15px.
- **Do** honor `prefers-reduced-motion` on `bfspin` and `bfpulse`, degrading to a static indicator that still reports the running state.
- **Do** check dim metadata (`#8e8e93`, `#6e6e73`, `#5c5c61`) for 4.5:1 against its actual surface, including the translucent glass variants where the effective background shifts.
- **Do** show the real result, including git's refusal message or a missing CLI on PATH, in the interface's own type rather than swallowing it.

### Don't:
- **Don't** build the **generic Electron app**. No browser-default buttons, no substitute font stack in place of SF Pro and SF Mono, no web-styled scrollbars over the app's own 10px `rgba(255,255,255,0.14)` thumb. If it reads as a website in a frame, rewrite it.
- **Don't** build the **CI dashboard**. No heavy tables, no status-badge soup, no cluttered configuration forms. A pipeline is a node canvas to author and a numbered chain to read, never a grid of identical cards.
- **Don't** build the **neon hacker terminal**. No matrix green, no glow, no text-shadow, no cyberpunk styling, and no decorative monospace on labels, headings, or buttons.
- **Don't** build the **AI-product gradient SaaS**. No purple or blue gradients, no glassmorphism applied as decoration, no hero-metric cards, no sparkle icons. AI Violet marks a step type and nothing more.
- **Don't** use `background-clip: text` with a gradient anywhere. Emphasis is weight or color, never a gradient fill.
- **Don't** use `border-left` or `border-right` above 1px as a colored stripe on a row, step, or panel. Status goes in a glyph, a word, or the text color.
- **Don't** add a fourth shadow. Menus get `0 12px 32px rgba(0,0,0,0.5)`, dialogs get `0 18px 48px rgba(0,0,0,0.55)`, canvas nodes get `0 8px 24px rgba(0,0,0,0.35)`, everything else gets none.
- **Don't** reach for a modal. Splits, panes, inline editors, and the sidebar exist precisely so state can be shown in place.
- **Don't** apply blur or translucency by hand. Glass is a native material the window receives; content panes never take it.
- **Don't** restyle the inside of a terminal pane. The user's prompt, theme, and colors pass through untouched.
- **Don't** show anything green that was not earned on the current branch. Stale results are Stale Amber and labeled with the branch they came from.
