// The actions that cannot be undone, named in one place.
//
// This list exists to be excluded. The command palette is a fast, fuzzy,
// keyboard-driven way to reach things — which is exactly what a publication
// approval must not be. Granting is the one irreversible, outward-facing,
// model-inaccessible decision in the system, and it is only ever reachable from
// the approval detail with the byte-exact preview on screen.
//
// A test asserts this set and the palette registry are disjoint.

export const DESTRUCTIVE_ACTION_IDS = [
  'approval.grant',
  'approval.deny',
  'claim.reject',
  'conflict.resolve',
  'conflict.dismiss',
  'patch.reject',
  'publication.reconcile',
  'capability.enable-publishing',
  'lane.store-token',
  'source.enable',
  'artifact.purge',
  'data.purge-all',
] as const;

export type DestructiveActionId = (typeof DESTRUCTIVE_ACTION_IDS)[number];

const DESTRUCTIVE = new Set<string>(DESTRUCTIVE_ACTION_IDS);

export function isDestructive(actionId: string): boolean {
  return DESTRUCTIVE.has(actionId);
}
