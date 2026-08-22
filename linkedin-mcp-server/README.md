# LinkedIn MCP server

The MCP server is the primary workflow engine of the LinkedIn app. It is a local stdio process and runs independently of the optional dashboard, which is a synchronized visual support surface.

**Supported platforms: Windows 10 or later, Linux, and macOS.** All three run
the full test suite on every push. Evidence import accepts each platform's own
absolute-path shape, and the credential vault uses DPAPI on Windows, the login
Keychain on macOS, and a key derived from the machine id on Linux. The optional
LinkedIn read lane is limited further: LinkedIn issues Member Data Portability
tokens only to members located in the European Economic Area or Switzerland.

## Build and verify

Run from the repository root:

```powershell
npm ci
npm run mcp:build
npm run inspect:list
```

The compiled entrypoint is:

```text
<REPO>\linkedin-mcp-server\dist\index.js
```

Your MCP client should start that file with Node. Do not launch the dashboard, and do not start a second copy of the MCP server manually; a stdio host owns the process lifecycle.

For development only:

```powershell
npm run mcp:dev
```

## Interactive setup assistant

**Windows only.** It is PowerShell, and what it does is write the client
configuration files listed below on your behalf. On Linux, do the same thing by
hand: every client section further down shows the exact block, and the generic
three-field form is under [Other stdio MCP clients](#other-stdio-mcp-clients).
Nothing else about running the server differs between the platforms.

From the repository root, the easiest installation is:

```powershell
npm run setup:mcp
```

Choose one or more clients when prompted. The assistant:

- installs dependencies when they are missing and builds the MCP server;
- resolves absolute Node, server, and data-home paths;
- configures Codex, Claude Code, Claude Desktop, VS Code/Copilot Chat, Copilot CLI, Cursor, and Antigravity;
- replaces only the `linkedin` MCP entry and preserves other configured servers;
- creates a timestamped backup before changing an existing JSON or client configuration;
- saves the shared home for future dashboard and terminal sessions;
- never requests LinkedIn tokens or places secrets in an agent configuration.

Non-interactive examples:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-mcp.ps1 -Clients Codex,ClaudeCode,Cursor -NonInteractive
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-mcp.ps1 -All -NonInteractive -DataHome "D:\LinkedIn-MCP-Data"
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-mcp.ps1 -All -NonInteractive -DryRun
```

Windows refuses to run an unsigned `.ps1` under its default `Restricted`
execution policy, so a bare `.\setup-mcp.ps1` fails before it does anything.
`-ExecutionPolicy Bypass` applies to that one invocation and changes nothing on
the machine; `npm run setup:mcp` uses the same form. Start with `-DryRun`, which
names every file it would touch without opening any of them for writing.

Restart selected clients after setup. Run the assistant again whenever the repository moves; it is idempotent and updates the absolute server path.

## One configuration, many clients

Use absolute paths. The examples below are written with Windows paths:

```text
Node:   C:\Program Files\nodejs\node.exe
Server: C:\path\to\LinkedIn\linkedin-mcp-server\dist\index.js
Home:   C:\Users\YOUR_NAME\AppData\Local\linkedin-mcp
```

On Linux the shape of every example is identical and only the paths change:

```text
Node:   /usr/bin/node                         (`command -v node`)
Server: /path/to/LinkedIn/linkedin-mcp-server/dist/index.js
Home:   /home/YOUR_NAME/.local/share/linkedin-mcp
```

That home is the default on Linux — `$XDG_DATA_HOME/linkedin-mcp` when
`XDG_DATA_HOME` is set, otherwise `~/.local/share/linkedin-mcp`. On Windows the
default is under `%LOCALAPPDATA%`. Setting `LINKEDIN_MCP_HOME` explicitly
overrides both.

Replace those values with your paths. `LINKEDIN_MCP_HOME` is optional, but setting the same absolute value ensures every client and the dashboard use the same database, artifacts, decisions, drafts, settings, and encrypted credential vault. The assistant above does this automatically.

### Codex CLI, Codex IDE, and ChatGPT desktop

Codex clients on the same host share `~/.codex/config.toml`. The CLI is the easiest setup:

```powershell
codex mcp add linkedin `
  --env "LINKEDIN_MCP_HOME=C:\Users\YOUR_NAME\AppData\Local\linkedin-mcp" `
  -- "C:\Program Files\nodejs\node.exe" `
  "C:\path\to\LinkedIn\linkedin-mcp-server\dist\index.js"

codex mcp list
```

You can also add the same STDIO command from **Settings → MCP servers** in ChatGPT desktop or the Codex IDE extension. [Official Codex MCP guide](https://developers.openai.com/codex/mcp/)

### Claude Code CLI

```powershell
claude mcp add `
  --env "LINKEDIN_MCP_HOME=C:\Users\YOUR_NAME\AppData\Local\linkedin-mcp" `
  --transport stdio --scope user linkedin `
  -- "C:\Program Files\nodejs\node.exe" `
  "C:\path\to\LinkedIn\linkedin-mcp-server\dist\index.js"

claude mcp list
```

Use `--scope local` instead if the server should be available only in the current project. [Official Claude Code MCP guide](https://docs.anthropic.com/en/docs/claude-code/mcp)

### Claude Desktop

Open **Settings → Developer → Edit Config**, or edit `%APPDATA%\Claude\claude_desktop_config.json`, and merge this entry into `mcpServers`:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\LinkedIn\\linkedin-mcp-server\\dist\\index.js"
      ],
      "env": {
        "LINKEDIN_MCP_HOME": "C:\\Users\\YOUR_NAME\\AppData\\Local\\linkedin-mcp"
      }
    }
  }
}
```

Fully quit Claude Desktop from the system tray and reopen it. [Official local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

### VS Code with GitHub Copilot

Run **MCP: Add Server** from the Command Palette, or create `.vscode/mcp.json`:

```json
{
  "servers": {
    "linkedin": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\LinkedIn\\linkedin-mcp-server\\dist\\index.js"
      ],
      "env": {
        "LINKEDIN_MCP_HOME": "C:\\Users\\YOUR_NAME\\AppData\\Local\\linkedin-mcp"
      }
    }
  }
}
```

Open Copilot Chat in **Agent** mode, select **Configure Tools**, and confirm the local server trust prompt. [Official VS Code MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

### GitHub Copilot CLI

```powershell
copilot mcp add linkedin `
  --env "LINKEDIN_MCP_HOME=C:\Users\YOUR_NAME\AppData\Local\linkedin-mcp" `
  -- "C:\Program Files\nodejs\node.exe" `
  "C:\path\to\LinkedIn\linkedin-mcp-server\dist\index.js"

copilot mcp list
```

