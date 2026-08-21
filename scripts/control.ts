import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  approvalPreview,
  configureLane,
  createSecretStore,
  disablePublishing,
  denyApproval,
  enablePublishing,
  enableSourceFromDashboard,
  grantApproval,
  getFeatureControl,
  listApprovals,
  listCapabilities,
  listFeatureControls,
  listLanes,
  listSources,
  probeLane,
  purgeDmaLane,
  purgeEverything,
  resolveBackupDir,
  seedCanonicalSections,
  seedCapabilities,
  verifyBackup,
  verifyLane,
  listBackups,
  FEATURE_KEYS,
  setFeatureControl,
  type FeatureKey,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { DomainError, resolveDataHome } from '@linkedin-mcp/shared';

export interface ControlRuntime {
  db: SqliteDriver;
  home: string;
  secrets: SecretStore;
  close(): void;
}

export type SecretProvider = () => Promise<string>;

/**
 * The terminal this CLI talks to.
 *
 * Named for the same reason `SecretProvider` is: the interactive menu is the
 * half of this file a person actually drives, and it was reachable only by
 * running the script and typing. Passing the streams in makes the menu — the
 * confirmation phrases it demands, the arguments it builds — assertable
 * without a terminal, and costs the real caller a default.
 */
export interface ControlIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export const processIo: ControlIo = { input: stdin, output: stdout };

export function openControlRuntime(): ControlRuntime {
  const home = resolveDataHome();
  const { db } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  migrate(db);
  seedCapabilities(db);
  seedCanonicalSections(db);
  let closed = false;
  return {
    db,
    home,
    secrets: createSecretStore(db, home),
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new DomainError('INVALID_INPUT', message);
  return value;
}

function lane(value: string | undefined): 'read' | 'write' {
  if (value !== 'read' && value !== 'write') {
    throw new DomainError('INVALID_INPUT', 'lane must be read or write');
  }
  return value;
}

function featureKey(value: string | undefined): FeatureKey {
  if (!value || !(FEATURE_KEYS as readonly string[]).includes(value)) {
    throw new DomainError('INVALID_INPUT', `feature must be one of: ${FEATURE_KEYS.join(', ')}`);
  }
  return value as FeatureKey;
}

function positiveSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DomainError('INVALID_INPUT', '--expires-in-seconds must be a positive integer');
  }
  return parsed;
}

