import { InMemoryTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '@linkedin-mcp/shared';
import { buildServer } from '../../linkedin-mcp-server/src/adapters/sdkV2.ts';
import { defineTool, type ToolDef } from '../../linkedin-mcp-server/src/registry.ts';
import type { PromptDef } from '../../linkedin-mcp-server/src/prompts.ts';
import type { ResourceDef } from '../../linkedin-mcp-server/src/resources.ts';

// The one place the SDK-neutral registry meets the MCP SDK. Until now it was
// only ever exercised through a spawned server, which proved the wire format
// but could not reach the branches that matter here: what a DomainError becomes
// versus what an unexpected throw becomes, and whether either leaks internals.
//
// InMemoryTransport drives the real server object without a subprocess.

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
}

class Harness {
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  readonly #client: { send: (m: unknown) => Promise<void>; close: () => Promise<void> };
  readonly stderr: unknown[] = [];

  constructor(client: {
    send: (m: unknown) => Promise<void>;
    close: () => Promise<void>;
    onmessage?: unknown;
  }) {
    this.#client = client;
    (client as { onmessage: (m: Record<string, unknown>) => void }).onmessage = (message) => {
      const id = message['id'] as number | undefined;
      if (id === undefined) return;
      this.#pending.get(id)?.resolve(message);
      this.#pending.delete(id);
    };
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const response = new Promise<Record<string, unknown>>((resolve) => {
      this.#pending.set(id, { resolve });
    });
    await this.#client.send({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.#client.send({ jsonrpc: '2.0', method, params });
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}

const open: Harness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close().catch(() => {});
});

async function connect(
  tools: ToolDef[],
  resources: ResourceDef[] = [],
  prompts: PromptDef[] = [],
): Promise<Harness> {
  const server = buildServer(tools, resources, prompts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const harness = new Harness(clientTransport as never);
  open.push(harness);
  await clientTransport.start();
  await harness.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'sdk-adapter-test', version: '0' },
  });
  await harness.notify('notifications/initialized');
  return harness;
}

const okTool = defineTool({
  name: 'linkedin_ok_tool',
  title: 'Ok',
  description: 'Returns what it was given.',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  permission: 'local-read',
  handler: async ({ value }) => ({ echoed: value }),
});

