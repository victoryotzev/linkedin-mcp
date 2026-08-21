import type { Child } from 'hono/jsx/dom';
import { InlineError, LoadingRows } from './Feedback.tsx';
import { Button } from './Button.tsx';
import { routeToHash, type Destination } from '../lib/router.ts';
import type { Resource } from '../lib/store.ts';
import { pairClass } from '../styles/pairs.ts';

/**
 * Sub-navigation within a destination.
 *
 * Links, not `role="tab"`. These change the route: they belong in browser
 * history, they should be copyable and middle-clickable, and a real tab pattern
 * would owe the user `aria-controls`, a `tabpanel`, and arrow-key movement —
 * none of which was there. Calling them tabs was simply the wrong word.
 */
export function ViewNav<T extends string>(props: {
  label: string;
  destination: Destination;
  current: T;
  views: ReadonlyArray<{ key: T; label: string }>;
}) {
  return (
    <nav class="viewnav" aria-label={props.label}>
      {props.views.map((view) => (
        <a
          key={view.key}
          class="viewnav__link"
          href={routeToHash({ destination: props.destination, view: view.key })}
          aria-current={view.key === props.current ? 'page' : undefined}
        >
          {view.label}
        </a>
      ))}
    </nav>
  );
}

// Renders the three states of a read explicitly. Every screen goes through it,
// so none of them can quietly show an empty region while a fetch is in flight —
// which is what the old dashboard did on every navigation.

export function Section(props: {
  title: string;
  hint?: string;
  actions?: Child;
  /** Nested sections must not repeat h2 — the document outline is not decorative. */
  level?: 2 | 3;
  /**
   * Keeps the heading for the document outline but takes it off the screen.
   *
   * When a `ViewNav` tab already names the view, printing the same words again
   * as a slug directly beneath it names one place three times — destination,
   * tab, section. The outline still needs the h2; the reader does not.
   */
  titleHidden?: boolean;
  children?: Child;
}) {
  const Heading = props.level === 3 ? 'h3' : 'h2';
  return (
    <section class="stack stack--tight">
      <div class="row row--between">
        <div class="stack stack--tight">
          <Heading class={props.titleHidden ? 'u-visually-hidden' : 'section__title'}>
            {props.title}
          </Heading>
          {props.hint !== undefined ? (
            <p class={`section__hint ${pairClass('text-muted/bg')}`}>{props.hint}</p>
          ) : null}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

export function ResourceView<T>(props: {
  resource: Resource<T>;
  reload?: () => void;
  label: string;
  children: (data: T) => Child;
}) {
  if (props.resource.status === 'loading') {
    return <LoadingRows label={`Loading ${props.label}`} />;
  }
  if (props.resource.status === 'error') {
    return (
      <InlineError error={props.resource.error}>
        {props.reload ? (
          <div class="row">
            <Button variant="secondary" onClick={props.reload}>
              Try again
            </Button>
          </div>
        ) : null}
      </InlineError>
    );
  }
  return <>{props.children(props.resource.data)}</>;
}
