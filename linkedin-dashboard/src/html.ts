import type { AssetName } from './assets.ts';

// The server-rendered shell for the redesigned dashboard.
//
// Two rules govern this file:
//
// 1. No inline <script> and no inline <style>. Everything is an external asset,
//    which is what makes `script-src 'self'; style-src 'self'` possible — a CSP
//    the old inline page could never have.
//
// 2. #root ships a static fallback panel. The client's first act is to clear
//    it, so it is visible only when the bundle failed to load or parse. A blank
//    page here would mean the only surface that can approve a publication is
//    silently dead, which is exactly how the P7-era script bug survived.

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

export const BOOT_FALLBACK_HEADING = 'The dashboard client did not load';

export function renderShell(manifest: Record<AssetName, string>): string {
  const js = escapeHtml(manifest['app.js']);
  const css = escapeHtml(manifest['app.css']);
  const themeBoot = escapeHtml(manifest['theme-boot.js']);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkedin_mcp — review dashboard</title>
<link rel="stylesheet" href="${css}">
<script src="${themeBoot}"></script>
</head>
<body>
<!--
  THESIS: a fact-checker's proof sheet — assertions in a measured column with
  their sources pinned in the margin beside them, ticked or struck one at a
  time. It refuses the dashboard of stacked cards under a scrolling page.
  OWN-WORLD: one ink on one ground, warm neutral; a visible hairline column
  grid; mono slug rails at fixed edges; a single teal reserved for the live
  decision and the current line. Flat and ruled, never floating panels.
  STORY: the reviewer sees what needs deciding without scrolling, reads the
  assertion beside its source, ticks or strikes it, and the sheet advances.
  FIRST VIEWPORT: a fixed 100dvh frame. Destination rail left, slug line top,
  the ruled sheet in the centre scrolling inside its own region, the margin
  apparatus right in its own. The page itself never scrolls.
  FORM: editorial fact-check galley; candidate 5 of 7; seed key b8fec79e.
  FINISH: unreviewed and undocumented is unfinished; this build ends with the
  finish review, the verdict, DESIGN.md, and every shipping raster carrying its
  provenance.
-->
<div id="root">
  <div class="boot-fallback" role="alert">
    <h1>${BOOT_FALLBACK_HEADING}</h1>
    <p>
      The page loaded but its script did not run, so nothing here is interactive.
      Nothing has been changed and no data is at risk.
    </p>
    <p>Expected assets:</p>
    <ul>
      <li><code>${js}</code></li>
      <li><code>${css}</code></li>
    </ul>
    <p>Rebuild with <code>npm run build -w @linkedin-mcp/dashboard</code>, then reload.</p>
    <p>The previous dashboard is still available at <a href="/">/</a>.</p>
  </div>
</div>
<script type="module" src="${js}"></script>
</body>
</html>`;
}
