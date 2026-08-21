import { useRef, type Child } from 'hono/jsx/dom';
import { Button } from './Button.tsx';
import { Drawer } from './Overlay.tsx';
import { useSelectionFocus } from '../lib/a11y.ts';
import { SPLIT_COLLAPSE, useMediaQuery } from '../lib/viewport.ts';

/**
 * A dense list beside the record it is about.
 *
 * Reviewing is a loop — read a record, decide, move to the next — and the old
 * shape made every turn of that loop a modal drawer over the list, so the queue
 * you were working through disappeared exactly while you needed to know how
 * much of it was left. Here the list keeps its place, its scroll position and
 * its selection, and only the right-hand pane changes.
 *
 * Below `SPLIT_COLLAPSE` there is not room for both, and the detail becomes a
 * `Drawer` — the same overlay this app already had, with the focus trap and the
 * Escape handling it already had. Narrow viewports therefore behave exactly as
 * they did before this component existed, which is also why they are already
 * tested.
 *
 * What this is not: a place to make a consequential decision without a
 * confirmation. Granting an approval, purging data and every other irreversible
 * action still opens a real modal dialog from inside the pane. A non-modal
 * surface must never be the last thing between a user and something they cannot
 * undo.
 */
export function SplitView(props: {
  /** The dense list. Stays mounted and keeps its scroll position. */
  list: Child;
  /** The selected record's detail, or null when nothing is selected. */
  detail: Child | null;
  /** Names the detail region, and titles the drawer when collapsed. */
  detailTitle: string;
  /** Identifies the selected record, so focus moves only on a real change. */
  selectionKey: string | null;
  onCloseDetail: () => void;
}) {
  const collapsed = useMediaQuery(SPLIT_COLLAPSE);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useSelectionFocus(heading, collapsed ? null : props.selectionKey);

  if (collapsed) {
    return (
      <>
        {props.list}
        <Drawer
          open={props.selectionKey !== null && props.detail !== null}
          title={props.detailTitle}
          onDismiss={props.onCloseDetail}
        >
          {props.detail}
        </Drawer>
      </>
    );
  }

  const open = props.selectionKey !== null && props.detail !== null;

  // With nothing selected there is no margin, and the list takes the whole
  // sheet. A permanently reserved half-width column holding one line of "select
  // something" spends the most valuable space on the page saying nothing — and
  // the wider the list, the more of its columns survive the container query.
  // The margin appears because you asked a record a question.
  if (!open) {
    return <div class="split split--closed">{props.list}</div>;
  }

  return (
    <div class="split">
      <div class="pane pane--list">{props.list}</div>
      {/* A <section> with an accessible name is already a region landmark, so a
          screen-reader user can jump straight to the record. Spelling the role
          out on a div would be the same semantics with more markup. */}
      <section class="pane pane--detail" aria-label={props.detailTitle}>
        <div class="row row--between pane__head">
          {/* tabindex -1 so it can receive focus on selection without joining
              the tab order as a stop of its own. */}
          <h2 tabindex={-1} ref={heading}>
            {props.detailTitle}
          </h2>
          <Button variant="ghost" onClick={props.onCloseDetail}>
            Close
          </Button>
        </div>
        {props.detail}
      </section>
    </div>
  );
}
