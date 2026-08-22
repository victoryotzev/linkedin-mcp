// One place that names what still cannot run off Windows.
//
// The product supports Windows, Linux and macOS. Evidence import accepts each
// platform's own absolute-path shape (packages/importers/src/pathGuard.ts) and
// the credential vault has three implementations: Windows DPAPI through Windows
// PowerShell, the macOS login Keychain (packages/domain/src/keychain.ts), and
// elsewhere a key derived from the machine id and user id
// (packages/domain/src/machineKey.ts).
//
// What remains Windows-only is the DPAPI half of that vault and the PowerShell
// setup assistant. Suites that drive either of those skip elsewhere rather than
// soften their assertions — a green run on Linux must never read as evidence
// that DPAPI works.
//
// Skipping is not how the cross-platform code is covered. Both path-guard rule
// sets, all three data-home defaults, the machine-key vault and the Keychain
// vault take their platform or their external command as an argument, so they
// are exercised from any host:
//   tests/unit/path-guard-platforms.test.ts
//   tests/unit/data-home-platforms.test.ts
//   tests/unit/machine-key.test.ts
//   tests/unit/secret-store-machine-key.test.ts
//   tests/unit/keychain.test.ts
//
// Injection cannot prove that the external commands behave as assumed — that
// `security` really exits 44 for a missing item, that a `-T`-authorised read
// really does not prompt — so that is proved separately, against the real
// binaries, only where they exist: the darwin-gated block at the foot of
// tests/unit/keychain.test.ts, and the DPAPI probe in
// tests/unit/secret-store.test.ts (which self-gates on PowerShell answering,
// stronger than checking the OS). Those are what the macos-latest and
// windows-latest lanes run and no other lane can.
export const IS_WINDOWS = process.platform === 'win32';
