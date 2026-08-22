# LinkedIn Evidence MCP

*An independent, community-built tool. Not affiliated with, endorsed by, or
sponsored by LinkedIn Corporation or Microsoft. "LinkedIn" is a trademark of
LinkedIn Corporation, used here only to describe the service this software
interoperates with.*

A local-first LinkedIn workspace with one shared engine and two synchronized ways to use it:

- the **stdio MCP server**, which is the primary workflow engine for evidence, profile, drafting, analytics, and maintenance;
- an optional **loopback dashboard**, which is the visual support and human-review surface over the same tools and data.

The application keeps its own SQLite database and artifact store on this computer. It does not contain an LLM, a hosted service, a scheduler, scraping, browser automation, cookie reuse, or automated engagement.

Nothing here refreshes on a timer. LinkedIn data is pulled only when you or an agent invoke a tool that does it. That is a product decision about predictability, not a restriction imposed by LinkedIn's terms — see [reading the latest LinkedIn profile](linkedin-mcp-server/README.md#reading-the-latest-linkedin-profile).

## What it is for

The app turns evidence you control—CVs, documents, repositories, LinkedIn exports, and manually imported history—into:

- a verified claim ledger;
- an evidence-backed canonical profile;
- exact profile change patches for manual copy/paste;
- LinkedIn post drafts with deterministic validation;
- content pillars, opportunities, and a planning calendar;
- publication approvals and an append-only audit history;
- local backups, exports, and retention controls.

External LinkedIn features are optional. They remain unavailable until the corresponding developer-app credential is stored, verified against LinkedIn, and explicitly enabled where required. The rest of the product works without those credentials.

## Requirements

- **Windows 10 or later, Linux, or macOS.** All three are supported and all
  three run the full test suite on every push.
- Node.js 24 or later (the database uses the built-in `node:sqlite`)
- npm

Evidence import accepts each platform's own absolute-path shape: drive-letter
paths on Windows, `/`-rooted paths on Linux and macOS. The rules genuinely
differ — Windows also refuses UNC paths, alternate data streams and reserved
device names, while the POSIX rules refuse embedded NUL bytes and the ambiguous
`//` root — because the dangerous shapes differ, not because one platform is
trusted more.

The credential vault differs too, and the differences are worth knowing before
you rely on it. All three give the same practical guarantee — a data home
copied to another machine or another account cannot be opened — but they are
not equally strong:

| Platform | How the master key is sealed | |
|---|---|---|
| **macOS** | A random key in the login Keychain, held by the OS behind an access-control list | strongest |
| **Windows** | DPAPI, bound to your Windows account | |
| **Linux** | Derived from the host machine id and your user id, never written down | weakest — `/etc/machine-id` is world-readable, so any local process can derive the same key |

None of them defends against software running as you, which
[SECURITY.md](SECURITY.md) has always listed as out of scope. The ranking
matters only if a local attacker is in your threat model; if so, prefer macOS
or Windows, or do not store LinkedIn credentials at all — everything else works
without them.

The interactive setup assistant is Windows-only, because it is PowerShell. On
Linux and macOS you configure your MCP client by hand, which is one JSON block
— see [MCP server setup](linkedin-mcp-server/README.md). `npm run setup:mcp`
prints exactly that block, with the right data home for your platform, rather
than failing.

The optional LinkedIn read lane has a second, separate limit: LinkedIn issues
Member Data Portability tokens only to members located in the European Economic
Area or Switzerland. Everything that does not touch LinkedIn works regardless.

## Quick start

From the repository root:

```powershell
npm run setup:mcp
```

