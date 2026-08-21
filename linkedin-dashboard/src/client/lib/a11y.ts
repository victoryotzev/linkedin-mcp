import { useEffect, useRef } from 'hono/jsx/dom';

// Open overlays, innermost last.
//
// A drawer can contain a drawer — reviewing a change set and then editing one
// of its patches, for instance — and without this both would install a document
// keydown listener, so one Escape closed both at once and Tab was trapped by
// two containers fighting. Only the innermost overlay responds.
const openOverlays: Array<{ current: HTMLElement | null }> = [];

// Focus management for overlays.
//
// The old dashboard had none of this — no focus styles, no traps, no
// restoration — and every consequential action was a bare inline button. An
// overlay that asks "do you want to permanently reject this claim?" has to be
// reachable, escapable, and has to give focus back where it came from.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Traps Tab inside `container` while `active`, closes on Escape, and returns
 * focus to whatever had it when the overlay opened.
 *
 * `initialFocus` matters for confirmations: the affirmative control must never
 * be the default target, so a stray Enter cannot approve or delete anything.
 */
/**
 * Moves focus into a detail region when the selected record changes.
 *
 * A docked pane is not an overlay: nothing is trapped, Escape does not close
 * the page, and the list stays operable. What it shares with an overlay is the
 * moment of handover — a keyboard or screen-reader user who activates a row has
 * to end up reading the record, not stranded on a row whose pane silently
 * repainted somewhere off to the right.
 *
 * Deliberately not a focus trap. Tab out of the pane and you are back in the
 * list, which is where you want to be to pick the next record.
 */
export function useSelectionFocus(
  heading: { current: HTMLElement | null },
  selectionKey: string | null,
): void {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    // Only on a real change of record, so a re-render caused by the detail
    // loading does not yank focus back out of whatever the user just reached.
    if (selectionKey === null || selectionKey === previous.current) {
      previous.current = selectionKey;
      return;
    }
    previous.current = selectionKey;
    heading.current?.focus();
  }, [selectionKey]);
}

export function useOverlay(
  container: { current: HTMLElement | null },
  active: boolean,
  onDismiss: () => void,
  initialFocus?: { current: HTMLElement | null },
): void {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const element = container.current;
    if (!element) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    (initialFocus?.current ?? focusableWithin(element)[0] ?? element).focus();
    openOverlays.push(container);

    const onKeyDown = (event: KeyboardEvent) => {
      // Only the innermost overlay reacts. Both listeners are attached while a
      // drawer is open inside another one, and without this check Escape would
      // dismiss the pair and Tab would be trapped by whichever ran last.
      if (openOverlays[openOverlays.length - 1] !== container) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableWithin(element);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const index = openOverlays.indexOf(container);
      if (index !== -1) openOverlays.splice(index, 1);
      // Focus goes back where it came from — which, for a nested overlay, is
      // the control inside the parent overlay that opened it.
      restoreTo.current?.focus();
    };
  }, [active]);
}
