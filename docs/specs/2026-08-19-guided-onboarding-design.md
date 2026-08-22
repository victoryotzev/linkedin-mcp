# Guided onboarding, easy import, and self-attested evidence

**Status:** approved 2026-08-19 · **Scope:** one implementation cycle

## Problem

A new user starting this product from zero has no path in. There is no
first-run experience, no way to get a document in except registering a
filesystem path by hand, and the most common CV format on earth — `.docx` —
is not supported at all. The `manual` source kind exists but is vestigial:
`importService.ts` returns no candidates for it, and `registerSource` demands a
real directory it will then refuse to scan.

This design covers three components that together take a user from a fresh
install to a reviewed claim ledger. OCR is deliberately **out of scope** (see
Non-goals).

## Non-goals

- **OCR.** A separate decision with its own dependency, security, and platform
  questions. Revisit once real usage shows scanned documents actually matter.
- **Removing any confirmation contract.** Enabling a source still requires an
  explicit `ENABLE <source_id>`. "Easy" means fewer steps to reach the
  decision, never fewer decisions.
- **Uploading over MCP.** An agent already has filesystem access and should
  pass a path. Upload is a dashboard capability, mirroring the existing
  secret-entry asymmetry.

## Component A — First-run readiness check

New `packages/domain/src/readinessService.ts`. A pure read; it changes nothing.

```
readinessReport(db, home) -> {
  is_first_run: boolean,          // no enabled sources yet
  checks: Array<{
    id: string,
    status: 'ok' | 'action_needed' | 'unavailable',
    detail: string,
    remediation: string | null,
  }>,
  next_step: string,
}
```

Checks: data home resolved and writable · schema migrations applied · dashboard
client bundle present · LinkedIn capability status (already available from
`listCapabilities`) · feature flags · counts of sources, artifacts, claims.

`unavailable` is distinct from `action_needed` on purpose. A missing LinkedIn
credential outside the EEA is not something the user can act on, and telling
them to "fix" it would be wrong.

Surfaces: `linkedin_readiness_check` MCP tool (read-only) and a dashboard
screen. One service, two thin surfaces — the existing pattern.

## Component B — Guided intake

New `packages/domain/src/intakeService.ts`. Three entry paths converge on one
ingest.

### The ingest mechanism

`importOne(db, store, source, runId, candidate, dryRun)` already performs
hashing, duplicate detection, extraction, redaction, and the artifact row.
`CandidateFile` is `{ relpath, mtime, load(): Buffer }`.

Direct ingest therefore constructs a **synthetic candidate** whose `load()`
returns bytes held in memory, and calls `importOne` unchanged. Nothing bypasses
redaction, the size ceiling, or duplicate detection, because it is literally
the same function.

Rejected alternatives:

- *Managed inbox inside the data home, exempted from the overlap guard.*
  Weakens a deliberate control for convenience.
- *Transient staging outside the home.* Anything outside the home survives
  `DELETE ALL LOCAL DATA` until removed, and leaves `root_path` pointing at a
  directory that no longer exists. For typed text there is no original file, so
  writing one only to read it back is theatre.

### Virtual sources

A virtual source has no filesystem root. `root_path` is
`TEXT NOT NULL UNIQUE`, so it carries a namespaced sentinel — the pattern
already shipped by `packages/domain/src/dmaObservationService.ts:265`, which registers
`linkedin://dma`.

- Upload: `upload://<source_id>`
- Self-description: `manual://<source_id>`

`registerVirtualSource()` never calls `canonicalizePath` or `statSync`, so the
path guard is bypassed rather than loosened — it simply does not apply where
there is no path.

### The three paths

| Path | Surface | Mechanism |
|---|---|---|
| Point at a folder | MCP + dashboard | Unchanged `registerSource` + `runImport` |
| Upload files | Dashboard only | Multipart route → virtual source → synthetic candidate |
| Tell me about yourself | MCP + dashboard | Typed text → virtual source → one `about-me.md` artifact |

## Component C — `.docx`

New `packages/importers/src/docx.ts`. A `.docx` is a ZIP of XML; `yauzl` is
already a dependency behind a hardened wrapper with traversal and bomb guards.
Reading `word/document.xml` and converting `<w:p>` to newlines and `<w:t>` to
text needs no new dependency and no new attack surface.

Wired into `extract.ts` beside the existing `.pdf` branch, so redaction and the
extraction-size ceiling apply identically.

## The `self_attested` trust class

Typed text is unverified assertion — the thing this product exists to prevent.
It becomes a real artifact (content-addressed, immutable, redacted) under a
**fourth trust class ranking below `personal_doc`**.

Claims citing only `self_attested` evidence can be proposed and verified, but
are marked self-reported rather than evidence-backed. Reusing `personal_doc`
was rejected: it would make a typed sentence indistinguishable from a CV in the
ledger.

### Migration 019

`sources.trust` carries a CHECK constraint, and SQLite cannot alter one in
place. Migration 019 rebuilds the table, following the pattern proven by
migration 016.

`sources` differs from `audit_events` in one way that matters: it has three FK
children (`import_runs.source_id`, `artifacts.source_id`, and one in migration
005). Dropping a parent inside a transaction therefore needs
`PRAGMA defer_foreign_keys = ON`, so constraints are checked at commit — by
which time the rebuilt table carries identical ids and nothing is violated.

Migrations run inside `withWriteTx`, so a failure rolls back atomically. The
failure mode is "migration fails, app refuses to start", never "data lost".

**Required test:** migrate a *populated* database — sources with artifacts,
import_runs, and profile rows — and assert every child row still resolves.

## Testing

| Area | Test |
|---|---|
| Migration 019 | Populated DB with all three FK children survives the rebuild |
| Virtual sources | Registration without a path; sentinel uniqueness; path guard never invoked |
| Direct ingest | Redaction still applied; duplicate detection works; size ceiling enforced |
| Self-attestation | `self_attested` sources cannot silently back an evidence-backed claim |
| `.docx` | Text extracted; malformed and bomb archives rejected by existing guards |
| Readiness | First-run detection; `unavailable` distinguished from `action_needed` |
| Upload route | Loopback + session + `Sec-Fetch-Site` enforced like every other mutation |

The existing 459-test baseline must still pass unchanged.
