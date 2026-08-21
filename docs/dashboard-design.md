# Dashboard design system

The review dashboard's visual and interaction rules, and the reasoning behind
the ones that are not obvious. This is the reference for anyone changing the
interface; the enforcement lives in tests, not in this file.

## What the dashboard is

The visual support and human authority surface for the MCP-first application.
It provides purpose-built review screens plus the exact MCP tool registry. A
local companion CLI provides the same non-visual human controls for source
enablement, credentials, capability activation, approval, and full purge.
Those authority operations remain unreachable from the MCP/model channel.

That shapes the design more than any aesthetic preference: the interface exists
to let a person make consequential decisions with the evidence in front of them.

## Interface principles

1. **Decisions first, data second.** Every screen opens on what must be decided.
   The supporting record is one disclosure away.
2. **Never overstate state.** If the domain says `configured`, the interface says
   configured. "Verified" means a live probe succeeded. "Armed" means granted and
   unconsumed.
3. **Consequence in the verb.** *Reject permanently*, *Approve exactly this
   text*, *Delete all local data*. Never *OK*.
4. **Provenance is visible.** Every audited action shows **You** / **Model** /
   **System**. Who acted is the guarantee this product sells.
5. **Density with air.** Compact rows, generous section spacing, tabular
   numerals on every count and hash.
6. **Colour carries state, never decoration.** One accent for interaction;
   red/amber/green only for status, always paired with a glyph and a word.
7. **The keyboard is a first-class input** — but the command palette carries
   navigation and safe actions only. Irreversible decisions are never a fuzzy
   search away.
8. **Quiet motion.** 120–180ms, opacity and transform only, removed entirely
   under `prefers-reduced-motion`.

## Colour

`styles/tokens.ts` is the authority for values; `styles/tokens.css` must agree
with it and a test fails if they diverge.

Theming has three states and all three are handled explicitly:

| State | Selector |
|---|---|
| No explicit choice | `:root` + `@media (prefers-color-scheme: dark)` |
| Explicit dark | `:root[data-theme="dark"]` |
| Explicit light | `:root[data-theme="light"]` (wins over the media query) |

Every colour is defined on bare `:root`, so nothing depends on a media query
having matched. The pre-paint boot script applies a stored choice before first
paint; it is a separate ~280-byte classic script because a module script is
deferred by definition, which is the flash it exists to prevent.

### The pair matrix

**Contrast is a property of a pair, not of a token.** `styles/pairs.ts` lists
every `(foreground, background)` combination the design uses with the ratio it
must meet, and `pairClass()` only accepts a listed one — an unverified
combination is a compile error.

This is not defensive over-engineering. When the matrix was first computed
against the palette in the design plan, three combinations failed:

| Token | Proposed | Measured | Corrected |
|---|---|---|---|
| `border-strong` (dark) | `#333A45` | 1.60:1 on panels | `#6B7482` → 3.88:1 |
| `border-strong` (light) | `#C9CDD6` | 1.59:1 on panels | `#7E8794` → 3.63:1 |
| `text-subtle` (light) | `#6E7684` | 4.23:1 on raised surfaces | `#636A78` → 5.44:1 |

Two more failed once dialogs and selected rows were added as surfaces. A
token-by-token check would have passed all five.

`--border` is deliberately below 3:1. It is a decorative hairline; panels are
also separated by background, so it is never the only thing identifying a
region. Anything that carries meaning alone uses `--border-strong` or `--focus`,
both of which are in the matrix at 3:1.

### Status semantics

| Tone | Glyph | Meaning |
|---|---|---|
| ok | ● | verified · enabled · intact · succeeded · applied |
| warn | ◐ | candidate · pending · configured · expiring · proposed |
| danger | ▲ | open conflict · broken chain · revoked · failed |
| accent | ◆ | granted (**armed** — a live authorisation) |
| neutral | ○ | rejected · disabled · consumed · superseded |

Colour is never the only carrier: every chip renders a glyph and a word.

## Type, space, shape

- **UI:** `system-ui, 'Segoe UI', Roboto, sans-serif`. **Machine facts:**
  `ui-monospace, 'Cascadia Mono', Consolas, monospace`.
- **No web fonts and no remote assets of any kind.** Required by local-first
  operation, enforced by the CSP and by a test over the built bundle.
