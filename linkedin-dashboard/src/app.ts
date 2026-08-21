import { Hono, type Context } from 'hono';
import { requireFeatureEnabled } from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import type { AssetProvider } from './assets.ts';
import { DashboardAuth, guard, issueSessionCookie } from './auth.ts';
import { renderShell } from './html.ts';
import { contentRoutes } from './routes/content.ts';
// The previous UI is gone. It lived in ui.ts as one 405-line template literal
// and served '/' from P3 until cutover. It is still recoverable from history:
// `git show e2f676c:apps/dashboard/src/ui.ts` -- note that apps/dashboard/ is a
// pre-restructure path and no longer exists in the tree.
import { evidenceRoutes } from './routes/evidence.ts';
import { intakeRoutes } from './routes/intake.ts';
import { overviewRoutes } from './routes/overview.ts';
import { profileRoutes } from './routes/profile.ts';
import { publishingRoutes } from './routes/publishing.ts';
import { systemRoutes } from './routes/system.ts';
import { toolRoutes } from './routes/tools.ts';
import type { ApiDeps } from './routes/types.ts';
import { dashboardFeatureForPath } from './featureRouting.ts';

export interface DashboardDeps extends ApiDeps {
  auth: DashboardAuth;
  /** Built browser assets. Absent means the shell answers 503 with the build command. */
  assets?: AssetProvider;
}

// Applied to every response, the policy included.
//
// The CSP used to be scoped to the new surface only, because the previous page
// was one inline <script> and one inline <style> and a strict policy would have
// killed it. With that page gone, nothing in this app emits inline code, so the
// policy covers everything — which is the point of having removed it.
const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Nothing but 'self', and no 'unsafe-inline' anywhere. Possible only because
// the shell carries no inline script or style — which is also why the theme
// bootstrap is a separate file rather than a two-line inline script.
// Asserted character-for-character by tests/integration/dashboard-security.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

// Thin HTTP shell over the SAME domain services and exact tool registry the MCP
// server uses — no business logic lives here. Human-authority actions are also
// available through the explicit local control CLI, but remain structurally
// unreachable from the MCP/model channel.
export function buildDashboardApp(deps: DashboardDeps): Hono {
  const { auth } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ error: err.toResultPayload() }, 400);
    }
    console.error('[dashboard]', err);
    return c.json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  });

  app.use('*', async (c, next) => {
    await next();
    for (const [header, value] of Object.entries(BASE_SECURITY_HEADERS)) {
      c.header(header, value);
    }
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  });

  // Every API response describes mutable review state, some of it decision-
  // critical (approval previews, capability status), and the session exchange
  // carries a Set-Cookie. None of it may sit in a cache.
  //
  // Mounted on the root app rather than on the api sub-router below, because
  // /api/session is registered directly on the app — the sub-router's guard
  // would have missed it, and so did the first version of this middleware.
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const shell = (c: Context) => {
    if (!deps.assets) {
      return c.text(
        'The dashboard client has not been built. Run: npm run build -w @linkedin-mcp/dashboard',
        503,
      );
    }
    c.header('Cache-Control', 'no-store');
    return c.html(renderShell(deps.assets.manifest()));
  };

  // The shell carries no data, so it needs no session — the launch token rides
  // in the URL fragment and never reaches the server on this request.
  const rootGuard = guard(auth, { requireSession: false });

  app.get('/', rootGuard, shell);
  // Kept so the URL printed during the migration still lands somewhere useful.
  app.get('/preview', rootGuard, (c) => c.redirect('/', 302));

  // Assets carry no data, so they need no session — exactly like '/'. The Host
  // allowlist and the Sec-Fetch-Site check still apply.
  app.get('/assets/:file', rootGuard, (c) => {
    const file = c.req.param('file');
    const asset = file === undefined ? null : deps.assets?.resolve(file);
    if (!asset) return c.text('not found', 404);
    c.header('Content-Type', asset.contentType);
    // Safe because the content hash is in the URL: changed bytes change the URL.
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(asset.body);
  });

  // Token exchange: launch token (from the printed URL fragment) -> session.
  app.post('/api/session', guard(auth, { requireSession: false }), async (c) => {
    const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
    const sessionId = body.token ? auth.exchangeToken(body.token) : null;
    if (!sessionId) return c.json({ error: 'bad_token' }, 403);
    issueSessionCookie(c, sessionId);
    return c.json({ ok: true });
  });

  const api = new Hono();
  api.use('*', guard(auth, { requireSession: true }));
  api.use('*', async (c, next) => {
    const feature = dashboardFeatureForPath(c.req.path);
    if (feature !== null) requireFeatureEnabled(deps.db, feature);
    await next();
  });

  // The cheapest possible "is my cookie still good": the guard above has
  // already answered by the time this runs. The client asks on boot instead of
  // fetching a real collection just to find out.
  api.get('/session/check', (c) => c.json({ ok: true }));
  api.route('/', overviewRoutes(deps));
  api.route('/', evidenceRoutes(deps));
  api.route('/', intakeRoutes(deps));
  api.route('/', profileRoutes(deps));
  api.route('/', contentRoutes(deps));
  api.route('/', publishingRoutes(deps));
  api.route('/', systemRoutes(deps));
  api.route('/', toolRoutes(deps));

  app.route('/api', api);
  return app;
}
