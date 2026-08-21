// One place that names what cannot run off Windows.
//
// The product is supported on Windows only: evidence import accepts
// drive-letter paths exclusively (packages/importers/src/pathGuard.ts) and the
// credential vault is Windows DPAPI via Windows PowerShell 5.1
// (packages/domain/src/secretStore.ts). Suites that drive those surfaces skip
// elsewhere rather than soften their assertions — a green run on another
// platform must never read as evidence that they work.
//
// tests/unit/secret-store.test.ts keeps its own probe instead of this flag: it
// checks that DPAPI itself answers, which is stronger than checking the OS.
export const IS_WINDOWS = process.platform === 'win32';
