import { Hono } from 'hono';
import {
  enableSourceFromDashboard,
  ingestBytes,
  readinessReport,
  registerVirtualSource,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import type { ApiDeps } from './types.ts';

// Getting a first document in, from the surface where a person is already
// looking at their own screen.
//
// Upload exists here and nowhere else on purpose. Over stdio an agent already
// has filesystem access and should pass a path; a file-transfer channel through
// the model would be a way to put bytes in the store that the member never
// chose. This mirrors credential entry, which is also dashboard-and-CLI only.

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 20;
const MIN_DESCRIPTION = 40;
const MAX_DESCRIPTION = 20_000;

/**
 * Uploaded names are attacker-influenced and become `artifacts.source_relpath`,
 * which is indexed, rendered, and returned through MCP results. The importer's
 * path guard never sees this value — there is no path — so the basename is
 * taken here and anything resembling traversal or a device name is refused
 * rather than sanitised into something plausible.
 */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop()?.trim() ?? '';
  if (base === '' || base === '.' || base === '..') {
    throw new DomainError('INVALID_INPUT', `unusable file name: ${JSON.stringify(raw)}`);
  }
  if (base.length > 180) {
    throw new DomainError('INVALID_INPUT', `file name is too long: ${base.length} characters`);
  }
  // Control characters would forge log lines and MCP output; a colon is an
  // NTFS alternate data stream.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\x00-\x1F\x7F:]/.test(base)) {
    throw new DomainError('INVALID_INPUT', 'file name contains characters that are not allowed');
  }
  return base;
}

export function intakeRoutes(deps: ApiDeps): Hono {
  const api = new Hono();

  api.get('/readiness', (c) => c.json(readinessReport(deps.db, { home: deps.home ?? '' })));

  api.post('/intake/upload', async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) throw new DomainError('INVALID_INPUT', 'expected a multipart form upload');

    const files = form.getAll('files').filter((v): v is File => v instanceof File);
    if (files.length === 0) throw new DomainError('INVALID_INPUT', 'no files in the upload');
    if (files.length > MAX_FILES_PER_REQUEST) {
      throw new DomainError(
        'INVALID_INPUT',
        `${files.length} files in one request; the limit is ${MAX_FILES_PER_REQUEST}`,
      );
    }

    const label = String(form.get('label') ?? '').trim() || 'Uploaded documents';
    const trust = String(form.get('trust') ?? 'personal_doc');
    if (trust !== 'personal_doc' && trust !== 'own_repo') {
      // local_clone_reference describes a directory of someone else's code and
      // self_attested is reserved for typed text; neither is meaningful here.
      throw new DomainError('INVALID_INPUT', `uploads cannot be registered as '${trust}'`);
    }

    const source = registerVirtualSource(deps.db, { origin: 'upload', label, trust });
    // The member chose these files in a file picker on their own machine, in
    // this session. That is the review the ENABLE confirmation asks for, and
    // there is no path here for them to inspect afterwards.
    enableSourceFromDashboard(deps.db, source.id, 'dashboard');

    const results: Array<{ filename: string; imported: boolean; reason: string | null }> = [];
    for (const file of files) {
      const filename = safeFilename(file.name);
      if (file.size > MAX_UPLOAD_BYTES) {
        results.push({
          filename,
          imported: false,
          reason: `over the ${MAX_UPLOAD_BYTES}-byte upload limit`,
        });
        continue;
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      try {
        const report = await ingestBytes(deps.db, deps.store, {
          source_id: source.id,
          filename,
          bytes,
        });
        results.push({
          filename,
          imported: report.files_imported === 1,
          reason: report.rejects[0]?.reason ?? null,
        });
      } catch (err) {
        // One bad file does not abandon the rest, matching the scanned path.
        results.push({
          filename,
          imported: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json({
      source_id: source.id,
      label: source.label,
      trust: source.trust,
      imported: results.filter((r) => r.imported).length,
      results,
    });
  });

  api.post('/intake/describe', async (c) => {
    const body = await c.req
      .json<{ text?: string; label?: string }>()
      .catch(() => ({}) as { text?: string; label?: string });
    const text = (body.text ?? '').trim();
    if (text.length < MIN_DESCRIPTION) {
      throw new DomainError(
        'INVALID_INPUT',
        `write at least ${MIN_DESCRIPTION} characters so there is something to draw claims from`,
      );
    }
    if (text.length > MAX_DESCRIPTION) {
      throw new DomainError('INVALID_INPUT', `description is over ${MAX_DESCRIPTION} characters`);
    }

    // No text-bound confirmation here, unlike the MCP tool: the member typed
    // this into their own browser, so there is no channel in between that could
    // have substituted it.
    const source = registerVirtualSource(deps.db, {
      origin: 'self_description',
      label: (body.label ?? '').trim() || 'About me',
      trust: 'self_attested',
      notes: 'Typed by the member during onboarding.',
    });
    enableSourceFromDashboard(deps.db, source.id, 'dashboard');

    const report = await ingestBytes(deps.db, deps.store, {
      source_id: source.id,
      filename: 'about-me.md',
      bytes: Buffer.from(text, 'utf8'),
    });
    const artifactId = report.new_artifact_ids[0] ?? null;
    if (!artifactId) {
      throw new DomainError(
        'INTERNAL',
        `the description was not stored: ${report.rejects[0]?.reason ?? 'unknown reason'}`,
      );
    }

    return c.json({
      source_id: source.id,
      artifact_id: artifactId,
      trust: source.trust,
      char_count: text.length,
    });
  });

  return api;
}