export async function runControlCommand(
  runtime: ControlRuntime,
  args: readonly string[],
  secretProvider: SecretProvider = promptMaskedSecret,
): Promise<unknown> {
  const [area, action, id] = args;

  if (area === 'status') {
    return {
      home: runtime.home,
      sources: listSources(runtime.db),
      approvals: listApprovals(runtime.db),
      lanes: listLanes(runtime.db),
      capabilities: listCapabilities(runtime.db),
      features: listFeatureControls(runtime.db),
    };
  }

  if (area === 'source' && action === 'list') {
    return { sources: listSources(runtime.db) };
  }
  if (area === 'source' && action === 'enable') {
    return {
      source: enableSourceFromDashboard(
        runtime.db,
        required(id, 'source enable requires a source id'),
        'human_cli',
      ),
    };
  }

  if (area === 'approval' && action === 'list') {
    return { approvals: listApprovals(runtime.db) };
  }
  if (area === 'approval' && action === 'preview') {
    return {
      preview: approvalPreview(runtime.db, required(id, 'approval preview requires an id')),
    };
  }
  if (area === 'approval' && action === 'grant') {
    const approvalId = required(id, 'approval grant requires an id');
    const preview = approvalPreview(runtime.db, approvalId);
    const confirmedHash = required(
      option(args, '--revision-hash'),
      'approval grant requires --revision-hash after reviewing the exact preview',
    );
    if (confirmedHash !== preview.revision_hash) {
      throw new DomainError(
        'APPROVAL_INVALIDATED',
        'the confirmed revision hash does not match the approval preview; review it again',
        { blockers: ['revision_hash_mismatch'] },
      );
    }
    return {
      approval: grantApproval(runtime.db, approvalId, 'human_cli'),
    };
  }
  if (area === 'approval' && action === 'deny') {
    const reason = required(option(args, '--reason'), 'approval deny requires --reason');
    return {
      approval: denyApproval(
        runtime.db,
        required(id, 'approval deny requires an id'),
        reason,
        'human_cli',
      ),
    };
  }

  if (area === 'lane' && action === 'list') {
    return { lanes: listLanes(runtime.db) };
  }
  if (area === 'lane' && action === 'configure') {
    const selectedLane = lane(id);
    const clientId = required(option(args, '--client-id'), 'lane configure requires --client-id');
    const expiresInSeconds = positiveSeconds(option(args, '--expires-in-seconds'));
    const token = args.includes('--token-stdin')
      ? readFileSync(0, 'utf8').trim()
      : await secretProvider();
    return {
      account: await configureLane(runtime.db, runtime.secrets, {
        lane: selectedLane,
        client_id: clientId,
        access_token: token,
        actor: 'human_cli',
        ...(expiresInSeconds !== undefined ? { expires_in_seconds: expiresInSeconds } : {}),
      }),
    };
  }
  if (area === 'lane' && action === 'verify') {
    const selectedLane = lane(id);
    return {
      result: await verifyLane(
        runtime.db,
        runtime.secrets,
        selectedLane,
        (token) => probeLane(selectedLane, token),
        'human_cli',
      ),
    };
  }

  if (area === 'feature' && action === 'list') {
    return { features: listFeatureControls(runtime.db) };
  }
  if (area === 'feature' && (action === 'enable' || action === 'disable')) {
    if (!args.includes('--confirm')) {
      throw new DomainError('INVALID_INPUT', `feature ${action} requires --confirm`, {
        blockers: ['confirmation_required'],
      });
    }
    const key = featureKey(id);
    const enabled = action === 'enable';
    const current = getFeatureControl(runtime.db, key);
    if (current.enabled === enabled) return { feature: current };
    if (key === 'live_publishing') {
      if (enabled) enablePublishing(runtime.db, true, 'human_cli');
      else disablePublishing(runtime.db, true, 'human_cli');
    }
    return {
      feature: setFeatureControl(runtime.db, key, enabled, {
        confirm: true,
        actor: 'human_cli',
      }),
    };
  }

  if (area === 'publishing' && action === 'enable') {
    if (!args.includes('--confirm')) {
      throw new DomainError(
        'INVALID_INPUT',
        'publishing enable requires --confirm after the write lane has been verified',
      );
    }
    const result = enablePublishing(runtime.db, true, 'human_cli');
    const feature = setFeatureControl(runtime.db, 'live_publishing', true, {
      confirm: true,
      actor: 'human_cli',
    });
    return { result, feature };
  }
  if (area === 'publishing' && action === 'disable') {
    if (!args.includes('--confirm')) {
      throw new DomainError('INVALID_INPUT', 'publishing disable requires --confirm');
    }
    const result = disablePublishing(runtime.db, true, 'human_cli');
    const feature = setFeatureControl(runtime.db, 'live_publishing', false, {
      confirm: true,
      actor: 'human_cli',
    });
    return { result, feature };
  }

  if (area === 'purge' && action === 'dma') {
    // Deleting Portability Data must be reachable without the dashboard: the
    // portability terms require honouring a deletion request, and the member
    // may well be deleting because they no longer want to run the UI.
    const before = option(args, '--before');
    if (before === undefined) {
      const phrase = option(args, '--confirm');
      if (phrase !== 'DELETE LINKEDIN PORTABILITY DATA') {
        throw new DomainError(
          'INVALID_INPUT',
          'purge dma requires --confirm "DELETE LINKEDIN PORTABILITY DATA", or --before <ISO> to prune older history instead',
        );
      }
    }
    return {
      result: purgeDmaLane(runtime.db, {
        ...(before !== undefined ? { before } : {}),
        confirm: true,
        actor: 'human_cli',
      }),
    };
  }

  if (area === 'purge' && action === 'all') {
    const phrase = option(args, '--confirm');
    if (phrase !== 'DELETE ALL LOCAL DATA') {
      throw new DomainError(
        'INVALID_INPUT',
        'purge all requires --confirm "DELETE ALL LOCAL DATA"',
      );
    }
    const verifiedBackup = listBackups(runtime.home).some((backup) => {
      try {
        const directory = resolveBackupDir(runtime.home, backup.name);
        return directory !== null && verifyBackup(directory).valid;
      } catch {
        return false;
      }
    });
    if (!verifiedBackup && !args.includes('--accept-no-backup')) {
      throw new DomainError(
        'INVALID_INPUT',
        'no verified backup exists; create and verify one first, or add --accept-no-backup after accepting permanent loss',
      );
    }
    runtime.close();
    return { result: purgeEverything(runtime.home, phrase) };
  }

  throw new DomainError('INVALID_INPUT', usage());
}

function powershellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Prompts in a child PowerShell host so the token is masked and never enters argv. */
export async function promptMaskedSecret(): Promise<string> {
  const script = [
    "[Console]::Error.Write('LinkedIn access token (masked): ')",
    "$secure = Read-Host -AsSecureString -Prompt ''",
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) }',
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(powershellPath(), ['-NoProfile', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    throw new DomainError('INTERNAL', 'the masked credential prompt failed; no secret was stored');
  }
  return result.stdout.trim();
}

export async function interactiveArgs(
  runtime: ControlRuntime,
  io: ControlIo = processIo,
): Promise<string[]> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    io.output.write(`Human control CLI — shared home: ${runtime.home}\n\n`);
    io.output.write(
      [
        '1. Status',
        '2. Enable an evidence source',
        '3. Preview a publication approval',
        '4. Grant a publication approval',
        '5. Decline a publication approval',
        '6. Configure encrypted LinkedIn credentials',
        '7. Verify a LinkedIn lane',
        '8. Enable real publishing',
        '9. Feature settings',
        '10. Delete all local data',
      ].join('\n') + '\n',
    );
    const choice = (await rl.question('\nSelection: ')).trim();
    if (choice === '1') return ['status'];
    if (choice === '2') {
      printJson(
        { pending_sources: listSources(runtime.db, { status: 'pending_review' }) },
        io.output,
      );
      return ['source', 'enable', (await rl.question('Source id: ')).trim()];
    }
    if (choice === '3' || choice === '4' || choice === '5') {
      printJson({ pending_approvals: listApprovals(runtime.db, 'pending') }, io.output);
      const approvalId = (await rl.question('Approval id: ')).trim();
      if (choice === '3') return ['approval', 'preview', approvalId];
      if (choice === '4') {
        const preview = approvalPreview(runtime.db, approvalId);
        printJson({ preview }, io.output);
        const revisionHash = (
          await rl.question('Type the exact revision_hash shown above to approve: ')
        ).trim();
        return ['approval', 'grant', approvalId, '--revision-hash', revisionHash];
      }
      const reason = (await rl.question('Decline reason: ')).trim();
      return ['approval', 'deny', approvalId, '--reason', reason];
    }
    if (choice === '6') {
      const selectedLane = (await rl.question('Lane (read/write): ')).trim();
      const clientId = (await rl.question('LinkedIn client id: ')).trim();
      const expires = (await rl.question('Expires in seconds (optional): ')).trim();
      return [
        'lane',
        'configure',
        selectedLane,
        '--client-id',
        clientId,
        ...(expires ? ['--expires-in-seconds', expires] : []),
      ];
    }
    if (choice === '7') {
      return ['lane', 'verify', (await rl.question('Lane (read/write): ')).trim()];
    }
    if (choice === '8') {
      const confirmation = await rl.question('Type ENABLE PUBLISHING: ');
      if (confirmation !== 'ENABLE PUBLISHING') {
        throw new DomainError('INVALID_INPUT', 'publishing was not enabled');
      }
      return ['publishing', 'enable', '--confirm'];
    }
    if (choice === '9') {
      printJson({ features: listFeatureControls(runtime.db) }, io.output);
      const key = (await rl.question('Feature key: ')).trim();
      const action = (await rl.question('Action (enable/disable): ')).trim();
      if (action !== 'enable' && action !== 'disable') {
        throw new DomainError('INVALID_INPUT', 'action must be enable or disable');
      }
      const confirmation = await rl.question(`Type ${action.toUpperCase()} ${key}: `);
      if (confirmation !== `${action.toUpperCase()} ${key}`) {
        throw new DomainError('INVALID_INPUT', 'feature setting was not changed');
      }
      return ['feature', action, key, '--confirm'];
    }
    if (choice === '10') {
      const accept = await rl.question('Type DELETE ALL LOCAL DATA: ');
      const verifiedBackup = listBackups(runtime.home).some((backup) => {
        try {
          const directory = resolveBackupDir(runtime.home, backup.name);
          return directory !== null && verifyBackup(directory).valid;
        } catch {
          return false;
        }
      });
      if (verifiedBackup) return ['purge', 'all', '--confirm', accept];
      const loss = await rl.question(
        'No verified backup exists. Type NO BACKUP I ACCEPT PERMANENT LOSS: ',
      );
      if (loss !== 'NO BACKUP I ACCEPT PERMANENT LOSS') {
        throw new DomainError('INVALID_INPUT', 'full purge was cancelled');
      }
      return ['purge', 'all', '--confirm', accept, '--accept-no-backup'];
    }
    throw new DomainError('INVALID_INPUT', 'unknown selection');
  } finally {
    rl.close();
  }
}

