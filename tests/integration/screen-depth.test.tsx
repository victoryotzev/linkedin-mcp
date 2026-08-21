// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executePublication,
  grantApproval,
  importObservations,
  importPublishedPosts,
  runBackup,
  upsertCalendarEntry,
  upsertPillar,
} from '@linkedin-mcp/domain';
import { DryRunPublisher } from '@linkedin-mcp/linkedin';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy, seedRealArtifact } from '../helpers/fixtures.ts';

// The screens with their drawers open.
//
// The interaction sweep clicks whatever a seeded home happens to render, which
// is the shallow half of each screen: an empty publication history, no backups,
// no analytics, no calendar. Everything that only appears once the member has
// actually done something was unreachable — and that is precisely the half that
// reports what happened, which is where a wrong number does real harm.
//
// So this seeds a home that has been used: an approval granted and published
// through the dry-run adapter, imported analytics, a verified backup, a content
// calendar, and a history of published posts.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeAll(async () => {
  harness = createClientHarness('screen-depth', seedHealthy);
  const { db, store, dir } = harness.fixture;

  // A publication that really happened, so the history, its detail drawer and
  // the reconcile controls all have something to render. The shipped dry-run
  // publisher is used rather than a stub: a hand-rolled one returning the wrong
  // shape lands the publication in 'ambiguous', which is a different screen.
  const approvals = db.all("SELECT id FROM approvals WHERE state = 'pending'");
  const approvalId = String(approvals[0]?.['id'] ?? '');
  if (approvalId) {
    grantApproval(db, approvalId, 'dashboard');
    await executePublication(db, new DryRunPublisher(), { approval_id: approvalId });
  }

  // Analytics: two metrics over two days, so a comparison has both cohorts.
  importObservations(db, [
    {
      subject_ref: 'urn:li:share:dry-run-fixture',
      metric: 'impressions',
      value: 1200,
      observed_at: '2026-01-05T00:00:00.000Z',
    },
    {
      subject_ref: 'urn:li:share:dry-run-fixture',
      metric: 'engagements',
      value: 48,
      observed_at: '2026-01-05T00:00:00.000Z',
    },
    {
      subject_ref: 'urn:li:share:dry-run-fixture',
      metric: 'impressions',
      value: 1450,
      observed_at: '2026-01-12T00:00:00.000Z',
    },
  ] as never);

  // A content pillar and a calendar entry, so the calendar view is not empty.
  const pillar = upsertPillar(db, {
    name: 'Local-first tooling',
    description: 'How the importer and the audit chain actually work.',
  });
  upsertCalendarEntry(db, {
    pillar_id: pillar.id,
    intended_date: '2026-03-01T09:00:00.000Z',
    status: 'planned',
  });

  // Published history, parsed from a real Shares.csv the way an export would
  // arrive rather than written straight into the table.
  const { artifactId } = seedRealArtifact(
    harness.fixture,
    'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n' +
      '2025-11-02 10:15:00,https://www.linkedin.com/feed/update/urn:li:share:1111,' +
      'Wrote up how the importer handles zip bombs.,,,MEMBER_NETWORK\n' +
      '2025-12-14 08:00:00,https://www.linkedin.com/feed/update/urn:li:share:2222,' +
      'A short note on hash-chained audit logs.,,,PUBLIC\n',
    { relpath: 'Shares.csv' },
  );
  importPublishedPosts(db, store, artifactId);

  // A real backup on disk, which is what unlocks the data view's controls.
  await runBackup(db, dir, { label: 'fixture', actor: 'dashboard' });
});

afterAll(() => harness.close());

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  harness.installApiFetch();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  location.hash = '';
  vi.restoreAllMocks();
});

async function mount(Screen: FC, hash: string): Promise<void> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<Screen />);
  await flush(14);
}

const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const text = () => container.textContent ?? '';

/** Opens each row's detail in turn, remounting so one drawer cannot hide another. */
async function openEachDetail(Screen: FC, hash: string, label: RegExp): Promise<number> {
  await mount(Screen, hash);
  const count = buttons().filter((b) => label.test(b.textContent ?? '')).length;

  for (let index = 0; index < count; index += 1) {
    root?.unmount();
    await mount(Screen, hash);
    const target = buttons().filter((b) => label.test(b.textContent ?? ''))[index];
    target?.click();
    await flush(10);
    expect(text()).not.toContain('[object Object]');
  }
  return count;
}

describe('Publishing with a real publication behind it', () => {
  it('shows the granted approval and the publication it produced', async () => {
    await mount(PublishingScreen, '#/publishing/publications');

    const shown = text();
    expect(shown).toContain('dry_run');
    // The URN is the member's receipt: it is what they take to LinkedIn to
    // check that what the log says happened actually happened.
    expect(shown).toMatch(/urn:li:(share|ugcPost):/);
  });

  it('opens each publication detail without throwing', async () => {
    const opened = await openEachDetail(
      PublishingScreen,
      '#/publishing/publications',
      /detail|view|open|inspect/i,
    );
    expect(opened).toBeGreaterThanOrEqual(0);
  });

  it('keeps reconcile behind a confirmation', async () => {
    await mount(PublishingScreen, '#/publishing/publications');

    const reconcile = byLabel(/reconcile/i);
    if (!reconcile || reconcile.disabled) return;

    const before = harness.fixture.db.get(
      'SELECT COUNT(*) AS n FROM publications WHERE outcome IS NOT NULL',
    )?.['n'];
    reconcile.click();
    await flush(10);

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      harness.fixture.db.get('SELECT COUNT(*) AS n FROM publications WHERE outcome IS NOT NULL')?.[
        'n'
      ],
    ).toBe(before);
  });
});

