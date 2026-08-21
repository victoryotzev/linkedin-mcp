// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSources } from '@linkedin-mcp/domain';
import { SetupScreen } from '../../linkedin-dashboard/src/client/screens/Setup.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';

// The first-run screen.
//
// This is the only screen a member sees before they have anything, and the one
// that decides whether they ever get started. It offers three ways in — point
// at files, upload them, or just write about yourself — and each one ends with
// bytes in the artifact store, so each one is a place where a mistake is
// expensive.
//
// It is also where a real bug hid: every request went to /api/api/... and the
// whole screen 404'd silently. These drive the requests for real.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeAll(() => {
  // Deliberately an empty home: this screen exists for a member who has none of
  // the things a seeded fixture would give them.
  harness = createClientHarness('setup-screen');
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

async function mount(): Promise<void> {
  location.hash = '#/setup';
  root = createRoot(container);
  root.render(<SetupScreen />);
  await flush(16);
}

/**
 * A submit event hono will accept from a test.
 *
 * hono's form component reads `ev.detail` on any untrusted submit event, so a
 * plain Event throws inside hono before our own handler ever runs. A
 * CustomEvent carrying an empty detail takes hono's early return and leaves the
 * component's own onSubmit to do the work.
 */
function submitEvent(): Event {
  return new CustomEvent('submit', { bubbles: true, cancelable: true, detail: {} });
}

const text = () => container.textContent ?? '';
const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));

describe('the readiness checklist', () => {
  it('reports every check, each with a state a member can read', async () => {
    await mount();

    const shown = text();
    expect(shown).toMatch(/ready|needs you|not available/);
    expect(shown).not.toContain('[object Object]');
    expect(shown).not.toContain('undefined');
  });

  it('does not dress an unavailable check as something the member neglected', async () => {
    await mount();

    // Without a LinkedIn developer app there is nothing to do, and outside the
    // EEA or Switzerland there is nothing that can be done at all. Calling that
    // "needs you" sends the member after something unreachable.
    // The smallest element containing the row, so an ancestor holding the whole
    // checklist cannot make this pass or fail for the wrong reason.
    const linkedInRow = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .filter((el) => /LinkedIn connection/i.test(el.textContent ?? ''))
      .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0];
    if (!linkedInRow) return;
    expect(linkedInRow.textContent).not.toMatch(/needs you/);
  });
});

describe('uploading documents', () => {
  it('imports the files that were chosen and reports what happened to each', async () => {
    await mount();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input, 'the screen should offer a file picker').toBeTruthy();
    if (!input) return;

    const file = new File(
      ['# Portfolio\n\nBuilt a deterministic CSV parser and a backup verifier.\n'],
      'portfolio.md',
      { type: 'text/markdown' },
    );
    Object.defineProperty(input, 'files', { value: [file], configurable: true });

    const before = listSources(harness.fixture.db, {}).length;
    container.querySelector('form')?.dispatchEvent(submitEvent());
    await flush(30);

    // The bytes are copied into the store; the member's own file is untouched,
    // which is the promise the screen makes right above the button.
    expect(listSources(harness.fixture.db, {}).length).toBeGreaterThan(before);
    expect(text()).toMatch(/imported/i);
    expect(text()).toContain('portfolio.md');
  });

  it('does nothing at all when no file was chosen', async () => {
    await mount();
    const before = listSources(harness.fixture.db, {}).length;

    container.querySelector('form')?.dispatchEvent(submitEvent());
    await flush(16);

    expect(listSources(harness.fixture.db, {}).length).toBe(before);
    expect(text()).not.toMatch(/imported \d+ of/i);
  });

  it('accounts for every file that was chosen, whatever happened to it', async () => {
    await mount();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return;
    Object.defineProperty(input, 'files', {
      value: [
        new File(['# Notes\n\nSome writing of mine.\n'], 'notes.md', {
          type: 'text/markdown',
        }),
        new File([new Uint8Array([0, 1, 2, 3])], 'photo.jpeg', { type: 'image/jpeg' }),
      ],
      configurable: true,
    });

    container.querySelector('form')?.dispatchEvent(submitEvent());
    await flush(30);

    // Every chosen file is listed by name. A file that silently vanished would
    // leave the member believing evidence exists that does not.
    const shown = text();
    expect(shown).toContain('notes.md');
    expect(shown).toContain('photo.jpeg');
    expect(shown).toMatch(/imported \d+ of 2/i);
  });

  it('surfaces a refusal from the server rather than appearing to succeed', async () => {
    await mount();
    harness.installApiFetch((path) =>
      path.includes('/intake/upload')
        ? new Response(
            JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'that file was refused' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        : null,
    );

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'note.md', { type: 'text/markdown' })],
      configurable: true,
    });

    container.querySelector('form')?.dispatchEvent(submitEvent());
    await flush(24);

    expect(text()).toMatch(/refused/i);
  });
});

