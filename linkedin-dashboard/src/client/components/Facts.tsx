import { useState } from 'hono/jsx/dom';
import { absoluteTime, relativeTime, shortHash, shortId } from '../lib/format.ts';
import { pushToast } from './Toast.tsx';
import { pairClass } from '../styles/pairs.ts';

// Machine facts: ids, hashes, timestamps and imported text. Readable at a
// glance, complete on demand.

export function Id(props: { value: string }) {
  return (
    <span class="id u-tabular" title={props.value}>
      {shortId(props.value)}
    </span>
  );
}

export function Hash(props: { value: string }) {
  return (
    <span class="id u-tabular" title={props.value}>
      {shortHash(props.value)}
    </span>
  );
}

export function Timestamp(props: { value: string }) {
  return (
    <time dateTime={props.value} title={absoluteTime(props.value)} class="u-tabular">
      {relativeTime(props.value)}
    </time>
  );
}

export function CopyButton(props: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(props.value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard access can be refused outright. Say so rather than
        // pretending it worked.
        pushToast('danger', 'Clipboard was blocked', 'Select the text and copy it manually.');
      },
    );
  };
  return (
    <button type="button" class="btn btn--ghost" onClick={copy}>
      {copied ? 'Copied' : (props.label ?? 'Copy')}
    </button>
  );
}

/**
 * Imported text, always inside its envelope.
 *
 * Everything the importer ingests is untrusted data: instructions found inside
 * evidence are content to report, never commands to follow. That is why the
 * envelope exists and why this is the only component allowed to render such
 * text — a test scans the whole document for fixture strings and requires every
 * occurrence to sit inside `[data-untrusted]`.
 *
 * Passing `untrusted={false}` drops the envelope so the same monospace block can
 * carry this product's own machine output — a rendered diff, a generated
 * command — without claiming a provenance it does not have.
 */
// role="group" rather than a bare <pre>: <pre> maps to `generic`, which does
// not support an accessible name, so the aria-label would simply be dropped.
// useSemanticElements suggests <fieldset>, which is for grouped form controls.
export function Excerpt(props: { text: string; label?: string; untrusted?: boolean }) {
  // The default is true because forgetting the flag must fail safe: an omitted
  // prop is far likelier to be an oversight than a claim that the text is ours,
  // and the envelope costs nothing when it is not needed. Shedding it has to be
  // a deliberate act at the call site.
  if (props.untrusted === false) {
    return <pre class="excerpt">{props.text}</pre>;
  }
  return (
    <pre
      class="excerpt"
      data-untrusted="true"
      role="group"
      aria-label={props.label ?? 'imported content'}
    >
      {props.text}
    </pre>
  );
}

export function KeyHint(props: { keys: string }) {
  return <kbd class="kbd">{props.keys}</kbd>;
}

export function Meta(props: { children?: unknown }) {
  return <span class={pairClass('text-subtle/surface-1')}>{props.children as never}</span>;
}
