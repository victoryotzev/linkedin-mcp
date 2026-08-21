# Dashboard manual verification checklist

What the automated suite cannot check, and therefore what a person has to.

The suite covers rendering, every event handler, keyboard paths, focus
management, contrast arithmetic over the pair matrix, the security headers, and
the API contract — the client is driven through the real `buildDashboardApp`
over a seeded database, so a renamed response field fails a test. What it does
**not** cover is real pixels: happy-dom does not compute layout, so nothing below
can be automated until the optional Playwright phase is approved.

Run this before cutover, and after any change to `layout.css` or `tokens.css`.

## Setup

```
npm run build -w @linkedin-mcp/dashboard
npm run dashboard
```

Open the redesigned surface at `/preview`. Seed data helps: an unreviewed claim,
an open conflict, a pending approval and an unapplied patch exercise most of the
interface.

## Widths

Resize the browser window (not the device toolbar) and confirm at each width
that **the page itself never scrolls sideways**. Only excerpts, code blocks and
wide tables may scroll, inside their own box.

| Width | Expect |
|---|---|
| 1600+ | rail with labels, two-column overview |
| 1440 | as above, content capped and centred |
| 1280 | two-column overview still readable |
| 1024 | rail collapses to icons; links keep their accessible names |
| 768 | rail becomes a top bar; low-priority table columns drop |
| 480 | tables stack into labelled rows; drawers fill the screen |
| 320 | single column, controls full width, nothing clipped |

## Zoom

At 1280px window width:

- [ ] **200%** — all text scales, no overlap, no clipped controls (WCAG 1.4.4)
- [ ] **400%** — content reflows to the 320px layout with no horizontal page
      scroll (WCAG 1.4.10)
- [ ] Focused elements are never hidden behind sticky chrome at either zoom
      (WCAG 2.4.11)

## Themes

- [ ] System set to light, no stored choice → light theme
- [ ] System set to dark, no stored choice → dark theme
- [ ] Choose light explicitly, then switch the system to dark → **stays light**
- [ ] Choose dark explicitly, then switch the system to light → **stays dark**
- [ ] Reload with a stored choice → **no flash of the wrong theme** before paint

## Reduced motion

With the OS "reduce motion" setting on:

- [ ] Toasts, dialogs and drawers appear without transition
- [ ] The pending-button spinner does not animate

## Forced colors / high contrast

With Windows high-contrast mode on:

- [ ] Cards, dialogs, chips and inputs still have visible boundaries
- [ ] Primary and destructive buttons are distinguishable from each other
- [ ] The active rail item is identifiable
- [ ] Status is still readable — the glyph and the word carry it without colour

## Keyboard only

Unplug the mouse.

- [ ] Tab from the address bar reaches **Skip to content** first
- [ ] Every destination, tab, button, field and row action is reachable
- [ ] The focus ring is clearly visible on every one of them, in both themes
- [ ] `Ctrl`/`Cmd`+`K` opens the palette; arrows move; Enter runs; Escape closes
- [ ] Opening a drawer moves focus into it; Escape closes it; **focus returns to
      the control that opened it**
- [ ] In a confirmation dialog, focus starts on **Cancel** — pressing Enter
      immediately must never approve, reject or delete anything

## Screen reader

With NVDA or Narrator:

- [ ] The destination is announced on navigation
- [ ] Dialogs announce their title and are reported as modal
- [ ] A successful mutation is announced politely
- [ ] A failed mutation interrupts, and the code and remediation are readable
- [ ] Status chips read as a word, not as a colour

## Consequential flows

Read the wording, not just the behaviour.

- [ ] Rejecting a claim says it is a permanent tombstone that cannot be
      re-proposed
- [ ] Granting an approval quotes the revision and shows the exact text
- [ ] An approval whose draft has moved on shows the warning **and** the preview
      still shows the bound revision, not the current one
- [ ] Enabling publishing states that it is the second gate
- [ ] The credential field is masked, and clears after saving
- [ ] Deleting all local data requires the phrase typed exactly, and the
      end-state screen makes clear the window is dead

## Record

| Date | Version / commit | Checked by | Notes |
|---|---|---|---|
| | | | |