**On Windows** this runs the interactive assistant described below. **On Linux
and macOS** the assistant does not apply — it is PowerShell and writes Windows
client paths — so `npm run setup:mcp` instead prints the one JSON block you add
to your MCP client by hand, with the right data home for your platform, and the
rest of this section (the PowerShell commands) is Windows-only. Per-client
examples are in [MCP server setup](linkedin-mcp-server/README.md); the short
version is [Use the MCP without the dashboard](#use-the-mcp-without-the-dashboard)
below, which is identical on every platform.

**See what it would do first (Windows):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-mcp.ps1 -All -NonInteractive -DryRun
```

Windows refuses to run an unsigned `.ps1` under its default `Restricted`
execution policy, so a bare `.\setup-mcp.ps1` fails before it does anything.
`-ExecutionPolicy Bypass` applies to that one invocation and changes nothing on
the machine — which is also exactly what `npm run setup:mcp` does. Read the
script first if you would rather not take that on trust; `-DryRun` prints every
file it would touch without opening any of them for writing.

The assistant edits configuration files that belong to other applications, so
it is worth knowing which before you let it run. Depending on the clients you
select it can write to `~/.codex/config.toml`, `~/.claude.json`,
`%APPDATA%\Claude\claude_desktop_config.json`, `%APPDATA%\Code\User\mcp.json`,
`~/.copilot/mcp-config.json`, `~/.cursor/mcp.json`, and
`~/.gemini/config/mcp_config.json`. Unless you pass `-NoPersistUserEnvironment`
it also saves `LINKEDIN_MCP_HOME` as a **user-scope** environment variable.

Every file it touches is backed up with a timestamped copy first, only the
`linkedin` entry is replaced, a file that is not strict JSON is refused rather
than rewritten, and a failure restores the original.

The interactive assistant checks Node.js, installs dependencies when needed, builds the MCP server, asks which AI clients to configure, and points every selection at one shared data home. It supports Codex, Claude Code, Claude Desktop, VS Code/Copilot Chat, GitHub Copilot CLI, Cursor, and Google Antigravity. Existing JSON configurations are merged and backed up; only the `linkedin` MCP entry is replaced.

Restart the configured clients, then choose either or both surfaces:

```powershell
# MCP server: normally started automatically by your AI client
npm run mcp:start

# Optional human review dashboard
npm run dashboard
```

`mcp:start` speaks JSON-RPC over stdin/stdout and therefore appears to wait when run in an ordinary terminal. That is expected. Configure an MCP client to launch it instead; see [MCP server setup](linkedin-mcp-server/README.md).

The dashboard prints a single-use URL for `http://127.0.0.1:4780`. See [dashboard usage](linkedin-dashboard/README.md).

For repeatable or unattended setup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-mcp.ps1 -Clients Codex,Cursor,VSCode -NonInteractive
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-mcp.ps1 -All -NonInteractive
```

Use `-DataHome "C:\absolute\path"` to choose a different shared home. The assistant saves that absolute path as the current user's `LINKEDIN_MCP_HOME`; open a new terminal before starting the dashboard so it inherits a newly saved custom value. Pass `-NoPersistUserEnvironment` if you only want the selected client entries changed. The assistant never asks for or writes LinkedIn credentials.

## Shared state between MCP and dashboard

The dashboard and every configured MCP process open the same local application home. You can work in the dashboard, close it, continue through an AI agent, and return later without importing or reconciling anything manually.

All paths below are under the data home (see [Data location](#data-location)).

| Shared state | Where it lives |
|---|---|
| Evidence, claims, profile state, decisions, drafts, revisions, approvals, publication history, audit events, settings, and progress | `data/linkedin.sqlite3` |
| Imported working copies and generated artifacts | `artifacts/` |
| Encrypted LinkedIn credentials | Ciphertext in SQLite plus the sealed master key in `secrets/` — DPAPI on Windows, Keychain-sealed on macOS, machine-derived on Linux |
| Backups | `backups/` |

SQLite WAL mode and bounded write retries allow the dashboard and MCP clients to run at the same time. The dashboard refreshes the current screen when it regains focus and periodically while visible, so agent-side changes appear without restarting it.

This is local synchronization on one user account, not cloud or multi-machine synchronization. Secrets remain usable by both processes but are never copied into AI-client configuration, returned to a model, exported, logged, or included in backups.

## Use the MCP without the dashboard

The dashboard and MCP server are separate processes. You do **not** need to start the dashboard before connecting Codex, Claude, Copilot, Cursor, Antigravity, VS Code, or another stdio MCP host.

After building, configure the client to launch the compiled entrypoint with an
absolute path (backslashes on Windows, `/` on Linux and macOS):

```text
node <absolute-path-to-repo>/linkedin-mcp-server/dist/index.js
```

To add and import the first evidence source from a human-operated terminal — the
path is an example, use your own absolute path in the shape your platform accepts:

```text
npm run evidence:add -- "C:\path\to\cv.pdf" document personal_doc "Current CV"
# Linux / macOS:  npm run evidence:add -- "/home/you/cv.pdf" document personal_doc "Current CV"
```

That command explicitly registers, enables, and imports the source without opening the dashboard. Source kinds are `repo`, `document`, `folder`, `linkedin_export`, and `manual`; trust levels are `personal_doc`, `own_repo`, and `local_clone_reference`.

You can then ask the connected agent to:

```text
Use the LinkedIn MCP capability-status tool, then list my evidence sources and candidate claims.
```

The MCP drives the normal workflow. The dashboard includes purpose-built review screens plus **System → All MCP tools**, which exposes the exact same validated tool registry—there is no dashboard-only copy of the business logic. Secret entry is the only operation intentionally unavailable through chat. Other consequential operations require an explicit confirmation bound to the action:

| Action | Dashboard-free option |
|---|---|
| Register, enable, and import evidence | MCP (`ENABLE <source_id>` is required to enable), `npm run evidence:add -- ...`, or the dashboard/CLI |
| Change non-secret settings | `linkedin_settings_set` MCP tool |
| Store LinkedIn access tokens | `npm run control -- lane configure read|write --client-id <id>` (masked prompt) |
| Grant, decline, or revise a publication approval | Tell the connected agent your decision and confirm its bound command for `linkedin_approval_decide`, or use the dashboard/control CLI |
| Enable real publishing | `linkedin_feature_control`, dashboard Features, or `npm run control -- feature enable live_publishing --confirm`, after write-lane verification |
| Publish to the account | `linkedin_publish_execute` with `PUBLISH <approval_id>` after grant; text posts only in this version |
| Delete LinkedIn portability data only | `linkedin_purge_run` mode `purge_dma`, or `npm run control -- purge dma --confirm "DELETE LINKEDIN PORTABILITY DATA"`; `prune_dma` / `--before <ISO>` drops older history and keeps the current profile |
| Permanently purge all local data | Confirmed `linkedin_purge_run`, dashboard, or `npm run control -- purge all --confirm "DELETE ALL LOCAL DATA"` |

Run `npm run control` with no arguments for an interactive menu. The CLI is also the dashboard-free secret-entry surface; access tokens are masked and never enter MCP payloads.

### Shared feature controls

Nine feature groups are stored in the shared SQLite database and enforced by both MCP handlers and dashboard routes: `evidence`, `profile`, `content`, `publication_workflow`, `analytics`, `linkedin_sync`, `maintenance`, `configuration`, and `live_publishing`. The first eight default to enabled. Only `live_publishing` defaults to disabled.

List descriptions and current values with `linkedin_feature_control`, **System → Features**, or:

```powershell
npm run control -- feature list
npm run control -- feature disable analytics --confirm
npm run control -- feature enable analytics --confirm
```

Feature policy is separate from LinkedIn credential/API readiness. Enabling `live_publishing` therefore still requires a verified write lane, and every real post still requires a granted revision-bound approval plus the exact publish command.

## Evidence workflow and decisions

The intended flow is MCP-first:

1. Register an evidence path with MCP, then explicitly confirm `ENABLE <source_id>` through the agent, dashboard, or control CLI.
2. Let the agent import it, verify stored-byte integrity, inspect the extracted artifacts, and propose narrow claims with citations.
3. Review the exact statements. Non-conflicting claims become verified only after explicit human confirmation.
4. Escalate conflicts, ambiguous wording, and overstatements for human review. Resolve them through MCP conversation or the dashboard; both call the same claim and conflict services.

Claim statements are immutable history. “Modify” creates corrected wording as a new claim, then rejects or merges the old claim. This keeps previous decisions auditable instead of silently rewriting evidence.

## Data location

The default home is each platform's own convention:

| Platform | Default home |
|---|---|
| Windows | `%LOCALAPPDATA%\linkedin-mcp` |
| macOS | `~/Library/Application Support/linkedin-mcp` (or `$XDG_DATA_HOME/linkedin-mcp` if set) |
| Linux | `$XDG_DATA_HOME/linkedin-mcp`, otherwise `~/.local/share/linkedin-mcp` |

Set `LINKEDIN_MCP_HOME` to an absolute directory to use a different home or an isolated test corpus; it overrides the default on every platform. Relative paths are rejected because different client working directories could otherwise create separate databases — and on Windows a drive-relative path like `\linkedin-data` is rejected for the same reason, since it resolves against whichever drive a process is on. The setup assistant configures the same absolute value everywhere.

Do not place the live home in OneDrive, Dropbox, Google Drive, iCloud Drive, or another synchronization folder. SQLite uses a live WAL database, which should not be copied while open. Use the built-in backup command instead.

## Repository map

| Path | Responsibility |
|---|---|
| [`linkedin-mcp-server/`](linkedin-mcp-server/README.md) | Primary engine: 44 MCP tools, 5 resources, 5 workflow prompts, stdio transport |
| [`linkedin-dashboard/`](linkedin-dashboard/README.md) | Optional loopback visual support, human review, and exact MCP-tool console |
| `packages/domain/` | Evidence, profile, drafts, approvals, publication, audit, retention |
| `packages/db/` | SQLite driver, migrations, optimistic concurrency, artifact storage |
| `packages/importers/` | Path-safe ZIP, CSV, PDF, DOCX, repository scanning, and redaction |
| `packages/linkedin/` | Fail-closed LinkedIn OIDC, DMA, and publishing adapters |
| `packages/shared/` | Canonical JSON, identifiers, and error contracts |
| `scripts/` | Human-operated onboarding, maintenance, and evaluation commands |

## Safety model

- Only verified claims can back public profile text or drafts.
- Imported content is always treated as untrusted data, never as instructions.
- MCP can grant, reject, or revise a publication request only after the user explicitly confirms the exact approval command; grants are bound to the revision hash.
- Approval is bound to one exact draft revision and consumed before publishing.
- An uncertain network outcome becomes `ambiguous`; it is never retried automatically.
- The audit log is hash-chained; a broken chain blocks approvals and publication.
- Imports copy content into the artifact store and never modify the originals.
- Secrets are excluded from MCP payloads, logs, exports, and backups.

## Development and verification

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run inspect:list
npm run test:visual
```

**Build before test.** The protocol-cleanliness suite drives the compiled stdio
server, so `npm test` needs `linkedin-mcp-server/dist/index.js` to exist. Running
the steps in the order above is enough; there is no separate setup.

`inspect:list` starts the compiled stdio server through MCP Inspector and requests its tool catalog. Visual tests require Playwright browser installation.

For optional LinkedIn developer-app configuration, see [docs/linkedin-app-setup.md](docs/linkedin-app-setup.md).

## Documentation

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Two surfaces, one engine; the seams that are not obvious |
| [docs/compatibility.md](docs/compatibility.md) | Supported platforms, runtime, MCP clients, and the known verification gap |
| [docs/known-limitations.md](docs/known-limitations.md) | What this does not do, and which limits are deliberate |
| [docs/privacy-and-local-data.md](docs/privacy-and-local-data.md) | What is stored, what leaves the machine, how to delete it |
| [docs/threat-model.md](docs/threat-model.md) | Assets, trust boundaries, and where protection stops |
| [docs/releases.md](docs/releases.md) | Versioning, upgrading, and why downgrade is unsupported |
| [docs/linkedin-app-setup.md](docs/linkedin-app-setup.md) | Creating the two LinkedIn developer apps |
| [docs/dashboard-design.md](docs/dashboard-design.md) | Dashboard design system |
| [docs/dashboard-manual-checks.md](docs/dashboard-manual-checks.md) | Manual accessibility and viewport checklist |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability; non-goals |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Getting a green build; the rules that are not negotiable |
| [SUPPORT.md](SUPPORT.md) | Where to ask, and what is out of scope |

## License

MIT — see [LICENSE](LICENSE). Third-party dependency licenses are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); trademark and affiliation
wording lives in [NOTICE](NOTICE).