export function usage(): string {
  return [
    'usage: npm run control -- <command>',
    '  status',
    '  source list | source enable <source_id>',
    '  approval list | approval preview <approval_id>',
    '  approval grant <approval_id> --revision-hash <hash_from_preview>',
    '  approval deny <approval_id> --reason "reason"',
    '  lane list | lane configure read|write --client-id <id> [--expires-in-seconds N]',
    '  lane verify read|write',
    `  feature list | feature enable|disable <${FEATURE_KEYS.join('|')}> --confirm`,
    '  publishing enable|disable --confirm  (alias for live_publishing)',
    '  purge dma --before <ISO>   (prune portability history, keeps the current profile)',
    '  purge dma --confirm "DELETE LINKEDIN PORTABILITY DATA"',
    '  purge all --confirm "DELETE ALL LOCAL DATA" [--accept-no-backup]',
    'Credential configuration prompts with masking. For automation, pipe the token to --token-stdin; never put it in argv.',
  ].join('\n');
}

function printJson(value: unknown, out: NodeJS.WritableStream = stdout): void {
  out.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: ControlIo = processIo,
  errorOut: NodeJS.WritableStream = process.stderr,
  runtime: ControlRuntime = openControlRuntime(),
): Promise<void> {
  try {
    const command = argv.length > 0 ? [...argv] : await interactiveArgs(runtime, io);
    printJson(await runControlCommand(runtime, command), io.output);
  } catch (error) {
    // A DomainError carries a code and blockers the caller can act on; anything
    // else is a bug here, and its message beats a stack trace on a terminal.
    if (error instanceof DomainError) {
      errorOut.write(`${JSON.stringify({ error: error.toResultPayload() }, null, 2)}\n`);
    } else {
      errorOut.write(
        `control CLI failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) void main();
