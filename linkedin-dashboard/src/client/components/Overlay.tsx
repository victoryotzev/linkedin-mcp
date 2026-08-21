import { useRef, useState, type Child } from 'hono/jsx/dom';
import { useOverlay } from '../lib/a11y.ts';
import { Button } from './Button.tsx';
import { pairClass } from '../styles/pairs.ts';

export interface DialogProps {
  open: boolean;
  title: string;
  onDismiss: () => void;
  children?: Child;
  footer?: Child;
  /** Focus target on open. Confirmations point this at Cancel. */
  initialFocus?: { current: HTMLElement | null };
  labelledBy?: string;
}

export function Dialog(props: DialogProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const titleId = props.labelledBy ?? 'dialog-title';
  useOverlay(container, props.open, props.onDismiss, props.initialFocus);
  if (!props.open) return null;

  return (
    <>
      {/* The backdrop is a redundant mouse affordance. The keyboard path out
          of a modal is Escape, handled once in useOverlay (lib/a11y.ts) and
          asserted by tests; making this div focusable would put a silent
          no-op in the tab order, which is worse than the warning. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, via useOverlay */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: redundant mouse affordance only */}
      <div class="overlay-backdrop" onClick={props.onDismiss} />
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={container}>
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
        <div class="dialog__actions">{props.footer}</div>
      </div>
    </>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What will happen, in a sentence. Not "Are you sure?". */
  consequence: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  destructive?: boolean;
  /** When set, the user must type this exact string. Reserved for the unrecoverable. */
  requiredPhrase?: string;
  children?: Child;
}

/**
 * Confirmation for anything irreversible.
 *
 * Two deliberate details. The affirmative control is never the initial focus —
 * focus goes to Cancel — so a stray Enter on a freshly-opened dialog cannot
 * approve a publication or reject a claim. And the consequence is stated as a
 * fact about what will happen, because "Are you sure?" tells the reader nothing
 * they did not already know.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [phrase, setPhrase] = useState('');
  const phraseOk = props.requiredPhrase === undefined || phrase === props.requiredPhrase;

  return (
    <Dialog
      open={props.open}
      title={props.title}
      onDismiss={props.onCancel}
      initialFocus={cancelRef}
      footer={
        <>
          <Button variant="secondary" onClick={props.onCancel} ref={cancelRef}>
            Cancel
          </Button>
          <Button
            variant={props.destructive === true ? 'danger' : 'primary'}
            onClick={props.onConfirm}
            pending={props.pending === true}
            disabled={!phraseOk}
            disabledReason={
              phraseOk ? undefined : `Type ${props.requiredPhrase} exactly to enable this.`
            }
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <p class={`dialog__consequence ${pairClass('text-muted/surface-3')}`}>{props.consequence}</p>
      {props.children}
      {props.requiredPhrase !== undefined ? (
        <label class="field">
          <span class="field__label">
            Type <code>{props.requiredPhrase}</code> to confirm
          </span>
          <input
            class="field__control"
            value={phrase}
            autocomplete="off"
            onInput={(event: Event) => setPhrase((event.target as HTMLInputElement).value)}
          />
        </label>
      ) : null}
    </Dialog>
  );
}

export function Drawer(props: {
  open: boolean;
  title: string;
  onDismiss: () => void;
  children?: Child;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  useOverlay(container, props.open, props.onDismiss);
  if (!props.open) return null;

  return (
    <>
      {/* The backdrop is a redundant mouse affordance. The keyboard path out
          of a modal is Escape, handled once in useOverlay (lib/a11y.ts) and
          asserted by tests; making this div focusable would put a silent
          no-op in the tab order, which is worse than the warning. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, via useOverlay */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: redundant mouse affordance only */}
      <div class="overlay-backdrop" onClick={props.onDismiss} />
      {/* A div, not an <aside>: <aside> is implicitly `complementary`, and
          overriding that with role="dialog" is invalid ARIA. A modal drawer is
          a dialog — axe caught this. */}
      <div
        class="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        ref={container}
      >
        <div class="row row--between">
          <h2 id="drawer-title">{props.title}</h2>
          <Button variant="ghost" onClick={props.onDismiss}>
            Close
          </Button>
        </div>
        {props.children}
      </div>
    </>
  );
}
