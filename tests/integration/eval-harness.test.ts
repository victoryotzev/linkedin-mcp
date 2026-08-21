import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const QUESTIONS = fileURLToPath(new URL('../fixtures/eval-questions.xml', import.meta.url));
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-evalrun-'));
  await execFileAsync(process.execPath, [TSX_CLI, 'scripts/seed-eval.ts'], {
    cwd: ROOT,
    env: { ...process.env, LINKEDIN_MCP_HOME: home },
    timeout: 120_000,
  });
}, 180_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

// The eval corpus is only useful if its answers stay true as the code evolves;
// running the harness in CI is what keeps the questions honest.
describe('evaluation harness', () => {
  it('ships ten questions with stable, string-comparable answers', () => {
    const xml = readFileSync(QUESTIONS, 'utf8');
    const questions = [...xml.matchAll(/<question>/g)];
    const answers = [...xml.matchAll(/<answer>([\s\S]*?)<\/answer>/g)];
    expect(questions).toHaveLength(10);
    expect(answers).toHaveLength(10);
    for (const [, answer] of answers) {
      expect(answer!.trim().length).toBeGreaterThan(0);
      expect(answer!.trim()).toBe(answer!.trim().replace(/\s+/g, ' '));
    }
  });

  it('derives every answer from the seeded corpus', async () => {
    const { stdout } = await execFileAsync(process.execPath, [TSX_CLI, 'scripts/run-eval.ts'], {
      cwd: ROOT,
      env: { ...process.env, LINKEDIN_MCP_HOME: home },
      timeout: 120_000,
    });
    expect(stdout).toContain('10/10 answers verified');
    expect(stdout).not.toContain('FAIL');
  }, 180_000);
});
