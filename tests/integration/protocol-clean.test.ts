import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../../linkedin-mcp-server/dist/index.js', import.meta.url));

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

// P1 acceptance gate: stdout carries ONLY newline-delimited JSON-RPC. A single
// stray console.log or dependency banner corrupts the stdio transport, so we
// capture every raw byte the server writes and account for all of them.
class StdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly rawChunks: Buffer[] = [];
  readonly #messages: JsonRpcMessage[] = [];
  #buffer = '';
  #waiters: Array<() => void> = [];

  constructor(home: string) {
    this.child = spawn(process.execPath, [DIST], {
      env: { ...process.env, LINKEDIN_MCP_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.rawChunks.push(chunk);
      this.#buffer += chunk.toString('utf8');
      let idx: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line-splitting loop
      while ((idx = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, idx).trim();
        this.#buffer = this.#buffer.slice(idx + 1);
        if (line.length > 0) {
          this.#messages.push(JSON.parse(line) as JsonRpcMessage);
        }
      }
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  send(message: object): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async waitForResponse(id: number, timeoutMs = 10000): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.#messages.find((m) => m.id === id && ('result' in m || 'error' in m));
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for response id=${id}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  rawStdout(): string {
    return Buffer.concat(this.rawChunks).toString('utf8');
  }

  async closeAndAwaitExit(timeoutMs = 5000): Promise<number | null> {
    this.child.stdin.end();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve(null);
      }, timeoutMs);
      this.child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

let home: string;
let client: StdioClient;

beforeEach(() => {
  expect(existsSync(DIST), `dist build missing at ${DIST} — run: npm run build`).toBe(true);
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-proto-'));
  client = new StdioClient(home);
});

afterEach(async () => {
  // The server holds the SQLite files open; wait for it to actually exit
  // before removing the directory, or Windows refuses with EPERM.
  if (client.child.exitCode === null) {
    client.child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      client.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('stdio protocol cleanliness', () => {
  it('serves a scripted session with zero non-protocol stdout bytes and exits on stdin EOF', async () => {
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'protocol-clean-test', version: '0.0.0' },
      },
    });
    const init = await client.waitForResponse(1);
    expect(init.error).toBeUndefined();
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await client.waitForResponse(2);
    expect(list.error).toBeUndefined();
    const tools = (
      list.result as {
        tools: Array<{
          name: string;
          title: string;
          description: string;
          inputSchema: object;
          outputSchema: object;
          annotations: Record<string, boolean>;
        }>;
      }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'linkedin_analytics_import',
      'linkedin_analytics_query',
      'linkedin_approval_decide',
      'linkedin_approval_status',
      'linkedin_artifact_list',
      'linkedin_audit_query',
      'linkedin_backup_run',
      'linkedin_calendar_plan',
      'linkedin_capability_status',
      'linkedin_capability_verify',
      'linkedin_changeset_export',
      'linkedin_changeset_generate',
      'linkedin_changeset_get',
      'linkedin_changeset_review',
      'linkedin_claim_list',
      'linkedin_claim_manage',
      'linkedin_conflict_list',
      'linkedin_conflict_resolve',
      'linkedin_content_opportunities',
      'linkedin_coverage_check',
      'linkedin_dma_sync',
      'linkedin_draft_list',
      'linkedin_draft_validate',
      'linkedin_draft_write',
      'linkedin_feature_control',
      'linkedin_import_run',
      'linkedin_intake_describe',
      'linkedin_patch_mark_applied',
      'linkedin_profile_diff',
      'linkedin_profile_get',
      'linkedin_profile_read_latest',
      'linkedin_profile_score',
      'linkedin_profile_update',
      'linkedin_publication_reconcile',
      'linkedin_publish_execute',
      'linkedin_publish_request',
      'linkedin_published_import',
      'linkedin_purge_run',
      'linkedin_readiness_check',
      'linkedin_settings_set',
      'linkedin_snapshot_import',
      'linkedin_source_list',
      'linkedin_source_manage',
      'linkedin_voice_profile',
    ]);
    for (const tool of tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(tool.outputSchema).toBeTypeOf('object');
      expect(Object.keys(tool.annotations).sort()).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
    }

    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'linkedin_capability_status', arguments: {} },
    });
    const call = await client.waitForResponse(3);
    expect(call.error).toBeUndefined();
    const structured = (call.result as { structuredContent: { capabilities: unknown[] } })
      .structuredContent;
    expect(structured.capabilities).toHaveLength(5);
    for (const cap of structured.capabilities as Array<{ status: string; blockers: string[] }>) {
      expect(cap.status).toBe('unavailable');
      expect(cap.blockers).toEqual(['no_linkedin_app']);
    }

    // Typed setting writes require a per-key value shape and explicit human
    // confirmation. Secret-shaped keys are excluded from the public schema and
    // still covered at the domain boundary by settings.test.ts.
    client.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'linkedin_settings_set',
        arguments: { key: 'dashboard.port', value: 4781, confirm: true },
      },
    });
    const setting = await client.waitForResponse(4);
    expect(setting.error).toBeUndefined();
    const settingResult = setting.result as {
      isError?: boolean;
      structuredContent: { key: string; value: number };
    };
    expect(settingResult.isError).not.toBe(true);
    expect(settingResult.structuredContent).toMatchObject({ key: 'dashboard.port', value: 4781 });

    // Cleanliness: every stdout byte belongs to a newline-delimited JSON line.
    const raw = client.rawStdout();
    const lines = raw.split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Reconstruction accounts for every byte (no partial trailing garbage).
    expect(lines.join('\n')).toBe(raw);

    // Spec: the server exits promptly when stdin closes.
    const exitCode = await client.closeAndAwaitExit();
    expect(exitCode).toBe(0);
  });

  it('serves the resource and prompt catalogues over the wire too', async () => {
    // The tool catalogue was asserted name-for-name here from the start; the
    // other two capabilities were only ever checked through unit tests against
    // the definition objects, which cannot catch a registration that never
    // reached the transport.
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'protocol-clean-test', version: '0.0.0' },
      },
    });
    await client.waitForResponse(1);
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    client.send({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
    const resources = await client.waitForResponse(2);
    expect(resources.error).toBeUndefined();
    const uris = (resources.result as { resources: Array<{ uri: string; name: string }> })
      .resources;
    expect(uris.map((r) => r.uri).sort()).toEqual([
      'linkedin://capabilities',
      'linkedin://evidence/rules',
      'linkedin://positioning/brief',
      'linkedin://profile/canonical',
      'linkedin://voice/profile',
    ]);

    client.send({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} });
    const prompts = await client.waitForResponse(3);
    expect(prompts.error).toBeUndefined();
    const names = (prompts.result as { prompts: Array<{ name: string }> }).prompts;
    expect(names.map((p) => p.name).sort()).toEqual([
      'draft_post_from_claims',
      'ingest_and_review_evidence',
      'profile_audit_session',
      'review_conflicts',
      'weekly_evidence_review',
    ]);

    expect(await client.closeAndAwaitExit()).toBe(0);
  });

  it('still negotiates the widely deployed 2025-06-18 protocol revision', async () => {
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'legacy-protocol-test', version: '0.0.0' },
      },
    });
    const init = await client.waitForResponse(1);
    expect(init.error).toBeUndefined();
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(await client.closeAndAwaitExit()).toBe(0);
  });
});
