// stdio transport rule: stdout carries protocol JSON-RPC only. Every
// diagnostic goes to stderr (also the spec's replacement for the deprecated
// Logging feature). Never import console.log in this app.
export function logError(message: string, err?: unknown): void {
  const suffix = err instanceof Error ? ` :: ${err.name}: ${err.message}` : '';
  process.stderr.write(`[linkedin-mcp] ${message}${suffix}\n`);
}

export function logInfo(message: string): void {
  process.stderr.write(`[linkedin-mcp] ${message}\n`);
}
