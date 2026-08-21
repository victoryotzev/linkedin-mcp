// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResource } from '../../linkedin-dashboard/src/client/lib/store.ts';

let root: Root;

function SyncProbe() {
  const resource = useResource<{ value: number }>('/sync-probe');
  return <output>{resource.state.status}</output>;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ value: 1 }), { status: 200 })),
  );
  root = createRoot(document.getElementById('mount') as HTMLElement);
});

afterEach(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('dashboard and MCP shared-state refresh', () => {
  it('reloads mounted data when the member returns to the dashboard', async () => {
    root.render(<SyncProbe />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
