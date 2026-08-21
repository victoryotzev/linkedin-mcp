import type { Child } from 'hono/jsx/dom';
import type { ApiError } from '../lib/api.ts';
import { pairClass } from '../styles/pairs.ts';

export type CalloutTone = 'danger' | 'warn' | 'ok' | 'info';

/**
 * The tone glyph, matching the status vocabulary in Status.tsx.
 *
 * A callout used to carry its tone as a 3px coloured stripe down its left edge.
 * That stripe is decoration doing a job a mark can do better: it says nothing
 * without colour, it is the single most recognisable tell of a generated
 * interface, and it forced a heavier border on one side of every panel in the
 * product. The glyph carries the same meaning, survives forced-colors, and
 * matches what a chip beside it is already using for the same tone.
 */
const CALLOUT_GLYPH: Record<CalloutTone, string> = {
  danger: '▲',
  warn: '◐',
  ok: '●',
  info: '◆',
};

export function Callout(props: { tone: CalloutTone; title: string; children?: Child }) {
  return (
    <div
      class={`callout callout--${props.tone}`}
      role={props.tone === 'danger' ? 'alert' : undefined}
    >
      <p class="callout__title">
        <span class="callout__glyph" aria-hidden="true">
          {CALLOUT_GLYPH[props.tone]}
        </span>
        {props.title}
      </p>
      {props.children}
    </div>
  );
}

/**
 * The full error, not just its message.
 *
 * `DomainError.toResultPayload()` carries a machine-readable code, the exact
 * blockers that stopped the operation, and whether retrying is worth it. The
 * old client discarded all of it and showed the message alone in a 12px string
 * in the header corner — which is how a member could press "Enable publishing",
 * have it refused for a specific, fixable reason, and never find out what it
 * was.
 */
export function InlineError(props: { error: ApiError; children?: Child }) {
  return (
    <div class="callout callout--danger" role="alert">
      <p class="callout__title">
        <span class="callout__glyph" aria-hidden="true">
          {CALLOUT_GLYPH.danger}
        </span>
        {props.error.message}
      </p>
      <div class="error-detail">
        <span class="error-detail__code">{props.error.code}</span>
        {props.error.blockers.length > 0 ? (
          <span class={pairClass('text-muted/surface-2')}>
            blockers: {props.error.blockers.join(', ')}
          </span>
        ) : null}
        {props.error.retryable ? (
          <span class={pairClass('text-muted/surface-2')}>this one is worth retrying</span>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

export function EmptyState(props: { title: string; children?: Child }) {
  return (
    <div class="empty">
      <p class={pairClass('text/surface-1')}>
        <strong>{props.title}</strong>
      </p>
      {props.children}
    </div>
  );
}

/** Occupies the final dimensions, so nothing shifts when the data lands. */
export function Skeleton(props: { height?: number; width?: string }) {
  return (
    <div
      class="skeleton"
      aria-hidden="true"
      style={`height:${props.height ?? 16}px;width:${props.width ?? '100%'}`}
    />
  );
}

export function LoadingRows(props: { rows?: number; label: string }) {
  const rows = props.rows ?? 4;
  return (
    <div class="stack stack--tight" role="status" aria-busy="true" aria-label={props.label}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={32} />
      ))}
    </div>
  );
}
