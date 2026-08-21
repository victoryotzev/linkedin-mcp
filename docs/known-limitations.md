# Known limitations

Things this product does not do. Most are deliberate; a few are simply not
built yet. Each says which.

## Platform and access

- **Windows only.** *By construction.* Evidence import accepts drive-letter
  paths only and the credential vault is Windows DPAPI. See
  [compatibility.md](compatibility.md).
- **The LinkedIn read lane needs an EEA or Switzerland member.** *LinkedIn's
  limit, not ours.* Member Data Portability tokens are issued to nobody else.
  Everything that does not touch LinkedIn works regardless of where you are.
- **One Windows account, one machine.** *By construction.* DPAPI material is
  bound to the account that created it. A data home copied elsewhere cannot be
  decrypted there — that is the point, not a bug.

## What it will not do, on purpose

- **No scraping, browser automation, cookie reuse, or unofficial endpoints.**
  The only outbound host in the codebase is `https://api.linkedin.com`, pinned
  and re-checked on the response URL. When LinkedIn's Snapshot lags, the answer
  is to wait, not to find another door.
- **No scheduler, no background refresh.** Nothing happens on a timer. Data is
  pulled only when a person or an agent invokes a tool that pulls it. This is a
  product decision about predictability.
- **No bundled LLM.** The product checks whether a draft is backed by evidence
  you supplied. It has no opinion about strategy and generates no text on its
  own.
- **No automated engagement.** No liking, commenting, following, or messaging.
- **No hosted service.** There is no server to sign up for and no telemetry.

## Not built yet

- **OCR.** Scanned CVs and photographed certificates are not read. This was
  considered alongside `.docx` support and deliberately deferred: it means a
  large dependency or a native binary, a new untrusted-parser surface on image
  data, and per-language model files, none of which is justified until real
  usage shows scanned documents actually turn up. A scanned PDF currently
  imports and stores fine — it simply yields no text.

- **Media publishing.** The live publisher handles text posts only; a draft
  with media fails locally before any request is sent
  (`packages/linkedin/src/adapters.ts:61-67`). Asset upload is not implemented.
- **Downgrade.** Migrations are forward-only. Rolling back means restoring a
  verified backup — see [releases.md](releases.md).
- **Multi-account.** One member per data home. Running a second account means a
  second `LINKEDIN_MCP_HOME`.

## Honest limits on what the data can tell you

- **"Latest" is not "current".** LinkedIn's Member Snapshot response carries no
  data-generation timestamp and no completeness marker, and domains are collated
  at different times. Every freshness result is reported as
  `guarantee: "not_guaranteed"`, and a domain returning nothing is reported as
  `empty_or_not_ready` rather than as proof the section is empty. The long-form
  explanation is in
  [the server README](../linkedin-mcp-server/README.md#reading-the-latest-linkedin-profile).
- **The Member Changelog retains 28 days.** Anything not fetched and stored
  inside that window is gone; LinkedIn will not serve it again.
- **Search may degrade.** Where SQLite lacks FTS5, search falls back to `LIKE`.
  Safety paths never depend on search.
- **A passing test suite proves the suite's assertions.** It does not
  demonstrate production readiness, LinkedIn API compatibility, or compliance
  with any LinkedIn policy. Nothing in this repository should be read as legal
  or compliance advice.

## Project limits

- **One maintainer, pre-1.0.** Breaking changes may land in minor releases.
  There is no LTS branch and no support SLA. See [releases.md](releases.md) and
  [../SUPPORT.md](../SUPPORT.md).
