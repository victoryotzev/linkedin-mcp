import type { Child } from 'hono/jsx/dom';
import { Button } from './Button.tsx';

/**
 * The repeating-record table.
 *
 * Every list in this dashboard — claims, sources, artifacts, audit events,
 * drafts, patches, publications, backups, tools — was a stack of `.card`
 * elements holding rows of label/value pairs. That is a table wearing a card's
 * clothes: it costs a screen-reader user the column headers, it costs everyone
 * the ability to scan down one field, and it costs about a third more vertical
 * space per record. `docs/dashboard-design.md` has described the responsive
 * behaviour of a real table since before there was one.
 *
 * Roles are written out explicitly even though the elements are native. This is
 * the same reason `.rail__nav` carries `role="list"`: below 768px these cells
 * become blocks so the record can stack, and a table whose display is not
 * `table` loses its semantics in the accessibility tree. The roles are redundant
 * at desktop widths and load-bearing at narrow ones.
 */
export interface Column<T> {
  key: string;
  header: string;
  /**
   * Dropped between 768 and 1023px, per the responsive table in
   * docs/dashboard-design.md. Reserve it for what a scan does not need: ids,
   * secondary timestamps, counts that repeat something already shown.
   */
  priority?: 'low';
  /** Numbers, hashes and dates read better trailing; text does not. */
  align?: 'end';
  cell: (row: T) => Child;
}

export function DataTable<T>(props: {
  /** Names the table for a screen reader. Rendered as a visually hidden caption. */
  caption: string;
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Shown instead of the table when there is nothing to list. */
  empty?: Child;
  /**
   * Activating a row. A real button in its own cell, never a click handler on
   * the `<tr>`: a row is not a control, and a keyboard user needs something
   * they can reach and something that says what it does.
   */
  action?: {
    label: string;
    /** The accessible name, which must name the record, not just the verb. */
    describe: (row: T) => string;
    onActivate: (row: T) => void;
    /**
     * Rows the action does not apply to render an empty cell rather than a
     * disabled control: an enabled source has nothing to enable, and offering
     * it greyed out would imply it is merely unavailable right now.
     */
    available?: (row: T) => boolean;
    variant?: 'primary' | 'secondary';
  };
  /** The row currently shown in a detail pane, if any. */
  selectedKey?: string | null;
}) {
  if (props.rows.length === 0 && props.empty !== undefined) return <>{props.empty}</>;

  return (
    <div class="table-wrap">
      {/* biome-ignore lint/a11y/noRedundantRoles: load-bearing once the cells stack below 768px */}
      <table class="table" role="table">
        <caption class="u-visually-hidden">{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                class={`table__th${column.priority === 'low' ? ' table__cell--low' : ''}${
                  column.align === 'end' ? ' table__cell--end' : ''
                }`}
              >
                {column.header}
              </th>
            ))}
            {props.action ? (
              <th scope="col" class="table__th table__th--action">
                <span class="u-visually-hidden">{props.action.label}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const key = props.rowKey(row);
            return (
              <tr
                key={key}
                class="table__row"
                // `aria-current`, not `aria-selected`: selection is only valid
                // ARIA under `grid`/`treegrid`/`listbox`, and claiming one of
                // those roles would owe the user full arrow-key grid
                // navigation this table does not implement. `aria-current` is
                // allowed on any element and says the true thing — this is the
                // row being shown in the detail pane. Same pattern the nav rail
                // uses for the active destination.
                aria-current={props.selectedKey === key ? 'true' : undefined}
              >
                {props.columns.map((column) => (
                  <td
                    key={column.key}
                    // Surfaces the column name beside the value once the row
                    // stacks and the header is no longer above it.
                    data-label={column.header}
                    class={`table__td${column.priority === 'low' ? ' table__cell--low' : ''}${
                      column.align === 'end' ? ' table__cell--end' : ''
                    }`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
                {props.action ? (
                  <td class="table__td table__td--action">
                    {(props.action.available?.(row) ?? true) ? (
                      <Button
                        variant={props.action.variant ?? 'secondary'}
                        onClick={() => props.action?.onActivate(row)}
                        ariaLabel={props.action.describe(row)}
                      >
                        {props.action.label}
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
