import type { Child } from 'hono/jsx/dom';
import { Button } from './Button.tsx';
import { Callout } from './Feedback.tsx';
import { Drawer } from './Overlay.tsx';
import { pairClass } from '../styles/pairs.ts';

/**
 * Editing a body of text whose edit costs something.
 *
 * Both places this exists are the same shape: a drawer opened over the drawer
 * you were already reading in, a warning that names what the save destroys
 * (a draft edit invalidates its live approval; a patch edit re-derives its
 * citations and drops it back to proposed), the text itself, a character count,
 * and a save that is never the resting focus.
 *
 * The nesting is the point and is why this is a `Drawer` rather than a form in
 * place: the record underneath stays on screen while you edit, so the thing you
 * are about to invalidate is still visible. `useOverlay` in lib/a11y.ts stacks
 * the two so Escape closes only this one.
 */
export function EditWithConsequence(props: {
  open: boolean;
  /** Drawer title, e.g. `Edit draft body`. */
  title: string;
  /** Names the consequence, not the action: "This creates a new revision". */
  consequenceTitle: string;
  /** Says what is lost, in the domain's own terms. */
  consequence: Child;
  fieldLabel: string;
  value: string;
  onInput: (value: string) => void;
  rows?: number;
  /** Shown as `n / limit` when the field has a hard ceiling. */
  charLimit?: number | null;
  saveLabel: string;
  pending?: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!props.open) return null;
  return (
    <Drawer open title={props.title} onDismiss={props.onCancel}>
      <Callout tone="warn" title={props.consequenceTitle}>
        <p class={pairClass('text-muted/surface-3')}>{props.consequence}</p>
      </Callout>
      <label class="field">
        <span class="field__label">{props.fieldLabel}</span>
        <textarea
          class="field__control"
          rows={props.rows ?? 12}
          value={props.value}
          onInput={(event: Event) => props.onInput((event.target as HTMLTextAreaElement).value)}
        />
      </label>
      <p class={pairClass('text-subtle/surface-3')}>
        <span class="u-tabular">{props.value.length}</span>
        {props.charLimit ? ` / ${props.charLimit}` : ''} characters
      </p>
      <div class="row">
        <Button variant="primary" pending={props.pending} onClick={props.onSave}>
          {props.saveLabel}
        </Button>
        <Button variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </Drawer>
  );
}
