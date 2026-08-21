import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '@linkedin-mcp/shared';

const execFileAsync = promisify(execFile);

// Resolve the extraction script through the workspace package so it works both
// under tsx (sources) and from the bundled server (node_modules symlink).
function scriptPath(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('@linkedin-mcp/importers/package.json');
  return join(dirname(pkgJson), 'scripts', 'pdf-extract.mjs');
}

export interface PdfExtractResult {
  pages: string[];
}

const PDF_TIMEOUT_MS = 30_000;

export async function extractPdfText(pdfPath: string): Promise<PdfExtractResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [scriptPath(), pdfPath], {
      timeout: PDF_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string };
    if (e.killed) {
      throw new DomainError('INVALID_INPUT', 'PDF extraction timed out (parser killed)');
    }
    // Non-zero exit still writes a JSON error line we can surface.
    const detail = safeParseError(e.stdout);
    throw new DomainError('INVALID_INPUT', `PDF extraction failed: ${detail}`);
  }
  const parsed = JSON.parse(stdout) as { pages?: string[]; error?: string };
  if (!parsed.pages) {
    throw new DomainError('INVALID_INPUT', `PDF extraction failed: ${parsed.error ?? 'unknown'}`);
  }
  return { pages: parsed.pages };
}

function safeParseError(stdout: string | undefined): string {
  if (!stdout) return 'parser crashed with no output';
  try {
    return (JSON.parse(stdout) as { error?: string }).error ?? 'unknown';
  } catch {
    return 'parser crashed with unparseable output';
  }
}
