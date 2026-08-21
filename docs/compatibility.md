# Compatibility and support matrix

## Platform

| Platform | Status |
|---|---|
| Windows 10 or later | **Supported.** The only platform this is tested on. |
| Linux | **Unsupported.** Builds and type-checks; the evidence pipeline cannot work. |
| macOS | **Unsupported.** Same as Linux. |
| Docker / containers | **Unsupported, and not planned.** See below. |

Windows is not a preference. Two things pin it:

1. **Evidence import accepts drive-letter paths only.** `canonicalizePath`
   rejects anything that is not `X:\...` (`packages/importers/src/pathGuard.ts:22`),
   along with UNC paths, device prefixes, alternate data streams, and reserved
   device names. On a POSIX filesystem no evidence source can be registered at
   all, so the product's core loop is unreachable.
2. **The credential vault is Windows DPAPI**, reached through Windows
   PowerShell 5.1 (`packages/domain/src/secretStore.ts:67-72`). There is no
   fallback, deliberately: a plaintext-on-disk fallback would be a worse
   security model wearing the same interface.

The SQLite layer and the MCP stdio transport themselves are portable. That is
not enough to call the product portable, and this document will not pretend
otherwise.

### Why there is no Docker image

A container would have to either drop DPAPI (leaving credentials unprotected)
or carry a Windows base image large enough to host PowerShell — and it still
could not reach the host paths that evidence sources point at. The local
Windows credential model and containerisation are genuinely in conflict here,
so the project does not ship an image.

## Runtime

| Component | Requirement | Why |
|---|---|---|
| Node.js | **24 or later** | The database uses the built-in `node:sqlite`, acquired via `process.getBuiltinModule` (`packages/db/src/driver.ts:6-9`) |
| npm | any version shipping with Node 24 | workspaces |
| Windows PowerShell | 5.1 (ships with Windows) | DPAPI, and the setup assistant |
| Document formats | PDF, DOCX, CSV, Markdown, plain text, ZIP archives, and source files. No images, so no OCR — see [known-limitations.md](known-limitations.md) |
| SQLite FTS5 | optional | Search degrades to `LIKE` when absent; safety paths are unaffected (`packages/db/src/open.ts:23-34`) |

`node:sqlite` is a comparatively young built-in. If a future Node release
changes its status in a way that breaks this project, the driver seam at
`packages/db/src/driver.ts:11-13` exists so an alternative can be slotted in
without touching domain code.

## LinkedIn lanes

| Lane | Requirement |
|---|---|
| Everything not touching LinkedIn | No account, no credential, no network. Works everywhere Windows does. |
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

The clean-room evidence behind the "supported" claims above comes from two
places: the `windows-latest` CI runner, and a local temp-directory clone with an
isolated `LINKEDIN_MCP_HOME`.

**Neither can prove that a prerequisite already installed on the maintainer's
machine is not masking a missing dependency.** A dedicated fresh Windows VM was
not available when this matrix was written. If you hit a missing prerequisite on
a clean machine, that is a real bug worth reporting — the gap is documented here
rather than glossed over, and re-testing on a fresh machine is the first thing
to do if one becomes available.