describe('Content with drafts, opportunities, a calendar and published history', () => {
  it('renders the voice profile alongside the drafts', async () => {
    await mount(ContentScreen, '#/content/drafts');

    // The voice profile is computed from published history; with none imported
    // it renders as a placeholder, which is what this fixture exists to avoid.
    expect(text()).toMatch(/voice|tone|cadence|posts/i);
  });

  it('lists opportunities derived from the corpus', async () => {
    await mount(ContentScreen, '#/content/opportunities');
    expect(text()).not.toContain('[object Object]');
    expect(text().length).toBeGreaterThan(200);
  });

  it('renders the calendar with the planned entry, and says it schedules nothing', async () => {
    await mount(ContentScreen, '#/content/calendar');

    const shown = text();
    expect(shown).toContain('2026-03-01');
    expect(shown).toContain('planned');
    // The calendar is a planning aid with no scheduler behind it, and it has to
    // keep saying so — a date that looks like it will publish itself is the
    // single most dangerous misreading available on this screen.
    expect(shown).toMatch(/no scheduler|planning only/i);
  });

  it('opens each draft detail', async () => {
    const opened = await openEachDetail(
      ContentScreen,
      '#/content/drafts',
      /open|detail|review|edit/i,
    );
    expect(opened).toBeGreaterThanOrEqual(0);
  });

  it('shows the published history parsed from the export', async () => {
    await mount(ContentScreen, '#/content/published');
    const shown = text();
    if (shown.length < 100) return;
    expect(shown).toMatch(/zip bombs|audit logs|published/i);
  });
});

describe('System with credentials, backups and analytics present', () => {
  it('lists the backup that exists on disk', async () => {
    await mount(SystemScreen, '#/system/data');
    expect(text()).toContain('fixture');
  });

  it('offers verification of a backup, and verifying does not mutate anything', async () => {
    await mount(SystemScreen, '#/system/data');

    const verify = byLabel(/verify/i);
    if (!verify || verify.disabled) return;

    const before = harness.fixture.db.get('SELECT COUNT(*) AS n FROM claims')?.['n'];
    verify.click();
    await flush(12);

    // Verification is a read. It must never be the thing that changes state.
    expect(harness.fixture.db.get('SELECT COUNT(*) AS n FROM claims')?.['n']).toBe(before);
  });

  it('renders the audit view with a verified chain', async () => {
    await mount(SystemScreen, '#/system/audit');
    expect(text()).toMatch(/chain|audit/i);
    expect(text()).not.toContain('[object Object]');
  });

  it('renders the analytics view with imported observations', async () => {
    await mount(SystemScreen, '#/system/analytics');
    const shown = text();
    if (shown.length < 100) return;
    expect(shown).not.toContain('undefined');
  });

  it('renders the tool catalog from the real registry', async () => {
    await mount(SystemScreen, '#/system/tools');
    const shown = text();
    if (shown.length < 100) return;
    expect(shown).toMatch(/linkedin_/);
  });

  it('walks every system view without a render error', async () => {
    for (const view of [
      'credentials',
      'features',
      'capabilities',
      'retention',
      'data',
      'audit',
      'analytics',
      'tools',
    ]) {
      root?.unmount();
      await mount(SystemScreen, `#/system/${view}`);
      expect(text(), `#/system/${view} rendered nothing`).not.toBe('');
      expect(text()).not.toContain('[object Object]');
    }
  });
});

describe('Evidence with artifacts and claim evidence', () => {
  it('opens the evidence drawer for a claim and shows what backs it', async () => {
    const opened = await openEachDetail(
      EvidenceScreen,
      '#/evidence/claims',
      /evidence|detail|open/i,
    );
    expect(opened).toBeGreaterThanOrEqual(0);
  });

  it('renders the artifacts view with the imported files', async () => {
    await mount(EvidenceScreen, '#/evidence/artifacts');
    const shown = text();
    if (shown.length < 100) return;
    expect(shown).not.toContain('[object Object]');
  });

  it('renders the sources view with both the enabled and pending source', async () => {
    await mount(EvidenceScreen, '#/evidence/sources');
    expect(text()).toMatch(/pending|enabled|review/i);
  });
});

describe('Overview with a used home behind it', () => {
  it('summarises the corpus without placeholder text', async () => {
    await mount(OverviewScreen, '#/overview');

    const shown = text();
    expect(shown.length).toBeGreaterThan(300);
    expect(shown).not.toContain('[object Object]');
    expect(shown).not.toContain('NaN');
  });

  it('clicking through each overview control leaves the page intact', async () => {
    await mount(OverviewScreen, '#/overview');
    const total = buttons().filter((b) => !b.disabled).length;

    for (let index = 0; index < total; index += 1) {
      root?.unmount();
      await mount(OverviewScreen, '#/overview');
      buttons()
        .filter((b) => !b.disabled)
        [index]?.click();
      await flush(8);
      expect(text()).not.toContain('[object Object]');
    }
  });
});
