# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is pre-1.0. Breaking changes may land in a minor release; see
[docs/releases.md](docs/releases.md).

## [Unreleased]

Preparation for the first public release.

The published history begins at this release. The project was developed in a
private repository whose earlier commits contained personal data — the author's
own and, in one script, other people's — that had been removed from the working
tree but not from the commits beneath it. Rather than publish that and rely on a
rewrite to hide it, the public repository starts from a fresh root. Nothing in
the tree changed; only the commits below it are absent.

### Added

- **Guided onboarding.** A first run now lands on a Setup screen that reports
  what is configured and offers three ways to get evidence in: upload
  documents, point at a folder, or type a short description of yourself.
  `linkedin_readiness_check` reports the same thing to an agent, and is
  deliberately ungated so it still answers when features are switched off.
- **`.docx` import.** A Word CV now extracts, using the existing hardened ZIP
  reader rather than a new parser dependency.
- **Self-attested evidence.** Typed self-description is stored as a real,
  redacted artifact under a fourth trust class ranking below `personal_doc`,
  so claims resting only on it stay distinguishable from claims backed by a
  document. Over MCP, `linkedin_intake_describe` binds its confirmation to a
  digest of the exact text, because that payload arrives through the model
  channel and an id-bound confirmation could be collected for one text and
  spent on another.
- **Dashboard upload.** `POST /api/intake/upload`, dashboard-only: an agent
  already has filesystem access and should pass a path.

- `LICENSE` (MIT), `NOTICE`, and a generated `THIRD-PARTY-NOTICES.md`, plus an
  `npm run notices` script that regenerates the latter from `package-lock.json`.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`,
  `.env.example`, and a `docs/` set covering architecture, threat model, privacy
  and local data, releases, compatibility, and known limitations.
- `scripts/examples/propose-claim.ts` and `scripts/examples/validate-draft.ts` —
  runnable end-to-end examples that write to a throwaway data home under the OS
  temp directory and delete it on exit.
- `tests/helpers/platform.ts`, naming in one place what cannot run off Windows.
- Biome (`biome.json`), an `.editorconfig`, an `.nvmrc`, and a
  `.git-blame-ignore-revs` so `git blame` skips the whole-tree reformat.
- GitHub Actions CI (Windows), CodeQL, Dependabot, issue and pull-request
  templates, and secret-scanning exclusions for the synthetic token fixtures.
- `license`, `author`, `repository`, `bugs`, and `homepage` fields on all eight
  workspace manifests. All eight remain `"private": true`; nothing is published
  to a package registry.

### Changed

- **Documented build order corrected.** The README previously listed `npm test`
  before `npm run build`, but the protocol-cleanliness suite drives the compiled
  stdio server and needs `dist/` to exist. A fresh clone that followed the old
  order got a red suite for that reason alone.
- **Platform support stated honestly.** The README implied the server was
  broadly portable. Evidence import accepts drive-letter paths only and the
  credential vault requires Windows DPAPI, so Windows is now documented as the
  only supported platform, and the LinkedIn read lane's EEA/Switzerland
  restriction is stated where it matters.
- `scripts/dma-sync.ts` and `scripts/dev-migrate.ts` now resolve the data home
  through `resolveDataHome()` instead of reading the environment directly.
  **This is stricter:** a relative `LINKEDIN_MCP_HOME`, or one pointing at a
  filesystem root, is now rejected rather than silently accepted.
- `tests/integration/setup-assistant.test.ts` is skipped off Windows instead of
  failing there. It spawns Windows PowerShell, which does not exist elsewhere.
- Test fixtures use an invented persona throughout. Significant-token counts
  were preserved wherever a lexical check reads the text, so evidence-coverage
  scoring is unchanged.
- `docs/linkedin-app-setup.md` is now a generic procedure with placeholders. It
  keeps the irreversible-Page warning, which is the section's real value.
- `packages/importers/src/zip.ts` and `packages/domain/src/secretStore.ts` now
  write control characters as escapes rather than raw bytes. Both files were
  classified as binary by `file`, `grep`, and GitHub, so neither could be
  searched or shown as a diff. Byte-identical at runtime: the regex class was
  verified equivalent and the AAD separator confirmed to be exactly U+0000.
- Whole-tree Biome formatting applied as one isolated commit (117 files, no
  Markdown, CSS excluded). No behaviour change.

### Removed

- 33 single-use development scripts that operated directly on the default data
  home — several of them mutating or removing stored records — without any of
  the confirmation contracts the product requires everywhere else. The seven
  reusable scripts are unchanged.

### Fixed

- **Backups left the artifacts out, and wrote them beside the archive.** When
  the data home's path was not its own canonical path — an 8.3 alias such as
  `PROGRA~1`, a long account name, any folder with a space, a junction — the
  artifact copies were written to a directory next to the backup instead of
  inside it, the manifest recorded them under paths that climbed out of the
  archive, and `verifyBackup` then correctly refused the result as unsafe. A
  backup is what unlocks the full purge, so on such a machine the purge stayed
  locked and the archive did not hold the evidence it claimed to. The paths a
  backup measures against are now canonicalised, and a containment check
  refuses any destination outside the backup directory.
- **A first run reached Overview instead of Setup.** Spending the single-use
  launch token rewrote the URL fragment to `#/overview`, and the shell reads an
  explicit fragment as the member having asked for somewhere specific — so the
  first-run redirect stood down on exactly the run it exists for, and Setup was
  reachable only on a second visit. The fragment is now stripped to nothing,
  which already resolves to Overview for a returning member while leaving the
  shell able to tell that nowhere in particular was requested. The onboarding
  entry above was written against the intended behaviour and was not true of a
  clean first run until this was fixed.
