# Contributing

Thanks for looking. This is a small, opinionated project; the guidance below is
mostly about the two or three things that are genuinely easy to get wrong here.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Windows 10 or later.** This is the only supported platform — see
  [docs/compatibility.md](docs/compatibility.md) for why, and for what does and
  does not work elsewhere.
- **Node.js 24 or later.** The database uses the built-in `node:sqlite`
  (`packages/db/src/driver.ts:6-9`), so 24 is a hard floor, not a preference.
- **Windows PowerShell 5.1** for the credential-vault tests. It ships with
  Windows.

## Getting a green build

Run these from the repository root, **in this order**:

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

**Build before test.** The protocol-cleanliness suite spawns the compiled stdio
server and asserts that every byte on stdout is JSON-RPC, so it needs
`linkedin-mcp-server/dist/index.js` to exist
(`tests/integration/protocol-clean.test.ts:96`). Running `npm test` on a fresh
clone without building first fails for that reason and no other.

Optional:

```powershell
npm run inspect:list   # tool catalog through MCP Inspector (downloads it)
npm run test:visual    # real-browser pass; needs a Playwright browser install
```

## Never point development at your real data home

The app stores everything under `%LOCALAPPDATA%\linkedin-mcp` by default. Do not
develop against it. Set an isolated home first:

```powershell
$env:LINKEDIN_MCP_HOME = "C:\dev\linkedin-mcp-scratch"
```

The test suite already isolates itself — fixtures use a fresh temp directory per
run (`tests/helpers/fixtures.ts:37-38`) and the Playwright suite uses its own home
and port (`tests/visual/paths.ts:7-9`) — but scripts you run by hand do not
protect you.

Two example scripts under `scripts/examples/` are safe to run as-is: each
creates a throwaway home under the OS temp directory and deletes it on exit.

## Rules that are not negotiable

### No real personal data in fixtures, ever

Test fixtures use an invented persona. Never paste a real name, employer,
school, profile URL, or LinkedIn client id into a test, a comment, a script, or
a document — not even your own.

If you change fixture text that a lexical check reads, **preserve the
significant-token count**. Evidence coverage is token overlap over a
stopword-filtered set (`packages/domain/src/coverageService.ts:45,58-59,73-74`),
so swapping a two-word company name for a three-word one silently shifts
coverage ratios and can weaken a test without failing it.

### Do not weaken a confirmation contract

Several operations require an exact string before they will act: `ENABLE
<source_id>`, `APPROVE <approval_id> <revision_hash>`, `REJECT <approval_id>`,
`REVISE <approval_id>`, `PUBLISH <approval_id>`, and the destructive purge
phrases. These are the product. A change that makes any of them easier to
satisfy — inferring intent, accepting a prefix, defaulting a flag — will be
declined even if the tests pass.

The same goes for: the audit chain gating external actions
(`packages/domain/src/auditService.ts:244-253`), `live_publishing` defaulting to
off (`packages/domain/src/featureControlService.ts:70-73`), and ambiguous
network outcomes never being retried automatically
(`packages/linkedin/src/adapters.ts:112-133`).

### Keep stdout clean in the MCP server

Stdout is the JSON-RPC transport. Diagnostics go to stderr
(`linkedin-mcp-server/src/log.ts`). A stray `console.log` corrupts the protocol,
and there is a test that will catch it.

## Formatting

```powershell
npm run format   # biome format --write .
npm run lint     # biome check .
```

Biome is configured in `biome.json`. Two things about it are deliberate:

- **CSS is excluded.** `tests/unit/design-tokens.test.ts` parses the raw
  stylesheet files, and `tests/integration/dashboard-client-bundle.test.ts`
  holds `app.css` to a 16 KB gzipped budget. Reformatting CSS puts both at
  risk for no benefit.
- **Formatter only; never `--unsafe` fixes.** The linter runs as a separate,
  currently non-blocking CI job. Do not bulk-apply its suggestions: several
  would touch confirmation and crypto paths where the existing shape is
  intentional.

The repository predates Biome, so a first whole-tree `npm run format` will
touch a large number of files. If you run it, land it as **its own commit**
containing formatting and nothing else, then add that commit SHA to
`.git-blame-ignore-revs`.

## Pull requests

- Branch from `main`.
- Sign off your commits: `git commit -s`. This project uses the
  [Developer Certificate of Origin](https://developercertificate.org/) — the
  sign-off is your statement that you wrote the change or have the right to
  submit it. There is no CLA.
- Keep the diff focused. A formatting sweep mixed into a behaviour change is
  hard to review and will be sent back.
- Update the docs in the same PR when behaviour changes.
- Tests: a bug fix should come with the test that fails without it.

## Reporting security issues

Do not open an issue. See [SECURITY.md](SECURITY.md).
