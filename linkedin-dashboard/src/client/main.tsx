import { createRoot } from 'hono/jsx/dom/client';
import { AppShell } from './AppShell.tsx';
import './styles/index.css';

// Mount point. The server renders a static fallback panel inside #root saying
// the client did not load; replacing it is this file's first act, so a bundle
// that never parses leaves an actionable message on screen instead of a blank
// page. That matters because the dashboard is the only surface that can approve
// a publication.

const root = document.getElementById('root');
export const dashboardRoot = root ? createRoot(root) : undefined;
if (root) {
  root.replaceChildren();
  dashboardRoot?.render(<AppShell />);
}
