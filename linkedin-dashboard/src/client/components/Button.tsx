import type { Child } from 'hono/jsx/dom';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  children?: Child;
  variant?: ButtonVariant;
  /** In flight. Disables the control, so a second submit is not possible. */
  pending?: boolean;
  disabled?: boolean;
  /** Shown as the accessible reason when disabled, instead of leaving the user guessing. */
  disabledReason?: string;
  type?: 'button' | 'submit';
  /**
   * Distinguishes controls that share one visible label — a table of "Review"
   * buttons owes each row a name that says which record it acts on.
   *
   * WCAG 2.5.3 (Label in Name): this replaces the accessible name entirely, so
   * it must still contain the visible text. "Review claim: Managed team of 12"
   * is correct; "Open Managed team of 12" is not, because the button reads
   * "Review".
   */
  ariaLabel?: string;
  onClick?: (event: MouseEvent) => void;
  ref?: { current: HTMLButtonElement | null };
}

/**
 * The `pending` state is a correctness feature, not a nicety: the old dashboard
 * had no in-flight state at all, so a double-click on "Approve exactly this
 * text" fired two grants. Disabling while a request is outstanding makes that
 * impossible in the UI, on top of the server's own single-use guarantee.
 */
export function Button(props: ButtonProps) {
  const variant = props.variant ?? 'secondary';
  const disabled = props.disabled === true || props.pending === true;
  return (
    <button
      type={props.type ?? 'button'}
      class={`btn btn--${variant}`}
      disabled={disabled}
      aria-busy={props.pending === true ? 'true' : undefined}
      aria-disabled={disabled ? 'true' : undefined}
      aria-label={props.ariaLabel}
      title={disabled ? props.disabledReason : undefined}
      onClick={props.onClick}
      ref={props.ref}
    >
      {props.pending === true ? <span class="btn__spinner" aria-hidden="true" /> : null}
      {props.children}
    </button>
  );
}
