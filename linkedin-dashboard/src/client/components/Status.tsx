import { pairClass, type PairKey } from '../styles/pairs.ts';

// Status presentation.
//
// Two rules, both non-negotiable. Colour is never the only carrier (WCAG
// 1.4.1), so every chip renders a glyph and a word. And the word is the
// domain's own: `configured` is never displayed as "verified", because the
// difference between a token that exists and a token that has been proved
// against LinkedIn is the whole point of the capability model.

export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

const GLYPH: Record<StatusTone, string> = {
  ok: '●',
  warn: '◐',
  danger: '▲',
  neutral: '○',
  accent: '◆',
};

/**
 * Chips appear on every surface — panels, hovered rows, dialogs, selected rows
 * — so the declared background has to be the one they are actually checked
 * against, not a convenient stand-in. Naming `surface-1` everywhere emitted the
 * right class by luck while asserting a pair that was not the one in use, which
 * quietly hollowed out the point of the matrix.
 */
export type ChipSurface = 'surface-1' | 'surface-2' | 'surface-3' | 'accent-wash';

const TONE_PAIR: Record<ChipSurface, Record<StatusTone, PairKey>> = {
  'surface-1': {
    ok: 'ok/surface-1',
    warn: 'warn/surface-1',
    danger: 'danger/surface-1',
    neutral: 'text-muted/surface-1',
    accent: 'accent/surface-1',
  },
  'surface-2': {
    ok: 'ok/surface-2',
    warn: 'warn/surface-2',
    danger: 'danger/surface-2',
    neutral: 'text-muted/surface-2',
    accent: 'accent/surface-2',
  },
  'surface-3': {
    ok: 'ok/surface-3',
    warn: 'warn/surface-3',
    danger: 'danger/surface-3',
    neutral: 'text-muted/surface-3',
    accent: 'accent/surface-3',
  },
  'accent-wash': {
    ok: 'ok/accent-wash',
    warn: 'warn/accent-wash',
    danger: 'danger/accent-wash',
    neutral: 'text-muted/accent-wash',
    accent: 'accent/accent-wash',
  },
};

/** Maps every domain state this dashboard can display onto a tone. */
export const STATUS_TONES: Record<string, StatusTone> = {
  // claims
  verified: 'ok',
  candidate: 'warn',
  ambiguous: 'warn',
  expired: 'warn',
  rejected: 'neutral',
  // sources
  enabled: 'ok',
  pending_review: 'warn',
  disabled: 'neutral',
  archived: 'neutral',
  // capabilities
  configured: 'warn',
  unavailable: 'neutral',
  revoked: 'danger',
  blocked: 'danger',
  // approvals
  pending: 'warn',
  granted: 'accent',
  consumed: 'neutral',
  invalidated: 'neutral',
  denied: 'neutral',
  // publications
  succeeded: 'ok',
  failed: 'danger',
  reconciled_success: 'ok',
  reconciled_failed: 'neutral',
  // conflicts
  open: 'danger',
  resolved: 'ok',
  dismissed: 'neutral',
  // patches
  proposed: 'warn',
  approved: 'accent',
  applied: 'ok',
  superseded: 'neutral',
};

export function toneFor(state: string): StatusTone {
  return STATUS_TONES[state] ?? 'neutral';
}

export interface StatusChipProps {
  state: string;
  /** Overrides the label when the raw state is not the clearest wording. */
  label?: string;
  tone?: StatusTone;
  /** The surface this chip sits on, so contrast is asserted for the real pair. */
  on?: ChipSurface;
}

export function StatusChip(props: StatusChipProps) {
  const tone = props.tone ?? toneFor(props.state);
  const surface = props.on ?? 'surface-1';
  return (
    <span
      class={`chip ${pairClass(TONE_PAIR[surface][tone])}`}
      data-state={props.state}
      data-tone={tone}
    >
      <span class="chip__glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      {props.label ?? props.state}
    </span>
  );
}

/**
 * A sentence that carries a tone.
 *
 * A chip is a short state — `verified`, `ambiguous`, `armed` — and its pill
 * shape is what makes it read as one. Wrapping a whole sentence in that shape
 * ("A publication is waiting for your approval") produces a badge the width of
 * the column and says nothing a plain line would not. The glyph still carries
 * the meaning without colour, which is the rule that actually matters.
 */
export function ToneText(props: { tone: StatusTone; children: string; on?: ChipSurface }) {
  const surface = props.on ?? 'surface-1';
  return (
    <span class={`tone-text ${pairClass(TONE_PAIR[surface][props.tone])}`}>
      <span class="chip__glyph" aria-hidden="true">
        {GLYPH[props.tone]}
      </span>
      {props.children}
    </span>
  );
}

/**
 * A label that carries no state.
 *
 * Capability blockers, tool permission tiers, feature keys and hashtags were all
 * rendering as a bare `<span class="chip">`, which looks like a `StatusChip` and
 * is not one: no tone, no glyph, and no declared colour pair. Giving them their
 * own component keeps the status vocabulary meaning what it says — a chip with a
 * glyph is a domain state, a tag is just a word.
 */
export function Tag(props: { children: string; on?: ChipSurface }) {
  const surface = props.on ?? 'surface-1';
  return (
    <span class={`chip chip--tag ${pairClass(TONE_PAIR[surface].neutral)}`}>{props.children}</span>
  );
}

export type Actor = 'dashboard' | 'mcp_host' | 'human_cli' | 'system';

const ACTORS = ['dashboard', 'mcp_host', 'human_cli', 'system'] as const;

const ACTOR_LABEL: Record<Actor, string> = {
  dashboard: 'You',
  mcp_host: 'Model',
  // Still you, through the control CLI rather than this dashboard. Labelling it
  // "CLI" alone would drop the half that matters: the domain records this actor
  // precisely because a human, not the model, took the action.
  human_cli: 'You (CLI)',
  system: 'System',
};

/**
 * Who did this. The product's central promise is that a human, not the model,
 * makes the consequential decisions — so every audited action says which it
 * was, in plain words rather than in a table name.
 */
export function ActorBadge(props: { actor: string }) {
  const known = ACTORS.find((a) => a === props.actor);
  return <span class="actor">{known ? ACTOR_LABEL[known] : props.actor}</span>;
}
