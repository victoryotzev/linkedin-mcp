import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

describe('Hono Node adapter', () => {
  it('serves the dashboard fetch handler on loopback after the v2 upgrade', async () => {
    const app = new Hono().get('/health', (c) => c.json({ ok: true }));
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      if (!server.listening) await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
