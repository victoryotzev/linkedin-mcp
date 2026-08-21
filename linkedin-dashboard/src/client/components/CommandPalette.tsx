import { useEffect, useRef, useState } from 'hono/jsx/dom';
import { useOverlay } from '../lib/a11y.ts';
import type { PaletteRegistry } from '../lib/commands.ts';
import { KeyHint } from './Facts.tsx';

// Jump-to and safe actions, on Ctrl/Cmd-K.
//
// Navigation and reversible actions only. Nothing that approves, publishes,
// deletes, rejects or stores a credential appears here — a fuzzy keyboard
// search is the wrong way to reach an irreversible decision, and the registry
// refuses such an id outright (see lib/commands.ts).

export function CommandPalette(props: { palette: PaletteRegistry }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const container = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setIndex(0);
        setOpen((wasOpen) => !wasOpen);
      }
    };
    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, []);

  useOverlay(container, open, () => setOpen(false), input);

  if (!open) return null;
  const results = props.palette.search(query);
  const active = results[Math.min(index, results.length - 1)];

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      setOpen(false);
      active.run();
    }
  };

  return (
    <>
      {/* The backdrop is a redundant mouse affordance. The keyboard path out
          of a modal is Escape, handled once in useOverlay (lib/a11y.ts) and
          asserted by tests; making this div focusable would put a silent
          no-op in the tab order, which is worse than the warning. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: redundant mouse affordance only */}
      <div class="overlay-backdrop" onClick={() => setOpen(false)} />
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={container}
      >
        <input
          ref={input}
          class="palette__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-label="Search commands"
          placeholder="Jump to…"
          value={query}
          autocomplete="off"
          onInput={(event: Event) => {
            setQuery((event.target as HTMLInputElement).value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        {/* ul[role=listbox] + li[role=option] is the ARIA listbox pattern. The
            options are intentionally not focusable: the input keeps focus and
            aria-activedescendant moves the selection, which is why arrow keys
            and Enter are handled on the input rather than per option. */}
        <ul class="palette__list" id="palette-list" role="listbox" aria-label="Commands">
          {results.map((command, position) => (
            <li
              key={command.id}
              class="palette__item"
              role="option"
              aria-selected={command.id === active?.id ? 'true' : 'false'}
              onClick={() => {
                setOpen(false);
                command.run();
              }}
              onMouseEnter={() => setIndex(position)}
            >
              <span>{command.label}</span>
              {command.hint !== undefined ? <span class="rail__count">{command.hint}</span> : null}
            </li>
          ))}
          {results.length === 0 ? (
            <li class="palette__item" aria-disabled="true">
              No matching command
            </li>
          ) : null}
        </ul>
        <p class="palette__hint">
          <KeyHint keys="↑↓" /> move · <KeyHint keys="Enter" /> run · <KeyHint keys="Esc" /> close.
          Irreversible actions are not listed here.
        </p>
      </div>
    </>
  );
}
