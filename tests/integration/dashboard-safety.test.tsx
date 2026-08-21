// @vitest-environment happy-dom
import { createRoot } from 'hono/jsx/dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createPalette } from '../../linkedin-dashboard/src/client/lib/commands.ts';
import { DESTRUCTIVE_ACTION_IDS } from '../../linkedin-dashboard/src/client/lib/destructive.ts';
import { INJECTION_FIXTURE, seedHealthy, seedRealArtifact } from '../helpers/fixtures.ts';
import { proposeClaim } from '@linkedin-mcp/domain';

// The safety controls, exercised against the REAL API.
//
// The client is mounted for real and its fetch is routed straight into
// buildDashboardApp over a seeded database. That closes the blind spot the old
// node:vm test had — its stub returned one hand-maintained union object for
// every request, so a renamed response field would have gone unnoticed forever.

let harness: ClientHarness;
let fixture: ClientHarness['fixture'];
let seeded: ReturnType<typeof seedHealthy>;

beforeAll(() => {
  harness = createClientHarness('safety', (fx) => {
    seeded = seedHealthy(fx);
  });
  fixture = harness.fixture;
});

afterAll(() => harness.close());

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  harness.installApiFetch();
});

afterEach(() => {
  document.body.innerHTML = '';
});

function grantButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Approve exactly this text',
  );
}

describe('the approval decision cannot be made blind', () => {
  it('shows the byte-exact bound revision beside the grant control', async () => {
    createRoot(container).render(<PublishingScreen />);
    await flush();

    const preview = document.querySelector(`[data-approval-preview="${seeded.approvalId}"]`);
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe('The project contains 181 test files.');

    const grant = grantButton();
    expect(grant).toBeDefined();
    expect(grant?.disabled).toBe(false);
  });

  it('disables the grant control when the bound revision cannot be shown', async () => {
    // Revisions are append-only, so a missing bound revision means the draft
    // history is damaged. approvalPreview refuses to substitute the current
    // text — and without the exact bytes on screen, approving them is not a
    // decision anybody can make.
    fixture.db.run('DELETE FROM draft_revisions WHERE draft_id = ?', seeded.draftId);

    createRoot(container).render(<PublishingScreen />);
    await flush();

    expect(document.querySelector(`[data-approval-preview="${seeded.approvalId}"]`)).toBeNull();
    const grant = grantButton();
    expect(grant?.disabled).toBe(true);
    expect(document.body.textContent).toContain('The bound revision could not be loaded');
  });
});

describe('nothing is optimistic', () => {
  it('leaves the approval pending while the grant is still in flight', async () => {
    createRoot(container).render(<PublishingScreen />);
    await flush();

    // A request that never resolves. If any displayed state moves, the
    // interface is reporting something the server has not agreed to.
    harness.installApiFetch((path) =>
      path.includes('/grant') ? (new Promise(() => {}) as unknown as Response) : null,
    );

    grantButton()?.click();
    await flush();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Approve exactly this text' && button.closest('.dialog'),
    );
    confirm?.click();
    await flush();

    expect(document.body.textContent).toContain('Pending approval');
    expect(document.body.textContent).not.toContain('armed');
    // And the server agrees: nothing was granted.
    const state = fixture.db.get('SELECT state FROM approvals WHERE id = ?', seeded.approvalId);
    expect(String(state?.['state'])).toBe('pending');
  });
});

describe('advanced MCP tool console', () => {
  it('requires a visible second confirmation before a state-changing tool runs', async () => {
    let runCalls = 0;
    harness.installApiFetch((path) => {
      if (path === '/api/tools') {
        return new Response(
          JSON.stringify({
            tools: [
              {
                name: 'linkedin_mutating_test',
                title: 'Mutating test',
                description: 'Changes shared state.',
                permission: 'local-write',
                annotations: {
                  readOnlyHint: false,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
                input_schema: { type: 'object' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.includes('/api/tools/linkedin_mutating_test/run')) {
        runCalls += 1;
        return new Response(JSON.stringify({ result: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return null;
    });
    location.hash = '#/system/tools';
    createRoot(container).render(<SystemScreen />);
    await flush();

    const run = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Run Mutating test' && !button.closest('.dialog'),
    );
    run?.click();
    await flush();

    expect(runCalls).toBe(0);
    expect(document.body.textContent).toContain('This operation changes shared application state');

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Run tool' && button.closest('.dialog'),
    );
    confirm?.click();
    await flush();
    expect(runCalls).toBe(1);
  });
});

describe('untrusted imported content stays in its envelope', () => {
  it('never renders instruction-shaped evidence outside a marked container', async () => {
    // Imported text is data. Instructions found inside it are content to
    // report, never commands to follow — so it may appear in one place and one
    // place only, wrapped in the envelope that says exactly that.
    const { artifactId } = seedRealArtifact(fixture, INJECTION_FIXTURE, {
      relpath: 'notes/hostile.md',
    });
    const claim = proposeClaim(fixture.db, {
      statement: 'A note in the corpus contains instruction-shaped text.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });

    createRoot(container).render(<EvidenceScreen />);
    await flush();

    // Open the claim whose evidence carries the hostile text. Each row's action
    // names the claim it acts on, so the right one is addressable directly
    // rather than by correlating two parallel lists by position.
    const review = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.getAttribute('aria-label')?.includes('instruction-shaped text'),
    );
    expect(review).toBeDefined();
    review?.click();
    await flush();

    const needle = 'IGNORE PREVIOUS INSTRUCTIONS';
    expect(document.body.textContent).toContain(needle);

    // Every element whose own text is the hostile string must sit inside a
    // container marked untrusted.
    const offenders: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      const ownText = [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent ?? '')
        .join('');
      if (!ownText.includes(needle)) continue;
      if (!element.closest('[data-untrusted]')) offenders.push(element.tagName);
    }
    expect(offenders).toEqual([]);
    expect(claim.id).toBeTruthy();
  });
});

describe('the command palette', () => {
  it('offers no irreversible action', () => {
    const ids = new Set(
      createPalette()
        .list()
        .map((command) => command.id),
    );
    for (const destructive of DESTRUCTIVE_ACTION_IDS) {
      expect(ids.has(destructive)).toBe(false);
    }
  });
});
