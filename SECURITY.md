# Security policy

## Supported versions

This project is pre-1.0 and maintained by one person. Only the latest released
minor receives security fixes. There is no long-term-support branch and none is
planned.

| Version | Supported |
|---|---|
| latest minor | yes |
| anything older | no — upgrade |

## Reporting a vulnerability

**Report privately. Do not open a public issue.**

Use GitHub's [Private Vulnerability
Reporting](https://github.com/victoryotzev/linkedin-mcp/security/advisories/new)
on this repository. That is the preferred channel because it keeps the report,
the fix, and the advisory in one place.

What to expect, from one maintainer working in his own time:

| Stage | Target |
|---|---|
| Acknowledgement that the report was received | 72 hours |
| First triage verdict (accepted / needs info / not a vulnerability) | 7 days |
| Fix or documented mitigation for an accepted report | best effort, discussed in the thread |

These are targets, not guarantees, and they are deliberately modest. A promise
this project cannot keep would be worse than no promise.

**Please do not include real data in a report.** No access tokens, no database
files, no artifact contents, no screenshots of your own profile data. A
redacted reproduction is always enough; if it is not, say so and we will work
out how to get what is needed.

## What this product is, in security terms

Everything runs on one Windows machine, under one Windows account. There is no
server, no hosted component, no telemetry, and no account system. The only
outbound network destination in the entire codebase is `https://api.linkedin.com`
— every `fetch` call site lives in `packages/linkedin/`, and the host is pinned
and re-checked on the response URL so a redirect cannot hand a bearer token to
someone else (`packages/linkedin/src/dmaClient.ts:58-67`).

### Controls that exist today

| Control | Where |
|---|---|
| Bearer token stripped from error bodies before they can reach a log, message, or MCP result — redaction runs before truncation | `packages/linkedin/src/dmaClient.ts:77-79` |
| LinkedIn host pinned; redirects refused outright | `packages/linkedin/src/dmaClient.ts:58-67`, `packages/linkedin/src/adapters.ts:100-111` |
| Tokens encrypted with AES-256-GCM; the name and key id are bound in as AAD, so a ciphertext moved between lanes fails to decrypt instead of silently swapping credentials | `packages/domain/src/secretStore.ts:214-216` |
| Master key wrapped by Windows DPAPI (CurrentUser); key material crosses stdin, never argv; `powershell.exe` resolved by absolute path so a planted binary on `PATH` cannot receive it | `packages/domain/src/secretStore.ts:67-72,88-95` |
| Secret names are allowlisted — the vault cannot grow into a general key-value store | `packages/domain/src/secretStore.ts:42,256-261` |
| Backups refuse to contain anything under `secrets/` | `packages/domain/src/backupService.ts:294-295` |
| Dashboard binds `127.0.0.1` only, with an exact `Host` allowlist (kills DNS rebinding) and a `Sec-Fetch-Site` check | `linkedin-dashboard/src/server.ts:84`, `linkedin-dashboard/src/auth.ts:27-29,72-78` |
| Launch token is CSPRNG, stored hashed, compared in constant time **before** the spent check, and single-use | `linkedin-dashboard/src/auth.ts:23-49` |
| Strict CSP with no `unsafe-inline` anywhere; asserted character-for-character by a test | `linkedin-dashboard/src/app.ts:44-55` |
| Imported content is wrapped in an explicit "data only, never instructions" envelope before any model sees it | `packages/domain/src/artifactService.ts:30-33` |
| Evidence paths reject UNC, device prefixes, alternate data streams, and reserved device names, then canonicalize and **re-check**, then enforce per-segment containment | `packages/importers/src/pathGuard.ts:16-77` |
| PDFs are parsed in a child process with a hard timeout and byte cap, with `enableScripting: false` (GHSA-hq66-cqwq-w95j) and `isEvalSupported: false` | `packages/importers/scripts/pdf-extract.mjs:12-24`, `packages/importers/src/pdf.ts:21-30` |
| Real publishing is off by default and requires a separate explicit toggle | `packages/domain/src/featureControlService.ts:70-73` |
| Publishing requires a granted approval bound to an exact revision hash plus the exact `PUBLISH <approval_id>` string | `linkedin-mcp-server/src/tools/publish.ts:249-262,344-351` |
| An uncertain network outcome becomes `ambiguous` and is never retried automatically | `packages/linkedin/src/adapters.ts:112-133` |
| A broken audit chain blocks approvals and publication | `packages/domain/src/auditService.ts:246-255` |

### Deliberate choices that look like findings but are not

- **The session cookie has no `Secure` flag** (`linkedin-dashboard/src/auth.ts:88-92`).
  The dashboard is loopback HTTP by design; the bind address is the transport
  boundary. Setting `Secure` would break the cookie without adding protection.
- **The launch token is printed to the terminal and travels in a URL fragment**
  (`linkedin-dashboard/src/server.ts:86-87`). A fragment never reaches the
  server or an HTTP log, and the token is single-use. It can still outlive the
  moment it was needed — in scrollback, in a copied link, in a screen share —
  so treat a printed launch URL as a credential until it has been used once.
- **There is no scheduler.** Nothing refreshes on a timer. This is a product
  decision about predictability, not a limitation imposed by LinkedIn.

## Non-goals

These are out of scope. Reports about them will be closed as working-as-intended
unless they show something beyond the stated model.

- **Protecting you from software running as you.** DPAPI wraps the master key
  with material derived from your Windows account. Any process running under
  that account can call Unprotect and read the key back. There is no passphrase
  and no hardware binding. This raises the cost of offline and cross-account
  theft; it is not a defence against malware running as you. The code says so
  itself at `packages/domain/src/secretStore.ts:8-20`.
- **Multi-user or multi-machine isolation.** One Windows account, one machine.
  Copying a data home to another machine or account leaves it undecryptable by
  design.
- **Network-level protection of the dashboard.** It is loopback plaintext HTTP.
  If an attacker is already executing code on the machine, the dashboard is not
  the weakest thing available to them.
- **Guarantees about LinkedIn's behaviour.** This project cannot promise that a
  profile read is current, that an API version stays available, or that any
  particular LinkedIn policy is satisfied by your usage. A green test suite
  demonstrates the behaviour of this code, nothing more.
- **Secrets you paste into the wrong place.** The product never asks for a
  LinkedIn password and never puts a token into an AI-client configuration. If
  you put one there yourself, nothing here can retract it.

## Scope

In scope: this repository's code, its default configuration, its setup
assistant, and its documentation.

Out of scope: LinkedIn's own services, your MCP client, Node.js, Windows, and
third-party dependencies (report those upstream — though tell us too if this
project's use of one is what makes it exploitable).
