# Compatibility and support matrix

## Platform

| Platform | Status |
|---|---|
| Windows 10 or later | **Supported.** Full suite runs on `windows-latest` every push. |
| Linux | **Supported.** Full suite runs on `ubuntu-latest` every push. |
| macOS | **Supported.** Full suite runs on `macos-latest` every push. |
| Other POSIX (the BSDs) | **Unsupported.** The path rules would work; the vault has no implementation and refuses by name rather than guessing. |
| Docker / containers | **Unsupported.** See below — the reason is narrower than it used to be. |

Two things differ between the supported platforms, and both are implemented
rather than worked around.

1. **Evidence import accepts each platform's own absolute-path shape.**
   `canonicalizePath` applies one of two rule sets
   (`packages/importers/src/pathGuard.ts:84-90`). Windows requires `X:\...` and
   additionally refuses UNC paths, device prefixes, alternate data streams and
   reserved device names. Linux requires a `/` root and refuses embedded NUL
   bytes and the ambiguous `//` root. Containment comparison is
   case-insensitive on Windows and case-sensitive on Linux, because on Linux
   `/data/Evidence` and `/data/evidence` are two directories and folding them
   together would report containment that does not exist.
2. **The credential vault has three implementations**, and they are not equally
   strong. All three keep the property the product relies on — a data home
   copied to another machine or account cannot be opened — but the custody of
   the sealing key differs:

   | Platform | Key custody | Strength |
   |---|---|---|
   | macOS | Random, held by the login Keychain behind an ACL (`packages/domain/src/keychain.ts`) | strongest |
   | Windows | DPAPI, bound to the account, via Windows PowerShell 5.1 | |
   | Linux | Derived from machine id + uid, never stored (`packages/domain/src/machineKey.ts:92-108`) | weakest |

   The ranking is stated rather than implied: `/etc/machine-id` is
   world-readable, so on Linux any local process can derive the same key, where
   DPAPI makes an attacker ask the OS and the Keychain holds a random key it
   never had to publish. See [SECURITY.md](../SECURITY.md).

Nothing here is tested only on its own platform. The path rules, the data-home
defaults and both non-DPAPI vaults take their platform — or, for the Keychain,
the external command itself — as an argument, so each is exercised from any
host: `tests/unit/path-guard-platforms.test.ts`,
`tests/unit/data-home-platforms.test.ts`, `tests/unit/machine-key.test.ts`,
`tests/unit/secret-store-machine-key.test.ts`, `tests/unit/keychain.test.ts`.

What injection cannot prove is that the external commands behave as assumed —
that `security` really exits 44 for a missing item, that a `-T`-authorised read
really does not raise a dialog. Only a real Mac and a real Windows box can show
that, which is why both are in the matrix rather than being stood in for.

What remains Windows-only is the DPAPI half of the vault, which needs real
PowerShell, and the interactive setup assistant, which is PowerShell. On Linux
and macOS you configure your MCP client by hand — one JSON block, documented
per client in [the server README](../linkedin-mcp-server/README.md) — and
`npm run setup:mcp` prints exactly that block, with the right data home for the
platform, rather than failing with `ENOENT`.

### Data home

| Platform | Default | Override |
|---|---|---|
| Windows | `%LOCALAPPDATA%\linkedin-mcp` | `LINKEDIN_MCP_HOME` |
| Linux | `$XDG_DATA_HOME/linkedin-mcp`, else `~/.local/share/linkedin-mcp` | `LINKEDIN_MCP_HOME` |
| macOS | `$XDG_DATA_HOME/linkedin-mcp` when set, else `~/Library/Application Support/linkedin-mcp` | `LINKEDIN_MCP_HOME` |

XDG is honoured on macOS as well as Linux: a member who has set
`XDG_DATA_HOME` has already said where application data goes on their machine,
and overruling that would be this product deciding it knows better.

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
| `/usr/bin/security` | ships with macOS | macOS only: the vault stores its sealing key in the login Keychain. A locked keychain is reported as retryable, not as corruption. |
| Document formats | PDF, DOCX, CSV, Markdown, plain text, ZIP archives, and source files. No images, so no OCR — see [known-limitations.md](known-limitations.md) |
| SQLite FTS5 | optional | Search degrades to `LIKE` when absent; safety paths are unaffected (`packages/db/src/open.ts:84-92`) |

`node:sqlite` is a comparatively young built-in. If a future Node release
changes its status in a way that breaks this project, the driver seam at
`packages/db/src/driver.ts:11-13` exists so an alternative can be slotted in
without touching domain code.

## LinkedIn lanes

| Lane | Requirement |
|---|---|
| Everything not touching LinkedIn | No account, no credential, no network. Works on all three supported platforms. |
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
runners — `windows-latest`, `ubuntu-latest` and `macos-latest`, each building
from a fresh checkout and booting the server against a data home that does not
exist yet — and from a local temp-directory clone with an isolated
`LINKEDIN_MCP_HOME`.

**None of that can prove that a prerequisite already installed on the runner
image is not masking a missing dependency**, and two vault paths are proved by
injection rather than by a host that genuinely lacks the resource: `security`
and DPAPI are exercised for real on the macOS and Windows runners, but the
machine-id-absent branch is not (the Linux runner has `/etc/machine-id`), and no
DPAPI-equivalent hardware or distribution variety is covered. If you hit a
missing prerequisite on a clean machine, that is a real bug worth reporting —
the gap is documented here rather than glossed over, and re-testing on a fresh
machine is the first thing to do if one becomes available.
