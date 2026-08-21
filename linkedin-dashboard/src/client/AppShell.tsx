import { useEffect, useMemo, useState, type FC } from 'hono/jsx/dom';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Callout } from './components/Feedback.tsx';
import { KeyHint } from './components/Facts.tsx';
import { Toaster } from './components/Toast.tsx';
import { api, establishSession, onSessionEnded } from './lib/api.ts';
import { createPalette } from './lib/commands.ts';
import {
  DESTINATIONS,
  DESTINATION_LABELS,
  navigate,
  routeToHash,
  useRoute,
  type Destination,
} from './lib/router.ts';
import { useTheme } from './lib/useTheme.ts';
import type { ReadinessReport } from './lib/types.ts';
import { ContentScreen } from './screens/Content.tsx';
import { EvidenceScreen } from './screens/Evidence.tsx';
import { OverviewScreen } from './screens/Overview.tsx';
import { ProfileScreen } from './screens/Profile.tsx';
import { SetupScreen } from './screens/Setup.tsx';
import { PublishingScreen } from './screens/Publishing.tsx';
import { SystemScreen } from './screens/System.tsx';
import { pairClass } from './styles/pairs.ts';

/**
 * The one-line purpose under each page heading. The names themselves come from
 * `DESTINATION_LABELS` in router.ts, so the rail, the heading and the command
 * palette cannot drift apart.
 */
const HINT: Record<Destination, string> = {
  setup: 'What is configured, and how to get your first evidence in.',
  overview: 'What needs a decision, what is blocked, and what changed.',
  evidence: 'Claims, the evidence under them, conflicts, sources and artifacts.',
  profile: 'Canonical sections, the diff against LinkedIn, and copy/paste patches.',
  content: 'Drafts, evidence coverage, opportunities and planning.',
  publishing: 'Approvals, publications, and whether publishing is possible at all.',
  system: 'Credentials, capabilities, retention, analytics and the audit log.',
};

const SCREENS: Record<Destination, FC> = {
  setup: SetupScreen,
  overview: OverviewScreen,
  evidence: EvidenceScreen,
  profile: ProfileScreen,
  content: ContentScreen,
  publishing: PublishingScreen,
  system: SystemScreen,
};

function Rail(props: { current: Destination }) {
  const theme = useTheme();
  return (
    <nav class="rail" aria-label="Sections">
      <div class="rail__brand">
        <span class="rail__brand-name">linkedin_mcp</span>
      </div>

      {/* role="list" is not redundant here: .rail__nav is display:flex, and a
          flex container loses list semantics in WebKit. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: load-bearing in WebKit */}
      <ul class="rail__nav" role="list">
        {DESTINATIONS.map((destination) => (
          <li key={destination}>
            <a
              class="rail__link"
              href={routeToHash({ destination })}
              aria-current={destination === props.current ? 'page' : undefined}
            >
              <span class="rail__link-label">{DESTINATION_LABELS[destination]}</span>
            </a>
          </li>
        ))}
      </ul>

      <div class="rail__footer">
        <button type="button" class="btn btn--secondary" onClick={theme.toggle}>
          {theme.theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
        <p class="rail__count">
          <KeyHint keys="Ctrl K" /> commands
        </p>
      </div>
    </nav>
  );
}

export function AppShell() {
  const route = useRoute();
  const palette = useMemo(() => createPalette(), []);
  const label = DESTINATION_LABELS[route.destination];
  const hint = HINT[route.destination];
  const Screen = SCREENS[route.destination];

  // Exchanges the single-use launch token from the fragment for a session
  // cookie, then rewrites the hash to a route.
  const [session, setSession] = useState<'checking' | 'ok' | 'ended'>('checking');
  useEffect(() => {
    void establishSession().then((ok) => setSession(ok ? 'ok' : 'ended'));
    // A session can also end while the app is open — the server restarts on
    // every server-file save in development, and sessions are held in memory.
    // Without this, each screen reports "unauthenticated" on its own and the
    // member is left to work out what happened.
    return onSessionEnded(() => setSession('ended'));
  }, []);

  // A first run lands on Setup rather than Overview, because an overview of
  // nothing is not useful and the member has no way to guess what to do first.
  //
  // Only when the member has not asked for somewhere specific: an explicit
  // hash, including a deep link they bookmarked, always wins. This runs once
  // per session and never redirects again, so it cannot trap someone who
  // navigates away while their ledger is still empty.
  const [firstRunChecked, setFirstRunChecked] = useState(false);
  useEffect(() => {
    if (session !== 'ok' || firstRunChecked) return;
    setFirstRunChecked(true);
    const requested = location.hash.replace('#', '').replace('/', '');
    if (requested !== '') return;
    void api
      .get<ReadinessReport>('/readiness')
      .then((report) => {
        if (report.is_first_run) navigate({ destination: 'setup' });
      })
      .catch(() => {
        // A failed probe must never block the app; Overview is a fine default.
      });
  }, [session, firstRunChecked]);

  return (
    <div class="app">
      <a class="skip-link" href="#main">
        Skip to content
      </a>

      <Rail current={route.destination} />

      {/* The frame is fixed and the sheet inside it scrolls. A dashboard whose
          page grows without limit makes the reader lose both the thing they
          were reading and the controls that act on it; here the slug line stays
          put and only the work moves. */}
      <main class="frame" id="main" tabIndex={-1}>
        {/* The slug line is inside `main` on purpose: it carries the page's h1,
            and skipping to content should land you before the title rather
            than past it. It simply does not scroll with the work below it. */}
        <header class="slug">
          <div class="slug__title">
            <h1>{label}</h1>
            <p class={`section__hint ${pairClass('text-muted/bg')}`}>{hint}</p>
          </div>
        </header>

        <div class="sheet">
          {session === 'ended' ? (
            // Sessions live in memory and the launch token is single-use, so a
            // server restart ends every session. The old UI's answer was a
            // 12px string saying "restart the dashboard"; this at least
            // explains what happened and what to do.
            <Callout tone="warn" title="This session has ended">
              <p class={pairClass('text-muted/surface-1')}>
                The dashboard server restarted, or the session expired. Sessions are held in memory
                and the launch token is spent on first use, so a new one is needed.
              </p>
              <p class={pairClass('text-muted/surface-1')}>
                Restart with <code>npm run dashboard</code> and open the freshly printed URL.
              </p>
            </Callout>
          ) : session === 'checking' ? null : (
            <Screen />
          )}
        </div>
      </main>

      <Toaster />
      <CommandPalette palette={palette} />
    </div>
  );
}
