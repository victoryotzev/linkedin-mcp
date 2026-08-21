import { useSyncExternalStore } from 'hono/jsx/dom';
import { pairClass } from '../styles/pairs.ts';

// Mutation feedback that assistive technology can actually hear.
//
// The old dashboard wrote every success and every failure into one 12px <span>
// in the header corner, with no role, no live region and no clearing — so a
// screen-reader user got nothing at all, and a sighted user on a wide display
// routinely missed it. Success announces politely; failure asserts and stays
// until dismissed, because an error the user walks away from is an error they
// will act on wrongly.

export type ToastTone = 'ok' | 'danger';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string;
}

const SUCCESS_TIMEOUT_MS = 6000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function pushToast(tone: ToastTone, message: string, detail?: string): number {
  const id = nextId++;
  toasts = [...toasts, { id, tone, message, ...(detail !== undefined ? { detail } : {}) }];
  emit();
  // Failures are never auto-dismissed: they describe something the user still
  // has to deal with.
  if (tone === 'ok') setTimeout(() => dismissToast(id), SUCCESS_TIMEOUT_MS);
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function clearToasts(): void {
  toasts = [];
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function Toaster() {
  const current = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );

  return (
    <div class="toaster">
      {/* Two regions, because politeness differs: a success should not interrupt,
          a failure should. */}
      <div role="status" aria-live="polite" class="u-visually-hidden">
        {current
          .filter((toast) => toast.tone === 'ok')
          .map((toast) => toast.message)
          .join('. ')}
      </div>
      <div role="alert" aria-live="assertive" class="u-visually-hidden">
        {current
          .filter((toast) => toast.tone === 'danger')
          .map((toast) => toast.message)
          .join('. ')}
      </div>

      {current.map((toast) => (
        <div class={`toast toast--${toast.tone}`} key={toast.id}>
          {/* The tone as a mark rather than as a stripe down the edge, matching
              the chips and callouts. Meaning survives with colour removed. */}
          <span class="toast__glyph" aria-hidden="true">
            {toast.tone === 'ok' ? '●' : '▲'}
          </span>
          <div class="toast__body">
            <p>{toast.message}</p>
            {toast.detail !== undefined ? (
              <p class={pairClass('text-muted/surface-3')}>{toast.detail}</p>
            ) : null}
          </div>
          <button type="button" class="btn btn--ghost" onClick={() => dismissToast(toast.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
