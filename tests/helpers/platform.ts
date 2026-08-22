// One place that names what still cannot run off Windows.
//
// The product supports Windows and Linux. Evidence import accepts each
// platform's own absolute-path shape (packages/importers/src/pathGuard.ts) and
// the credential vault has two implementations: Windows DPAPI through Windows
// PowerShell, and elsewhere a key derived from the machine id and user id
// (packages/domain/src/machineKey.ts).
//
// What remains Windows-only is the DPAPI half of that vault and the PowerShell
// setup assistant. Suites that drive either of those skip elsewhere rather than
// soften their assertions — a green run on Linux must never read as evidence
// that DPAPI works.
//
// Skipping is not how the cross-platform code is covered. Both path-guard rule
// sets, both data-home defaults and the whole non-DPAPI vault take the platform
// as an argument, so they are exercised from either host:
//   tests/unit/path-guard-platforms.test.ts
//   tests/unit/data-home-platforms.test.ts
//   tests/unit/machine-key.test.ts
//   tests/unit/secret-store-machine-key.test.ts
//
// tests/unit/secret-store.test.ts keeps its own probe instead of this flag: it
// checks that DPAPI itself answers, which is stronger than checking the OS.
export const IS_WINDOWS = process.platform === 'win32';