describe('describing yourself in your own words', () => {
  function describeBox(): HTMLTextAreaElement | null {
    return container.querySelector<HTMLTextAreaElement>('textarea');
  }

  async function type(value: string): Promise<void> {
    const box = describeBox();
    if (!box) return;
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(10);
  }

  it('keeps the save closed until there is enough to be worth storing', async () => {
    await mount();
    expect(describeBox(), 'the screen should offer a free-text box').toBeTruthy();

    const save = byLabel(/save this/i);
    expect(save?.disabled).toBe(true);

    await type('too short');
    expect(byLabel(/save this/i)?.disabled).toBe(true);
    // And it says how much more is needed rather than just staying grey.
    expect(text()).toMatch(/more characters?/i);
  });

  it('stores what was written as self-attested evidence', async () => {
    await mount();
    const before = listSources(harness.fixture.db, {}).length;

    await type(
      'I build local-first developer tooling in TypeScript, mostly around evidence and ' +
        'provenance. Recently I have been working on an MCP server that keeps a hash-chained ' +
        'audit log of everything it does on my behalf.',
    );

    const save = byLabel(/save this/i);
    expect(save?.disabled).toBe(false);
    container.querySelectorAll('form')[1]?.dispatchEvent(submitEvent());
    await flush(30);

    expect(listSources(harness.fixture.db, {}).length).toBeGreaterThan(before);
    expect(text()).toMatch(/self-attested/i);
  });

  it('says plainly that self-attested text ranks below a document', async () => {
    await mount();

    // This is the honesty the whole product rests on: something the member
    // typed about themselves is not evidence in the same sense as a file they
    // wrote earlier, and the screen has to say so before they type it.
    expect(text()).toMatch(/self-attested/i);
    expect(text()).toMatch(/ranks below|self-reported/i);
  });

  it('reports a refusal from the server', async () => {
    await mount();
    harness.installApiFetch((path) =>
      path.includes('/intake/describe')
        ? new Response(
            JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'the text was refused' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        : null,
    );

    await type(
      'I build local-first developer tooling in TypeScript, mostly around evidence and ' +
        'provenance, and I have been doing it for a while now across several projects.',
    );
    container.querySelectorAll('form')[1]?.dispatchEvent(submitEvent());
    await flush(24);

    expect(text()).toMatch(/refused/i);
  });
});

describe('every control on the screen', () => {
  // Submit buttons are driven through submitEvent() in the tests above rather
  // than clicked here. happy-dom turns a click on one into requestSubmit(),
  // which dispatches an untrusted submit event, and hono's form component reads
  // ev.detail on those and throws before any handler of ours runs. That is a
  // library interaction, not a fault in this screen, and swallowing it in a
  // sweep would hide real errors alongside it.
  const clickable = () => buttons().filter((b) => !b.disabled && b.type !== 'submit');

  it('responds without throwing', async () => {
    await mount();
    const count = clickable().length;

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount();
      clickable()[index]?.click();
      await flush(12);
      expect(text()).not.toContain('[object Object]');
    }
  });
});
