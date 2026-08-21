import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './adapters/sdkV2.ts';
import { bootstrap } from './bootstrap.ts';
import { toolDefs } from './catalog.ts';
import { logError } from './log.ts';
import { PROMPT_DEFS } from './prompts.ts';
import { resourceDefs } from './resources.ts';

process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
  process.exit(1);
});

const ctx = bootstrap();
const TOOLS = toolDefs(ctx);

serveStdio(() => buildServer(TOOLS, resourceDefs(ctx), PROMPT_DEFS));
