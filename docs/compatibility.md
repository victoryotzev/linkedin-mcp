# Compatibility and support matrix

## Platform

| Platform | Status |
|---|---|
| Windows 10 or later | **Supported.** Full suite runs on `windows-latest` every push. |
| Linux | **Supported.** Full suite runs on `ubuntu-latest` every push. |
| macOS | **Unsupported.** Most of it would run; the vault has no implementation and nothing is tested. |
| Docker / containers | **Unsupported.** See below — the reason is narrower than it used to be. |

Two things differ between the supported platforms, and both are implemented
rather than worked around.

1. **Evidence import accepts each platform's own absolute-path shape.**
   `canonicalizePath` applies one of two rule sets
   (`packages/importers/src/pathGuard.ts:79-96`). Windows requires `X:\...` and
   additionally refuses UNC paths, device prefixes, alternate data streams and
   reserved device names. Linux requires a `/` root and refuses embedded NUL
   bytes and the ambiguous `//` root. Containment comparison is
   case-insensitive on Windows and case-sensitive on Linux, because on Linux
   `/data/Evidence` and `/data/evidence` are two directories and folding them
   together would report containment that does not exist.
2. **The credential vault has two implementations.** Windows seals the master
   key with DPAPI through Windows PowerShell 5.1. Linux derives the sealing key
   from the host machine id and the calling user id and never writes it down
   (`packages/domain/src/machineKey.ts:96-112`). Both keep the property the
   product relies on — a data home copied to another machine or account cannot
   be opened — and they differ in one way stated plainly in
   [SECURITY.md](../SECURITY.md): `/etc/machine-id` is world-readable, so on
   Linux any local process can derive the same key, where DPAPI at least makes
   an attacker ask the OS.

Neither rule set is tested only on its own platform. Both take the platform as
an argument, so the Windows rules run on the Linux runner and the reverse:
`tests/unit/path-guard-platforms.test.ts`,
`tests/unit/data-home-platforms.test.ts`,
`tests/unit/machine-key.test.ts`,
`tests/unit/secret-store-machine-key.test.ts`.

What remains Windows-only is the DPAPI half of the vault, which needs real
PowerShell, and the interactive setup assistant, which is PowerShell. Linux
users configure their MCP client by hand — one JSON block, documented per
client in [the server README](../linkedin-mcp-server/README.md) — and
`npm run setup:mcp` prints exactly that rather than failing with `ENOENT`.

### Data home

| Platform | Default | Override |
|---|---|---|
| Windows | `%LOCALAPPDATA%\linkedin-mcp` | `LINKEDIN_MCP_HOME` |
| Linux | `$XDG_DATA_HOME/linkedin-mcp`, else `~/.local/share/linkedin-mcp` | `LINKEDIN_MCP_HOME` |

### Why there is no Docker image

Less absolute than it was, and still true. A Linux container can now run
everything except the vault: `/etc/machine-id` is per-container by default, so a
rebuilt image derives a different key and the stored credentials become
unreadable — the same failure a reimaged host produces, but on every `docker
build`. A container also cannot reach the host paths that filesystem evidence
sources point at without mounts that defeat the point of the path guard. An
image is therefore still not shipped, but a Linux host install is now a
first-class way to run this.

## Runtime

| Component | Requirement | Why |
|---|---|---|
| Node.js | **24 or later** | The database uses the built-in `node:sqlite`, acquired via `process.getBuiltinModule` (`packages/db/src/driver.ts:6-9`) |
| npm | any version shipping with Node 24 | workspaces |
| Windows PowerShell | 5.1 (ships with Windows) | Windows only: DPAPI, and the setup assistant. Not required on Linux, where the vault derives its key instead. |
| `/etc/machine-id` | present (systemd), or `/var/lib/dbus/machine-id` | Linux only: the vault derives its sealing key from it. Absent means credentials cannot be stored; everything else still runs. |
| Document formats | PDF, DOCX, CSV, Markdown, plain text, ZIP archives, and source files. No images, so no OCR — see [known-limitations.md](known-limitations.md) |
| SQLite FTS5 | optional | Search degrades to `LIKE` when absent; safety paths are unaffected (`packages/db/src/open.ts:84-92`) |

`node:sqlite` is a comparatively young built-in. If a future Node release
changes its status in a way that breaks this project, the driver seam at
`packages/db/src/driver.ts:11-13` exists so an alternative can be slotted in
without touching domain code.

## LinkedIn lanes

| Lane | Requirement |
|---|---|
| Everything not touching LinkedIn | No account, no credential, no network. Works on both supported platforms. |
| Read lane (Member Data Portability) | **A LinkedIn member located in the European Economic Area or Switzerland.** LinkedIn issues `r_dma_portability_self_serve` tokens to nobody else. |
| Write lane (posting) | A separate developer app with Share on LinkedIn and Sign In with LinkedIn. |

The region limit is LinkedIn's, not this project's, and there is no workaround
here — nor will one be added. See [known-limitations.md](known-limitations.md).

## MCP clients

**Verified** — the setup assistant configures these and a test exercises the
configuration writer (`tests/integration/setup-assistant.test.ts`):

Claude Desktop · VS Code / Copilot Chat · GitHub Copilot CLI · Cursor ·
Google Antigravity

**Configured through the vendor's own CLI** — the assistant shells out to
`codex` / `claude`, so correctness depends on that tool:

Codex CLI, Codex IDE, ChatGPT desktop · Claude Code CLI

**Documented only** — any client that can launch a local stdio MCP server
should work using the three fields shown in
[the server README](../linkedin-mcp-server/README.md#other-stdio-mcp-clients),
but has not been tested here.

The server speaks stdio only. There is no HTTP or SSE transport.

## Known verification gap

The clean-room evidence behind the "supported" claims above comes from the CI
runners — `windows-latest` and `ubuntu-latest`, each building from a fresh
checkout and booting the server against a data home that does not exist yet —
and from a local temp-directory clone with an isolated `LINKEDIN_MCP_HOME`.

**None of that can prove that a prerequisite already installed on the runner
image is not masking a missing dependency**, and the Linux claim carries one
gap of its own: no DPAPI-equivalent hardware or distribution variety is
covered, and `/etc/machine-id` is present on the runner, so the
machine-id-absent path is proved by injection rather than by a host that
genuinely lacks one. If you hit a missing prerequisite on
a clean machine, that is a real bug worth reporting — the gap is documented here
rather than glossed over, and re-testing on a fresh machine is the first thing
to do if one becomes available.