Copilot CLI uses `~/.copilot/mcp-config.json` globally or `.mcp.json` / `.github/mcp.json` per repository. It does **not** read `.vscode/mcp.json`. [Official Copilot CLI MCP guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)

### Cursor

Create `~/.cursor/mcp.json` for global use or `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\LinkedIn\\linkedin-mcp-server\\dist\\index.js"
      ],
      "env": {
        "LINKEDIN_MCP_HOME": "C:\\Users\\YOUR_NAME\\AppData\\Local\\linkedin-mcp"
      }
    }
  }
}
```

Enable the server and its tools in Cursor settings. [Official Cursor MCP guide](https://docs.cursor.com/context/model-context-protocol)

### Google Antigravity 2.0, IDE, and CLI

In Antigravity IDE choose **MCP Servers → Manage MCP Servers → View raw config**, or edit `~/.gemini/config/mcp_config.json` globally. A workspace can instead use `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\LinkedIn\\linkedin-mcp-server\\dist\\index.js"
      ],
      "env": {
        "LINKEDIN_MCP_HOME": "C:\\Users\\YOUR_NAME\\AppData\\Local\\linkedin-mcp"
      }
    }
  }
}
```

Refresh installed MCP servers in the UI, or run `/mcp` in Antigravity CLI. [Official Antigravity MCP guide](https://antigravity.google/docs/mcp)

### Other stdio MCP clients

Use the same three fields supported by most clients. Windows:

```json
{
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\absolute\\path\\to\\linkedin-mcp-server\\dist\\index.js"],
  "env": {
    "LINKEDIN_MCP_HOME": "C:\\absolute\\path\\to\\linkedin-mcp-data"
  }
}
```

Linux — the same three fields, and the whole of manual setup there:

```json
{
  "command": "/usr/bin/node",
  "args": ["/absolute/path/to/linkedin-mcp-server/dist/index.js"],
  "env": {
    "LINKEDIN_MCP_HOME": "/home/YOUR_NAME/.local/share/linkedin-mcp"
  }
}
```

The server does not expose HTTP or SSE. The client must support local stdio MCP servers.

## Dashboard-free onboarding

The MCP can register and enable a newly named filesystem root. After inspecting the returned path, trust class, and source ID, explicitly confirm `ENABLE <source_id>` through `linkedin_source_manage`. To register, enable, and import from a terminal in one operation instead:

```powershell
cd C:\path\to\LinkedIn
npm run evidence:add -- "C:\path\to\portfolio" folder personal_doc "Portfolio"
```

| Argument | Values |
|---|---|
| `path` | Absolute file or directory path |
| `kind` | `repo`, `document`, `folder`, `linkedin_export`, `manual` |
| `trust` | `personal_doc`, `own_repo`, `local_clone_reference` |
| `label` | Human-readable text; quote labels containing spaces |

`local_clone_reference` can demonstrate familiarity, but never authorship. The command reports its source ID, import result, and whether the original remained unchanged.

For the normal MCP-first review flow, use the `ingest_and_review_evidence` prompt. It imports from an enabled source, checks artifact integrity, proposes cited claims, and escalates statements or conflicts for an explicit human decision. Claim corrections create a replacement claim and reject or merge the old one; historical wording is never silently overwritten.

## Capabilities

The server exposes 44 tools, 5 private resources, and 5 workflow prompts. Major tool groups are:

- setup readiness, and recording a short self-description when there is no
  document to import yet;
- sources, imports, artifacts, claims, conflicts, and coverage;
- canonical profile, snapshots, diffs, scoring, and change sets;
- post drafts, deterministic validation, published history, voice, opportunities, and calendar;
- publication requests, status, dry-run execution, reconciliation, and audit;
- analytics, settings, backups, exports, retention, and targeted purge;
- optional LinkedIn capability verification, EU Data Portability synchronization, shared feature controls, and confirmed live text-post publishing.

Ask the host to list tools, or inspect the exact schemas:

```powershell
npm run inspect:list
```

## Reading the latest LinkedIn profile

Four different things can be called "my profile", and this server keeps them apart on purpose.

| | What it is | Tool |
|---|---|---|
| **Canonical** | The evidence-backed profile this app holds as authoritative. Append-only revisions, changed only by an explicit human decision. | `linkedin_profile_get`, `linkedin_profile_update` |
| **Raw Snapshot** | The rows LinkedIn's Member Snapshot API returned for one domain on one request, stored verbatim. | recorded per observation |
| **Changelog overlay** | Profile state rebuilt from Member Changelog events, only where it can be rebuilt deterministically. | `linkedin_profile_read_latest` → `freshness.event_derived` |
| **Effective observed** | What the Snapshot rendered on this read, with any domain LinkedIn could not answer carried forward from the last observation that did — every such domain named. | `linkedin_profile_read_latest` → `observed` |

`linkedin_profile_read_latest` always issues new upstream requests: it reconciles the Changelog, then fetches all ten non-sensitive profile Snapshot domains, records the observation, and reports what it found. It never answers from the stored snapshot.

### Why "latest" cannot mean "current"

- The Member Snapshot response carries **no data-generation timestamp and no completeness marker**. There is nothing in it that says which of your edits it includes.
- LinkedIn states that data "for certain domains will be available sooner than others, depending on the effort required by LinkedIn to collate this data". Domains genuinely arrive at different times.
- A domain answering with nothing is reported as `empty_or_not_ready`, never as proof that the section is empty. Page zero returning "No data found" looks identical whether you have no entries or LinkedIn has not finished collating.
- **A live request can still return upstream-stale data.** This is not hypothetical: on 2026-08-12 a fresh read returned a fingerprint byte-identical to reads from two days earlier while the Changelog already held fifteen profile edits. That case is reported as `upstream_snapshot_lag_detected`.

Every result therefore carries `guarantee: "not_guaranteed"`. There is no status meaning "confirmed current", and the portability terms separately forbid describing Portability Data as LinkedIn-verified or LinkedIn-confirmed.

### What the overlay will and will not do

Changelog events prove an edit happened; they do not prove the Snapshot has materialized it. The overlay is built only where it is deterministic:

- a position `CREATE` followed by later `PARTIAL_UPDATE`s, merged by resource id;
- a `DELETE` applied only to a position an observed `CREATE` established;
- directly identified person fields such as the headline, when the payload carries a usable value.

Everything else is **surfaced, not guessed**: partial updates and deletes for a resource id no observed CREATE established, empty activities, `FAILURE` events with no successful replay, and fields with no deterministic mapping. Snapshot position rows carry no LinkedIn ids at all, so matching an event to one by title, company or dates would be a heuristic presented as a fact. The overlay is never merged into the observed profile, and never written to a canonical section.

### The 28-day limit, and retrying

The Changelog serves a rolling **28 days** and only begins after consent. Anything not fetched and stored inside that window is gone permanently — LinkedIn will not serve it again.

The fetch cursor is LinkedIn's documented one: the newest returned `processedAt`. The next request asks from five minutes *before* it rather than exactly at it — `startTime` is inclusive, so asking earlier only ever returns more, every event is deduplicated by payload hash, and the margin covers an event whose `processedAt` lands just under the boundary. The cursor does not move when a response is empty, when no event carries a usable `processedAt`, when the value would move it backwards, or when the fetch, the pagination walk or the transaction fails. A timestamp more than five minutes in the future is rejected outright: one corrupt value would otherwise push the cursor past the whole retained window.

When to retry:

| Status | What to do |
|---|---|
| `upstream_snapshot_lag_detected` | Re-run later. LinkedIn gives no collation timetable. Treat the overlay as evidence of what changed, not as the profile. |
| `partial_domain_fetch` | Re-run for the named domains. Some failed, hit the pagination cap, or were carried forward from an earlier observation. |
| `event_overlay_partial` | Read `unresolved_changes` and apply anything that matters by hand through `linkedin_profile_update`. |
| `observed_no_newer_profile_event` | Nothing pending. Re-run when you want another live read. |
| `unknown` | The Snapshot changed and everything reconciled, but LinkedIn does not state which edits a response includes. Compare fingerprints on the next read. |

LinkedIn recommends polling the Changelog roughly once an hour. **This task added no scheduler**, and there is none anywhere in this repository: refreshes happen on explicit invocation only. That is a product decision about predictability — the Portability API terms govern storage, deletion on request, and where data may come from, but they do not prohibit a cadence.

### Why there is no fallback

When the Snapshot lags, the answer is to wait, not to find another door. Scraping, Voyager or other internal LinkedIn endpoints, browser automation and third-party profile scrapers are all excluded: the portability terms forbid accessing LinkedIn content through anything outside the Portability APIs, and the alternatives would also mean handling credentials this product deliberately never touches. OIDC `userinfo`, the legacy/basic Profile APIs and `/identityMe` are not fallbacks either — none of them exposes a complete profile.

### Deleting portability data

The portability terms permit storing Member Portability Data with the member's consent and require deleting all of it on request. Until now the only way to honour that was destroying the whole database, which also takes claims, drafts, approvals and audit history with it — so the obligation could not be met without losing unrelated work. Two scoped operations now exist:

```powershell
# Drop portability history older than a cutoff; the current observed profile stays
npm run control -- purge dma --before 2026-07-01T00:00:00Z

# Delete the portability lane outright
npm run control -- purge dma --confirm "DELETE LINKEDIN PORTABILITY DATA"
```

Both are also `linkedin_purge_run` modes (`prune_dma`, `purge_dma`).

**Purge** removes everything the lane holds: changelog events and their raw payloads, snapshot observations and per-domain results, DMA snapshots and their fields, post history imported from `MEMBER_SHARE_INFO`, and the sync bookkeeping. It resets the changelog cursor, so the lane is back to never-synced and a later sync re-reads the retained window.

**Prune** is narrower on purpose, because a cutoff is a blunt instrument:

- it never deletes changelog events newer than LinkedIn's own 28-day retention. Those are the events LinkedIn would still serve and the ones the freshness overlay reasons about; deleting them while the cursor stays put means they are never re-fetched and a pending edit silently stops being reported. Everything older is pure accumulation, and that is the growth worth bounding;
- it always keeps the newest observation and the newest snapshot, so the current observed profile survives any cutoff;
- it keeps any snapshot a surviving observation still points at. One snapshot is shared by every consecutive read that returned identical content, so age alone does not make it unused;
- it does not touch post history at all. Those rows are stamped with the sync time, not the post date, so a cutoff would delete an archive spanning years — and draft validation reads that table to catch near-duplicates of what you already published;
- the cutoff must be a past instant with an explicit UTC offset. A future cutoff is refused, because it would turn prune into a full deletion without the phrase that guards one; an offset-less string is refused, because it would be read in the host's timezone and shift the window.

**Neither removes** canonical profile revisions, claims, drafts, approvals, or the audit chain. None of those are Portability Data — they are your own work, and several are append-only by design.

Two things pin a DMA snapshot in place, and a purge keeps them and says so in `retained_snapshots`: a change set based on it (`change_sets.base_snapshot_id` is NOT NULL, so removing it takes the change set with it), and an applied patch verified against it (clearing that pointer would report the patch as unverified forever, with no snapshot left to re-verify against). **The LinkedIn-derived field text on a retained snapshot stays on disk**, so `fully_deleted` comes back `false` — delete the change set or patch and run it again to finish the job. `linkedin_purge_run` with `mode: "retention_sweep"` reports the lane's current footprint under `sweep.dma_lane`, so the size of what is deletable is visible before deleting it.

### Observations versus snapshots

A snapshot is a version of the profile; an observation is one request and what came back. LinkedIn returning identical bytes three days running is three observations of one profile state. So a read writes a new `linkedin_snapshots` row only when the rendered profile actually differs, and always writes an observation recording request/response timestamps, per-domain status, row counts, fingerprints, failure reasons, the changelog cursor, and whether the content was identical to the previous observation. `linkedin_snapshots.taken_at` is left null for this lane, because LinkedIn never told us when it generated the data.

## Confirmation, settings, and secrets without the dashboard

Everything except secret setup is available through MCP. Consequential MCP operations use explicit confirmations: source enablement requires `ENABLE <source_id>`; approval decisions use the commands below; live publishing requires `PUBLISH <approval_id>`; and full purge requires its exact destructive phrase. The dashboard exposes the same registry under **System → All MCP tools**.

The companion CLI provides the same shared feature settings and a masked credential prompt without starting the dashboard:

```powershell
npm run control

npm run control -- source enable <source_id>
npm run control -- approval preview <approval_id>
npm run control -- approval grant <approval_id> --revision-hash <hash_from_preview>
npm run control -- approval deny <approval_id> --reason "reason"
npm run control -- lane configure read --client-id <client_id>
npm run control -- lane verify read
npm run control -- feature list
npm run control -- feature disable analytics --confirm
npm run control -- feature enable live_publishing --confirm
npm run control -- purge all --confirm "DELETE ALL LOCAL DATA"
```

Credential input is masked and never placed in command arguments unless an operator deliberately uses the documented stdin automation option. A CLI grant requires the revision hash shown by the byte-exact preview, preventing blind approval by ID.

MCP can also act on a pending request with `linkedin_approval_decide`, but only after asking for a current explicit decision. The command is bound to the approval ID; a grant is additionally bound to the exact revision hash. Supported commands are `APPROVE <approval_id> <revision_hash>`, `REJECT <approval_id>`, and `REVISE <approval_id>`. Revising appends a new draft revision, invalidates the old approval, and requires validation plus a fresh approval request.

### Shared feature policy

`linkedin_feature_control` lists a title, description, default, and current state for all nine groups. The same rows power **System → Features** and `npm run control -- feature ...`. Every group defaults enabled except `live_publishing`.

Credential/API capability state remains a separate gate. For a real post: configure the write secret in the dashboard or CLI, verify the write lane, enable `live_publishing`, validate and approve the exact draft revision, then confirm `PUBLISH <approval_id>` to `linkedin_publish_execute` with `adapter: "linkedin"`. This version implements the official LinkedIn Posts API text-post flow; media attachments fail locally until asset upload is implemented. The API version can be changed with the non-secret `linkedin.posts_api_version` setting. See LinkedIn's [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) and [versioning guide](https://learn.microsoft.com/en-us/linkedin/marketing/versioning).

## Storage and lifecycle

Default home:

```text
%LOCALAPPDATA%\linkedin-mcp
```

Important contents:

```text
data/linkedin.sqlite3   SQLite database and WAL
artifacts/              Content-addressed imported copies
backups/                Verified application backups
secrets/                Sealed master key: master.key.dpapi (Windows),
                        master.key.keychain (macOS), or master.key.mkey (Linux)
```

All durable application configuration is in the same SQLite database. Secret values are encrypted there and can be used by either the dashboard or an MCP external-capability tool through the same sealed master key — wrapped by DPAPI on Windows, the login Keychain on macOS, or a machine-id-derived key on Linux — while never being returned to the agent. The AI-client files contain only the server command and shared home path.

Multiple clients may open separate stdio processes against this home. SQLite WAL mode, immediate write transactions, and bounded busy retries keep committed progress consistent across them and the dashboard. The dashboard refreshes visible data after MCP-side changes.

Each client connection starts its own stdio process, applies pending forward-only migrations, seeds required capability records, runs the retention sweep, and closes when the client disconnects. Diagnostics go to stderr; stdout is reserved for MCP JSON-RPC.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Client reports `ENOENT` or “server not found” | Build first and use absolute Node/server paths. |
| Client connects to an empty database | Set the same absolute `LINKEDIN_MCP_HOME` in every client. |
| Direct terminal command appears frozen | Normal for stdio; the process is waiting for MCP JSON-RPC. Use Inspector or an MCP host. |
| Tool catalog is stale after a code change | Run `npm run mcp:build`, then restart/refresh the server in the client. |
| Search reports FTS5 unavailable | Search falls back to `LIKE`; safety paths are unaffected. |
| A LinkedIn external tool is blocked | Call `linkedin_capability_status`; credentials and publishing gates are optional and fail closed. |
| SQLite is locked | Close duplicate dashboard/server/test processes and retry. Never synchronize the live data directory. |

Return to the [application README](../README.md) or open the [dashboard README](../linkedin-dashboard/README.md).
