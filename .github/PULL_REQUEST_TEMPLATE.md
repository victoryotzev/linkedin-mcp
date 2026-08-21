## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checks

- [ ] `npm ci && npm run typecheck && npm run build && npm test` all pass
      (build **before** test — the protocol suite needs `dist/`)
- [ ] Commits are signed off (`git commit -s`) — see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md)

## Safety

- [ ] **No real personal data added** — no real name, employer, school, profile
      URL, or LinkedIn client id in tests, comments, scripts, or docs
- [ ] If I changed fixture text a lexical check reads, I preserved the
      significant-token count so coverage scoring is unaffected
- [ ] **No confirmation contract weakened** — `ENABLE`, `APPROVE`, `REJECT`,
      `REVISE`, `PUBLISH`, and the purge phrases are unchanged, and nothing
      infers intent in place of an explicit string
- [ ] No new outbound network destination
- [ ] Docs updated in this PR if behaviour changed

## Notes for the reviewer

<!-- Anything non-obvious. What you were unsure about is the most useful thing here. -->
