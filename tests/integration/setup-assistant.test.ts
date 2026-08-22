import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../helpers/platform.ts';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const powershell = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runSetup(root: string) {
  const configRoot = join(root, 'configs');
  const dataHome = join(root, 'shared-home');
  const fakeServer = join(root, 'server.js');
  writeFileSync(fakeServer, '// setup test entrypoint\n', 'utf8');

  return spawnSync(
    powershell,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(repositoryRoot, 'setup-mcp.ps1'),
      '-DataHome',
      dataHome,
      '-Clients',
      'ClaudeDesktop,VSCode,CopilotCLI,Cursor,Antigravity',
      '-NonInteractive',
      '-SkipDependencies',
      '-SkipBuild',
      '-NoPersistUserEnvironment',
      '-NodePath',
      process.execPath,
      '-ServerPath',
      fakeServer,
      '-ConfigRoot',
      configRoot,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

describe.skipIf(!IS_WINDOWS)('interactive MCP setup assistant', () => {
  it('merges selected clients into one shared home and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'linkedin-mcp-setup-'));
    const canonicalRoot = realpathSync.native(root);
    temporaryHomes.push(root);
    const configRoot = join(root, 'configs');
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      join(configRoot, 'cursor-mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } }, custom: true }, null, 2),
      'utf8',
    );

    const first = runSetup(root);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);

    const expectations = [
      ['claude-desktop.json', 'mcpServers'],
      ['vscode-mcp.json', 'servers'],
      ['copilot-mcp.json', 'mcpServers'],
      ['cursor-mcp.json', 'mcpServers'],
      ['antigravity-mcp.json', 'mcpServers'],
    ] as const;
    for (const [file, rootKey] of expectations) {
      const config = JSON.parse(readFileSync(join(configRoot, file), 'utf8')) as Record<
        string,
        Record<string, { command: string; args: string[]; env: Record<string, string> }>
      >;
      const entry = config[rootKey]?.['linkedin'];
      expect(entry?.command).toBe(process.execPath);
      // Against the canonical root, not the one mkdtemp happened to hand out.
      // The script resolves every path it is given through
      // [IO.Path]::GetFullPath, which expands an 8.3 alias to its long form,
      // and writing the long form into a client config is the right thing: a
      // short name can be turned off per volume and is not stable across
      // machines. Temp directories are 8.3-aliased on GitHub's own Windows
      // runners, so this is the ordinary case there rather than an exotic one.
      expect(entry?.args).toEqual([join(canonicalRoot, 'server.js')]);
      expect(entry?.env['LINKEDIN_MCP_HOME']).toBe(join(canonicalRoot, 'shared-home'));
    }

    const cursor = JSON.parse(readFileSync(join(configRoot, 'cursor-mcp.json'), 'utf8')) as {
      custom: boolean;
      mcpServers: Record<string, { command: string }>;
    };
    expect(cursor.custom).toBe(true);
    expect(cursor.mcpServers['existing']?.command).toBe('keep-me');

    const second = runSetup(root);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(second.stdout).toContain('Already configured');
    expect(
      readdirSync(configRoot).filter((name) => name.includes('.linkedin-mcp-backup-')),
    ).toHaveLength(1);
  });

  it('rejects an unknown client without touching configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'linkedin-mcp-setup-'));
    temporaryHomes.push(root);
    const result = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(repositoryRoot, 'setup-mcp.ps1'),
        '-DataHome',
        join(root, 'home'),
        '-Clients',
        'UnknownAgent',
        '-NonInteractive',
        '-SkipDependencies',
        '-SkipBuild',
        '-NoPersistUserEnvironment',
        '-NodePath',
        process.execPath,
        '-ServerPath',
        join(root, 'server.js'),
        '-ConfigRoot',
        join(root, 'configs'),
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Unknown client 'UnknownAgent'");
  });
});