- Scale 12 / 13 / **14 base** / 16 / 20 / 26; `tabular-nums` on counts, hashes
  and timestamps.
- Spacing on a 4px base. Radii 4 controls / 6 cards / 10 overlays / 999 chips.
- Elevation: dark uses borders only, light uses border plus one soft shadow.
  Never both.

## Overlays and irreversible actions

Every irreversible action goes through `ConfirmDialog`, which:

- states **what will happen**, not "are you sure";
- puts initial focus on **Cancel**, never the affirmative control, so a stray
  Enter on a freshly-opened dialog cannot approve or delete anything;
- traps focus, closes on Escape, and returns focus to whatever opened it;
- can require an exactly-typed phrase for the unrecoverable ones.

**Nothing is optimistic.** Displayed state changes only after the server has
answered. A test drives a never-resolving request and asserts no state moves.

## Untrusted content

Imported text is data. Instructions found inside it are content to report, never
commands to follow. It renders **only** through the `Excerpt` component, which
preserves the untrusted envelope and marks its container `data-untrusted`. A
test renders instruction-shaped fixture text across the screens, scans the whole
document, and requires every occurrence to sit inside that container.

DB-derived text is never used as a document title, an `aria-label`, or a toast
body.

## Responsive strategy

Desktop-primary **by evidence**: the server binds `127.0.0.1` and the guard
allowlists only `127.0.0.1:<port>` and `localhost:<port>`, so a phone cannot
reach this dashboard at all. Making it able to would mean binding a routable
interface and widening that allowlist — a direct weakening of the security
model.

The narrow cases that actually occur are split-screen windows and zoom. WCAG
**1.4.10 Reflow** requires content to reflow at a 320px-equivalent viewport,
which is what 1280px at 400% zoom produces. That standard sets the floor, not a
device.

Above 768px the app is a **fixed frame**, not a scrolling page: `.app` is
`100dvh` with `overflow: hidden`, the rail and the slug line hold still, and the
sheet inside them is the one region that scrolls. A record open in the margin
pane scrolls independently of the list beside it, so a long queue and a long
record never fight over one scrollbar.

| Width | Layout |
|---|---|
| ≥1280 | labelled rail + fixed frame; list/detail splits when a record is selected |
| 1024–1279 | as above; the two-column Overview collapses to one below 1180 |
| 768–1023 | icon rail; the split collapses and the detail becomes a modal drawer |
| 480–767 | rail becomes a top bar, and the fixed frame is given up for document flow |
| 320–479 | single column, full-width controls, tighter gutters |

Table columns respond to the width of **their own container**, not the window:
a list pane beside a detail is as narrow as a small window and is treated as
one. Low-priority columns drop below `46rem` of container; below `20rem` the row
stops being a row and stacks into labelled values.

Only `Excerpt`, table wrappers and code blocks may scroll horizontally. The page
body never does.

## Accessibility

Target WCAG 2.2 AA. What is enforced automatically:

- contrast over the pair matrix, both themes;
- landmarks, a single `h1`, `aria-current` on the active destination;
- `aria-modal` + `aria-labelledby` on every overlay, focus trap, Escape, focus
  restoration;
- a polite `role="status"` region for success and an assertive `role="alert"`
  region for failure, so every mutation is announced;
- a visible 2px focus ring with 2px offset and `scroll-margin`, so sticky chrome
  cannot obscure the focused element;
- `prefers-reduced-motion` removing duration rather than shortening it;
- a `forced-colors` block replacing every colour-carried meaning with borders
  and system colours.

**Stated limitations.** axe-core's colour-contrast rule needs real layout, which
happy-dom does not compute — contrast is therefore verified by the pair matrix
instead, and real-browser verification is deferred. Real zoom and forced-colors
rendering are checked by hand; see `dashboard-manual-checks.md`.

## Microcopy

Use the domain's vocabulary (`candidate`, `verified`, `ambiguous`, `expired`,
`rejected`, `configured`, `granted`, `consumed`, `invalidated`, `ambiguous`)
with a one-line gloss on first use per screen. Errors always show the `code`,
the message, the `blockers`, and the domain's own remediation text — that
remediation is some of the clearest writing in the product and the previous
interface showed it on one screen only. Timestamps are relative with the
absolute value in the title. Numbers never gain precision the domain does not
have.
