# LinkedIn review dashboard

The dashboard is the optional visual support and human-control surface for the LinkedIn app. The MCP server remains the primary workflow engine. The dashboard runs only on loopback and uses the same SQLite database, artifact store, settings, audit history, encrypted credential vault, domain services, and MCP tool registry.

You do not need to start it to use the MCP server.

## Shared-state behavior

The dashboard is a view over the same durable application state used by every MCP process. Drafts, revisions, decisions, approvals, profile progress, sources, publication history, settings, and credentials do not belong to a browser session. Closing either surface does not remove them.

Both surfaces can run simultaneously. SQLite WAL mode and bounded write retries coordinate committed changes, while the dashboard refreshes its mounted screen every 15 seconds and immediately when its window regains focus. This is local synchronization for one Windows user; it does not copy the live database to another computer or cloud folder.

To configure supported AI clients with the same home automatically, run from the repository root:

```powershell
npm run setup:mcp
```

## Start the dashboard

From the repository root:

```powershell
npm install
npm run dashboard
```

The development runner builds the browser client once, starts the dashboard server, and watches client and server files. It prints a URL similar to:

```text
http://127.0.0.1:4780/#t=<single-use-token>
```

Open the exact printed URL. The token is exchanged for a session cookie and removed from the address bar. The dashboard binds only to `127.0.0.1`; it is not a LAN or hosted web app.

To run from this folder directly:

```powershell
npm run dev
```

To run without file watchers from the repository root:

```powershell
npm run build -w @linkedin-mcp/dashboard
$env:NODE_ENV = "production"
npx tsx linkedin-dashboard/src/server.ts
```

## Use a different data home

Set the variable before starting the dashboard:

```powershell
$env:LINKEDIN_MCP_HOME = "C:\path\to\linkedin-mcp-data"
npm run dashboard
```

Use the same absolute value in your MCP client configuration. Relative values are rejected. The setup assistant writes the chosen absolute value into every selected client and saves it for future dashboard sessions.

The default home is `%LOCALAPPDATA%\linkedin-mcp`. The default port is `4780`; it can be changed through the confirmed `linkedin_settings_set` MCP tool using the `dashboard.port` setting.

## What the dashboard provides

The interface has seven destinations:

| Area | Purpose |
|---|---|
| Setup | What is configured, and the three ways to get first evidence in |
| Overview | Work queue, blockers, and next actions |
| Evidence | Sources, claims, conflicts, and artifact inspection |
| Profile | Canonical profile, snapshots, scores, change sets, and copy/paste patches |
| Content | Drafts, validation, opportunities, pillars, calendar, and published history |
| Publishing | Exact-revision approval review and publication reconciliation |
| System | Shared feature controls, capabilities, credentials, **All MCP tools**, audit, analytics, backups, export, and purge |

Purpose-built screens make common review work easier. **System → All MCP tools** exposes every registered MCP operation through the same input/output schemas and handlers, so less common operations are not missing from the dashboard.

The dashboard is especially useful for decisions that should be made by a person rather than an AI agent:

- enabling a filesystem source after reviewing its path and trust class;
- verifying or rejecting evidence claims;
- resolving factual conflicts;
- reviewing profile patches and marking manual application;
- storing LinkedIn credentials in the DPAPI-backed vault;
- enabling real publishing after a successful credential probe;
- granting or denying a single-use publication approval;
- destructive artifact or full-data purge operations.

Every human-control operation also has a dashboard-free CLI. Run it without arguments for an interactive menu:

```powershell
npm run control
npm run evidence:add -- "C:\path\to\cv.pdf" document personal_doc "Current CV"
npm run control -- lane configure read --client-id <client_id>
npm run control -- feature list
npm run control -- feature enable live_publishing --confirm
npm run control -- approval preview <approval_id>
npm run control -- approval grant <approval_id> --revision-hash <hash_from_preview>
```

Credential entry remains human-only and outside MCP. Publication decisions can be recorded in the dashboard, control CLI, or by `linkedin_approval_decide` after the connected agent asks for an explicit command bound to the approval ID and revision hash. Once credentials are stored, their ciphertext and DPAPI-wrapped key are part of the shared home, so MCP external-capability tools can use them without receiving or revealing their values.

**System → Features** controls the same nine policy groups used by MCP. Changes take effect from the shared SQLite database on both surfaces. All groups default enabled except real `live_publishing`; enabling that group additionally requires a verified write credential. Disabling a group blocks its purpose-built dashboard routes and its MCP handlers, while the feature-control screen/tool remains reachable so the setting can be restored.

In the MCP-first evidence workflow, the agent imports and inspects enabled sources, verifies artifact integrity, and proposes cited claims. The human reviews new statements and every conflict, then verifies, rejects, marks ambiguous, merges, or supplies corrected wording through MCP conversation or the dashboard. Corrections create a new claim rather than rewriting history.

## Security behavior

- Every request is Host-checked and restricted to loopback.
- The launch token is random, single-use, and sent in the URL fragment so it never reaches HTTP logs.
- Mutations require an authenticated session, same-origin request, and explicit confirmation.
- Responses containing application data use `Cache-Control: no-store`.
- Browser assets are local, content-hashed, and served under a strict Content Security Policy.
- LinkedIn tokens are encrypted at rest with an AES key wrapped by Windows DPAPI for the current user.
- Stored token values are never returned by read routes.
- A dashboard restart ends in-memory sessions; use the newly printed launch URL.

## Build notes

`npm run build -w @linkedin-mcp/dashboard` builds the browser entries into `linkedin-dashboard/dist/client`. The server refuses to start if those assets do not exist, preventing a silently blank approval screen.

Useful checks from the repository root:

```powershell
npm run typecheck
npm test -- tests/integration/dashboard-client.test.tsx
npm test -- tests/integration/dashboard-security.test.ts
npm run test:visual
```

See [docs/dashboard-design.md](../docs/dashboard-design.md) for design-system details and [docs/dashboard-manual-checks.md](../docs/dashboard-manual-checks.md) for the manual viewport/accessibility checklist.

## Troubleshooting

| Symptom | Fix |
|---|---|
| “client has not been built” | Run `npm run build -w @linkedin-mcp/dashboard`. |
| Port 4780 is already in use | Use the existing dashboard or change `dashboard.port` before restarting. |
| Printed link says the session ended | Restart the dashboard and use the new single-use URL. |
| Dashboard shows no MCP data | Make `LINKEDIN_MCP_HOME` identical in both processes. |
| Credential storage reports DPAPI failure | Run under the same Windows account that created the home; copied DPAPI material cannot be decrypted elsewhere. |
| Visual tests cannot start | Install the Playwright browser required by the test configuration. |

Return to the [application README](../README.md) or configure the [MCP server](../linkedin-mcp-server/README.md).