const domainErrorTool = defineTool({
  name: 'linkedin_domain_error_tool',
  title: 'Domain error',
  description: 'Always raises a DomainError.',
  inputSchema: z.object({}),
  outputSchema: z.object({ never: z.string() }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  permission: 'local-read',
  handler: async () => {
    throw new DomainError('CAPABILITY_UNAVAILABLE', 'the write lane is not verified', {
      blockers: ['lane_unverified'],
      retryable: true,
    });
  },
});

const explodingTool = defineTool({
  name: 'linkedin_exploding_tool',
  title: 'Explodes',
  description: 'Throws something that is not a DomainError.',
  inputSchema: z.object({}),
  outputSchema: z.object({ never: z.string() }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  permission: 'local-read',
  handler: async () => {
    throw new Error('connection string postgres://user:hunter2@db.internal failed');
  },
});

describe('tool registration', () => {
  it('lists tools sorted, with their annotations intact', async () => {
    const client = await connect([explodingTool, okTool, domainErrorTool]);

    const listed = (await client.request('tools/list')).result as {
      tools: Array<{ name: string; annotations: Record<string, boolean> }>;
    };
    // Deterministic order is a spec SHOULD, and it is what lets a host cache.
    expect(listed.tools.map((t) => t.name)).toEqual([
      'linkedin_domain_error_tool',
      'linkedin_exploding_tool',
      'linkedin_ok_tool',
    ]);
    expect(listed.tools[2]!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('returns structuredContent and a serialized echo of it', async () => {
    const client = await connect([okTool]);

    const result = (
      await client.request('tools/call', {
        name: 'linkedin_ok_tool',
        arguments: { value: 'hello' },
      })
    ).result as {
      structuredContent: { echoed: string };
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ echoed: 'hello' });
    // The text echo must be the same object, not a prose summary of it.
    expect(JSON.parse(result.content[0]!.text)).toEqual({ echoed: 'hello' });
    expect(result.content[0]!.type).toBe('text');
  });

  it('refuses to build a registry that breaks its own rules', () => {
    const duplicate = { ...okTool, name: 'linkedin_ok_tool' as const };
    expect(() => buildServer([okTool, duplicate])).toThrow(/duplicate/i);
  });
});

describe('error translation', () => {
  it('turns a DomainError into an in-result payload, keeping its code and blockers', async () => {
    const client = await connect([domainErrorTool]);

    const result = (
      await client.request('tools/call', {
        name: 'linkedin_domain_error_tool',
        arguments: {},
      })
    ).result as {
      isError: boolean;
      structuredContent: {
        error: { code: string; blockers: string[]; retryable: boolean; message: string };
      };
    };

    // In-result, not a JSON-RPC error: the model has to be able to read it and
    // act, which is the whole reason blockers exist.
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(result.structuredContent.error.blockers).toEqual(['lane_unverified']);
    expect(result.structuredContent.error.retryable).toBe(true);
    expect(result.structuredContent.error.message).toBe('the write lane is not verified');
  });

  it('reduces an unexpected throw to INTERNAL and never echoes its message', async () => {
    const client = await connect([explodingTool]);

    const result = (
      await client.request('tools/call', {
        name: 'linkedin_exploding_tool',
        arguments: {},
      })
    ).result as {
      isError: boolean;
      structuredContent: { error: { code: string; message: string; blockers: string[] } };
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('INTERNAL');
    expect(result.structuredContent.error.blockers).toEqual([]);
    // The thrown message carried a connection string. Anything that reaches the
    // model must not, and the serialized echo is a second place it could leak.
    expect(result.structuredContent.error.message).not.toContain('hunter2');
    expect(result.structuredContent.error.message).not.toContain('postgres://');
    expect(result.content[0]!.text).not.toContain('hunter2');
    expect(result.structuredContent.error.message).toMatch(/stderr/);
  });
});

describe('resource registration', () => {
  const resource: ResourceDef = {
    uri: 'linkedin://test/resource',
    name: 'test_resource',
    title: 'Test resource',
    description: 'A resource for the adapter test.',
    mimeType: 'text/markdown',
    ttlMs: 1234,
    cacheScope: 'private',
    read: () => ({ text: '# body' }),
  };

  it('lists and reads a registered resource, carrying its cache metadata', async () => {
    const client = await connect([okTool], [resource]);

    const listed = (await client.request('resources/list')).result as {
      resources: Array<{ uri: string; mimeType: string }>;
    };
    expect(listed.resources.map((r) => r.uri)).toEqual(['linkedin://test/resource']);

    const read = (await client.request('resources/read', { uri: 'linkedin://test/resource' }))
      .result as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
      cacheScope?: string;
      ttlMs?: number;
    };
    expect(read.contents[0]!.text).toBe('# body');
    expect(read.contents[0]!.mimeType).toBe('text/markdown');
    // Cacheability travels with the result; personal data must stay private.
    expect(read.cacheScope).toBe('private');
    expect(read.ttlMs).toBe(1234);
  });
});

describe('prompt registration', () => {
  const prompt: PromptDef = {
    name: 'test_prompt',
    title: 'Test prompt',
    description: 'A prompt for the adapter test.',
    arguments: [
      { name: 'required_arg', description: 'Must be supplied', required: true },
      { name: 'optional_arg', description: 'May be omitted', required: false },
    ],
    build: (args) => `built with ${args['required_arg']} and ${args['optional_arg'] ?? 'nothing'}`,
  };

  it('lists a prompt with its declared arguments', async () => {
    const client = await connect([okTool], [], [prompt]);

    const listed = (await client.request('prompts/list')).result as {
      prompts: Array<{ name: string; arguments?: Array<{ name: string; required?: boolean }> }>;
    };
    expect(listed.prompts.map((p) => p.name)).toEqual(['test_prompt']);
    const args = listed.prompts[0]!.arguments ?? [];
    expect(args.find((a) => a.name === 'required_arg')?.required).toBe(true);
  });

  it('builds the message from the supplied arguments', async () => {
    const client = await connect([okTool], [], [prompt]);

    const got = (
      await client.request('prompts/get', {
        name: 'test_prompt',
        arguments: { required_arg: 'alpha' },
      })
    ).result as { messages: Array<{ role: string; content: { type: string; text: string } }> };

    expect(got.messages[0]!.role).toBe('user');
    expect(got.messages[0]!.content.text).toBe('built with alpha and nothing');
  });
});
