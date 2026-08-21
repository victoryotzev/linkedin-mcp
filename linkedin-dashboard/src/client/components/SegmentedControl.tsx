/**
 * A group of mutually exclusive in-place filters.
 *
 * Not `ViewNav`: these do not change the route. They swap what one panel is
 * showing, so they are buttons with `aria-pressed`, they stay out of browser
 * history, and they are not copyable as links. When a control should be
 * bookmarkable, it belongs in `ViewNav` instead.
 *
 * This existed twice — the Evidence queue filter and the draft-drawer panels —
 * as byte-identical markup down to the lint-ignore comment above it. Two copies
 * of a keyboard-and-ARIA contract is one copy too many.
 */
export function SegmentedControl<T extends string>(props: {
  /** Names the group for a screen reader. */
  label: string;
  value: T;
  options: ReadonlyArray<{ key: T; label: string }>;
  onChange: (key: T) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset is for form fields, not a button group
    <div class="segmented" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.key}
          type="button"
          class={`btn ${option.key === props.value ? 'btn--secondary' : 'btn--ghost'}`}
          aria-pressed={option.key === props.value ? 'true' : 'false'}
          onClick={() => props.onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
