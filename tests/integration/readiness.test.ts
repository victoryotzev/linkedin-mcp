import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enableSourceFromDashboard,
  ingestBytes,
  readinessReport,
  registerVirtualSource,
  setFeatureControl,
} from '@linkedin-mcp/domain';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';

// The first-run screen. Its job is to tell someone what is true and what to do
// next; the distinction it must never blur is "you can fix this" against "this
// is not available to you".

let fx: Fixture;

beforeEach(() => {
  fx = createFixture('readiness');
});

afterEach(() => {
  fx.close();
});

const report = (clientDir?: string) =>
  readinessReport(fx.db, clientDir === undefined ? { home: fx.dir } : { home: fx.dir, clientDir });

const check = (id: string) => report().checks.find((c) => c.id === id);

describe('readiness report', () => {
  it('reports a fresh install as a first run', () => {
    const result = report();

    expect(result.is_first_run).toBe(true);
    expect(result.counts.sources_enabled).toBe(0);
    expect(result.counts.artifacts).toBe(0);
  });

  it('changes nothing it reports on', () => {
    const before = fx.db.get('SELECT COUNT(*) AS n FROM sources')?.['n'];
    report();
    report();
    expect(fx.db.get('SELECT COUNT(*) AS n FROM sources')?.['n']).toBe(before);
  });

  it('calls a missing LinkedIn credential unavailable, never action_needed', () => {
    // Nobody outside the EEA or Switzerland can obtain a portability token, so
    // presenting this as a task the member has failed to complete would be a
    // lie told on every single run.
    const linkedin = check('linkedin');

    expect(linkedin?.status).toBe('unavailable');
    expect(linkedin?.detail).toMatch(/still works/i);
  });

  it('asks for evidence when there is none', () => {
    const evidence = check('evidence');

    expect(evidence?.status).toBe('action_needed');
    expect(evidence?.remediation).toMatch(/type a short description/i);
  });

  it('points at the pending source once one is registered but not enabled', () => {
    registerVirtualSource(fx.db, { origin: 'upload', label: 'CV', trust: 'personal_doc' });

    const result = report();
    expect(result.counts.sources_pending).toBe(1);
    expect(result.checks.find((c) => c.id === 'evidence')?.remediation).toMatch(/ENABLE/);
    expect(result.next_step).toMatch(/ENABLE/);
  });

  it('stops being a first run once evidence is actually imported', async () => {
    const source = enableSourceFromDashboard(
      fx.db,
      registerVirtualSource(fx.db, {
        origin: 'self_description',
        label: 'About me',
        trust: 'self_attested',
      }).id,
      'human_cli',
    );
    await ingestBytes(fx.db, fx.store, {
      source_id: source.id,
      filename: 'about-me.md',
      bytes: Buffer.from('I build local-first tools.', 'utf8'),
    });

    const result = report();
    expect(result.is_first_run).toBe(false);
    expect(result.counts.sources_enabled).toBe(1);
    expect(result.counts.artifacts).toBe(1);
    expect(result.checks.find((c) => c.id === 'evidence')?.status).toBe('ok');
  });

  it('flags a missing dashboard bundle only when asked to look', () => {
    expect(check('dashboard_build')?.status).toBe('ok');

    const emptyDir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-noclient-'));
    try {
      const withDir = readinessReport(fx.db, { home: fx.dir, clientDir: emptyDir });
      const build = withDir.checks.find((c) => c.id === 'dashboard_build');
      expect(build?.status).toBe('action_needed');
      expect(build?.remediation).toMatch(/npm run build/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('puts a broken environment ahead of any amount of waiting work', () => {
    registerVirtualSource(fx.db, { origin: 'upload', label: 'CV', trust: 'personal_doc' });
    const emptyDir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-noclient-'));

    try {
      // There is a pending source to review, but a dashboard that will not
      // start is the thing standing in the way of reviewing it.
      const result = readinessReport(fx.db, { home: fx.dir, clientDir: emptyDir });
      expect(result.next_step).toMatch(/npm run build/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('reports live publishing as disabled by default, without calling it a problem', () => {
    const publishing = check('live_publishing');

    expect(publishing?.status).toBe('ok');
    expect(publishing?.detail).toMatch(/disabled/i);

    setFeatureControl(fx.db, 'live_publishing', true, { confirm: true, actor: 'human_cli' });
    expect(check('live_publishing')?.detail).toMatch(/enabled/i);
  });
});
