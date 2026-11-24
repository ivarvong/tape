# Design: the homepage and the playground

One design language for `/` and `/playground/`. Restrained: neutral greys, one accent, type doing the work.
Every artefact on the homepage is real output made at build time; the design frames it, never decorates it.

## Principles

1. **The product is the hero.** The live editor, its run and its trace sit above the fold at 1280 px. Words
   explain only what the artefact cannot.
2. **One accent, used sparingly.** Amber (the tape in the icon) marks focus, the current state and the one thing to
   do next. Everything else is grey. Status colours (green, red) only ever say ok or refused, and never alone:
   every one has a glyph or word beside it (✓ ✗, `200`, `refused`).
3. **Nothing moves after it paints.** Every box that is filled by script has its size before the script runs
   (editor, output panel, waterfalls). CLS target 0.
4. **Fast first.** System fonts (0 bytes), one stylesheet per page, SQLite fetched after first paint, the
   highlighter and the trace renderer precompiled to Wasm at build time.

## Tokens (`style.css`, `:root`)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0b0b0c` | page |
| `--surface` | `#f7f7f6` | `#151517` | panels, inset areas |
| `--code-bg` | `#fbfbfa` | `#111113` | editor, code blocks |
| `--border` / `--border-strong` | `#e7e7e5` / `#d6d6d3` | `#232326` / `#34343a` | hairlines / controls |
| `--fg` | `#0c0c0e` | `#ededee` | text |
| `--fg-2` | `#3b3b41` | `#c9c9ce` | secondary text |
| `--muted` | `#5c5c64` | `#a0a0a8` | captions (≥ 6:1) |
| `--faint` | `#6e6e76` | `#8b8b94` | gutters, meta (≥ 4.5:1) |
| `--accent` | `#b4530a` | `#f5b544` | focus ring, current tab, primary moment |
| `--ok` / `--bad` | `#157f3c` / `#c0262d` | `#4fcf7f` / `#ff7a73` | with a glyph or word, always |

Contrast is checked against `--bg`, `--surface` and `--code-bg` (the lowest of the three): every text token,
syntax colours and comments included, is ≥ 4.5:1 in both themes.

**Syntax** (the highlighter's class set is fixed: `c s e h hd n k w t i o q sk sp ss x`): calm, low-saturation,
hue-matched to the trace's service colours so a page reads as one palette: keywords magenta (`--s5` family), types
teal (`--s7`), strings green (`--s3`), numbers and escapes amber (`--s4`), SQL blue (`--s1`), placeholders rose,
comments grey. Never bold or italic (the editor overlay needs every glyph the same width).

**Trace** (`apps/trace/trace.tape` exposes `--tr-*`): the page sets them from its tokens on `.otlp-waterfall`,
so the SVG follows the page's theme toggle. Service colours `--tr-s1..8`: blue, orange, emerald, amber, pink,
violet, cyan, grey.

## Type

System UI stack (`ui-sans-serif, -apple-system, "Segoe UI", …`), mono `ui-monospace, "SF Mono", Menlo, Consolas`.
A self-hosted variable font (Inter, ~100 KB for a useful subset) was not worth its bytes on a page whose largest
text is code. Tabular numerals wherever numbers line up (`font-variant-numeric: tabular-nums`).

| Step | Size / line height | Use |
|---|---|---|
| `--t-xs` | 12 / 16 | badges, meta |
| `--t-sm` | 13 / 20 | UI, captions, code |
| `--t-md` | 14 / 22 | UI body |
| `--t-lg` | 16 / 26 | prose |
| `--t-xl` | 20 / 28 | section lede, h3 |
| `--t-2xl` | 28 / 34 | h2 |
| `--t-3xl` | 44 / 48 (32 / 38 at ≤ 640 px) | h1 |

Headings: weight 600, tracking −0.02em at 28 px and up. Prose max 65ch.

## Space, radius, elevation

4 px base; steps 4 8 12 16 24 32 48 64 96. Radii: 6 (controls), 10 (panels), 14 (the demo window).
Borders do the separating; shadows only lift the demo window and menus (`--shadow-lg`, two soft layers).
Focus: `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible`, everywhere.
Motion: 120–160 ms ease-out on colour and opacity only; none under `prefers-reduced-motion`.

## Layout

Homepage: content 1200 px max, gutters 24 px (16 at ≤ 640). Hero: pill, h1, one sentence, two buttons, then the
demo window full width: editor (left, 7/12) and output (right, 5/12), 480 px tall; below 960 px the two stack and
each keeps a fixed height. Then three feature rows (heading, one sentence, an artefact), the ten programs of
`apps/products` in two columns (name, one line, its file), a "what is checked" grid and the status grid. Playground: an app shell of 100dvh: 56 px header, two panes split by a draggable divider
(keyboard: arrow keys), each pane scrolling inside itself; at ≤ 760 px one pane at a time behind a Code / Run /
Trace segmented control.

## Components

- **Buttons**: primary (fg on bg, inverted), secondary (bordered), ghost (text). Height 36 (32 small).
  `kbd` hint inside the primary when it has a shortcut (`⌘↵`).
- **Segmented tabs** (`role="tablist"`): a row of text buttons with a 2 px accent underline on the selected one.
  Arrow keys move between tabs. Without JavaScript the panels show stacked, each with its own heading.
- **Badges**: status codes in tabular mono, tinted background plus the number (colour is never the only signal).
- **Diagnostic**: rustc/Elm style. `error[C54]` header, the message, a code frame of the program with the line
  numbered and underlined, and `help:` with the compiler's hint; for the hero, the fix as a one-line diff.
- **Effect log**: a table: kind, the program's own statement (its `:name` placeholders, not the `?1` the database
  is given), the values bound to each name, and the rows back.
