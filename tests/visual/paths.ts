import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything the visual suite writes lives outside the repository: a scratch
// home for the seeded database and artifact store, and the stored session.

export const VISUAL_HOME = join(tmpdir(), 'linkedin-mcp-visual');
export const STORAGE_STATE = join(VISUAL_HOME, 'storage-state.json');
export const VISUAL_PORT = 4790;
export const BASE_URL = `http://127.0.0.1:${VISUAL_PORT}`;
