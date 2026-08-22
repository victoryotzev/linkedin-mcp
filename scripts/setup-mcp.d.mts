// Types for setup-mcp.mjs.
//
// The dispatcher stays plain ESM — it is what `npm run setup:mcp` executes, and
// putting a TypeScript loader in front of the one command a new contributor
// runs first would be a poor trade. Its two exports are still typed, because
// the test imports them.

export interface SetupPlan {
  action: 'run-powershell' | 'explain';
  /** Present only for `run-powershell`. */
  script?: string;
  /** Present only for `explain`. */
  platform?: string;
}

export declare function planSetup(platform?: string): SetupPlan;
export declare function manualSetupNote(platform?: string): string;
