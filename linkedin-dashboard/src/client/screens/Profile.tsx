import { useState } from 'hono/jsx/dom';
import { Button } from '../components/Button.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { Callout, EmptyState, InlineError } from '../components/Feedback.tsx';
import { CopyButton, Id, Timestamp } from '../components/Facts.tsx';
import { ConfirmDialog } from '../components/Overlay.tsx';
import { ResourceView, Section, ViewNav } from '../components/Screen.tsx';
import { EditWithConsequence } from '../components/EditWithConsequence.tsx';
import { SplitView } from '../components/SplitView.tsx';
import { StatusChip } from '../components/Status.tsx';
import { pushToast } from '../components/Toast.tsx';
import { useRoute } from '../lib/router.ts';
import { useMutation, useResource } from '../lib/store.ts';
import type {
  CanonicalRevision,
  ChangeSetSummary,
  ExportBundleEntry,
  FieldPatch,
  ScoreFinding,
} from '../lib/types.ts';
import { pairClass } from '../styles/pairs.ts';

// LinkedIn has no profile-edit API. Every profile change is exact text a human
// pastes by hand, and the next snapshot import confirms it landed. That makes
// the export bundle below the actual apply step — and it was reachable only
// from MCP before, which put the doing of the work outside the surface built
// for the person doing it.

const VIEWS = ['sections', 'diff', 'changesets', 'snapshots'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  sections: 'Canonical sections',
  diff: 'Diff vs LinkedIn',
  changesets: 'Change sets',
  snapshots: 'Snapshots & score',
};

// Sections that map to a real LinkedIn field. The rest are internal working
// notes with nowhere to paste them, and the old screen listed all nine
// together as though they were the same kind of thing.
const LINKEDIN_FIELDS = new Set(['headline', 'about', 'experience', 'education', 'skills']);

function PatchCard(props: { patch: FieldPatch; onChanged: () => void }) {
  const { patch } = props;
  const [confirming, setConfirming] = useState<'accept' | 'reject' | 'applied' | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(patch.new_text);
  const [note, setNote] = useState('');
  const mutation = useMutation();

  const act = async (action: string, body: Record<string, unknown> = {}) => {
    const path =
      action === 'applied' ? `/patches/${patch.id}/applied` : `/patches/${patch.id}/review`;
    const result = await mutation.run(path, action === 'applied' ? {} : { action, ...body });
    if (result !== null) {
      setConfirming(null);
      setEditing(false);
      pushToast('ok', `Patch ${action === 'applied' ? 'marked applied' : action}ed`);
      props.onChanged();
    }
  };

  return (
    <div class="card stack stack--tight">
      <div class="row row--between">
        <span class="row">
          <strong>{patch.field_key}</strong>
          <StatusChip state={patch.state} />
          {patch.kind === 'required_fix' ? <StatusChip state="required" tone="warn" /> : null}
        </span>
        <span class={pairClass('text-subtle/surface-1')}>
          <span class="u-tabular">{patch.char_count}</span>
          {patch.char_limit ? `/${patch.char_limit}` : ''} chars
        </span>
      </div>

      {!patch.char_limit_ok ? (
        <Callout tone="danger" title="Over the configured character limit">
          <p class={pairClass('text-muted/surface-1')}>{patch.risk_note}</p>
        </Callout>
      ) : null}

      {patch.applied_verified_snapshot_id ? (
        <p class={pairClass('ok/surface-1')}>Confirmed live in a later snapshot.</p>
      ) : null}

      <pre class="excerpt">{patch.new_text}</pre>

      {patch.rationale ? <p class={pairClass('text-muted/surface-1')}>{patch.rationale}</p> : null}
      <p class={pairClass('text-subtle/surface-1')}>
        cites {patch.claim_ids.length} verified claim{patch.claim_ids.length === 1 ? '' : 's'}
      </p>

      {mutation.error ? <InlineError error={mutation.error} /> : null}

      <div class="row">
        <CopyButton value={patch.new_text} label="Copy exact text" />
        {patch.state === 'proposed' ? (
          <>
            <Button variant="primary" onClick={() => setConfirming('accept')}>
              Accept
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="danger" onClick={() => setConfirming('reject')}>
              Reject
            </Button>
          </>
        ) : null}
        {patch.state === 'approved' ? (
          <Button variant="secondary" onClick={() => setConfirming('applied')}>
            Mark applied
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming === 'accept'}
        title="Accept this patch"
        consequence="Every cited claim is re-checked as verified at this moment. A claim rejected since the patch was generated blocks it."
        confirmLabel="Accept"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('accept')}
      />

      <ConfirmDialog
        open={confirming === 'reject'}
        title="Reject this patch"
        consequence="The patch is closed. The canonical section it came from is unchanged."
        confirmLabel="Reject patch"
        destructive
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('reject', { note })}
      >
        <label class="field">
          <span class="field__label">Note (optional)</span>
          <input
            class="field__control"
            value={note}
            onInput={(event: Event) => setNote((event.target as HTMLInputElement).value)}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'applied'}
        title="Mark this patch as applied"
        consequence="Records that you pasted this text into LinkedIn. The next snapshot import checks whether it actually landed."
        confirmLabel="Mark applied"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('applied')}
      />

      <EditWithConsequence
        open={editing}
        title={`Edit ${patch.field_key}`}
        consequenceTitle="Editing re-derives the citations"
        consequence="The claims backing this patch are recomputed from the new text, and the patch drops back to proposed. Text that no verified claim supports is flagged rather than exported."
        fieldLabel="New text"
        rows={12}
        value={text}
        onInput={setText}
        charLimit={patch.char_limit}
        saveLabel="Save as a new proposal"
        pending={mutation.pending}
        onSave={() => void act('edit', { new_text: text })}
        onCancel={() => setEditing(false)}
      />
    </div>
  );
}

/**
 * The patches and the export bundle — as content, with no container.
 *
 * `SplitView` decides whether this lands in a docked pane or, on a narrow
 * viewport, in a `Drawer`. The per-patch editor stays a `Drawer` of its own on
 * top of whichever one this is: composing an exact paste is a task you finish
 * or abandon, not one you leave half-open beside the list.
 */
function ChangeSetDetail(props: { id: string; onClose: () => void }) {
  const detail = useResource<{
    change_set: { title: string; state: string; patches: FieldPatch[] };
  }>(`/changesets/${props.id}`);
  const [bundle, setBundle] = useState<ExportBundleEntry[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation();

  const exportBundle = async () => {
    const result = (await mutation.run(`/changesets/${props.id}/export`)) as {
      bundle: { entries: ExportBundleEntry[] };
    } | null;
    if (result !== null) {
      setBundle(result.bundle.entries);
      setConfirming(false);
      pushToast('ok', 'Bundle exported — paste each field into LinkedIn');
      detail.reload();
    }
  };

  return (
    <>
      <ResourceView resource={detail.state} reload={detail.reload} label="the change set">
        {(data) => (
          <div class="stack">
            <div class="row row--between">
              <strong>{data.change_set.title}</strong>
              <StatusChip state={data.change_set.state} />
            </div>

            {mutation.error ? <InlineError error={mutation.error} /> : null}

            {bundle === null ? (
              <>
                {data.change_set.patches.map((patch) => (
                  <PatchCard key={patch.id} patch={patch} onChanged={detail.reload} />
                ))}
                <Button
                  variant="primary"
                  disabled={!data.change_set.patches.some((p) => p.state === 'approved')}
                  disabledReason="Accept at least one patch before exporting."
                  onClick={() => setConfirming(true)}
                >
                  Export &amp; apply
                </Button>
              </>
            ) : (
              <Section
                level={3}
                title="Apply these to LinkedIn"
                hint="There is no profile-edit API. Copy each field and paste it where indicated."
              >
                {bundle.map((entry, index) => (
                  <div class="card stack stack--tight" key={entry.patch_id}>
                    <div class="row row--between">
                      <strong>
                        {index + 1}. {entry.field_key}
                      </strong>
                      <CopyButton value={entry.exact_text} label="Copy" />
                    </div>
                    <p class={pairClass('text-muted/surface-1')}>{entry.ui_hint}</p>
                    <pre class="excerpt">{entry.exact_text}</pre>
                  </div>
                ))}
              </Section>
            )}
          </div>
        )}
      </ResourceView>

      <ConfirmDialog
        open={confirming}
        title="Export this change set"
        consequence="Every cited claim is re-checked one last time before the text leaves for a public profile. The change set is then marked exported."
        confirmLabel="Export"
        pending={mutation.pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void exportBundle()}
      />
    </>
  );
}

function SectionsView() {
  const profile = useResource<{
    sections: Record<string, CanonicalRevision | null>;
    scores: ScoreFinding[];
  }>('/profile');

  return (
    <ResourceView resource={profile.state} reload={profile.reload} label="the profile">
      {(data) => {
        const entries = Object.entries(data.sections);
        const linkedIn = entries.filter(([key]) => LINKEDIN_FIELDS.has(key));
        const internal = entries.filter(([key]) => !LINKEDIN_FIELDS.has(key));

        const render = ([key, revision]: [string, CanonicalRevision | null]) => (
          <div class="card stack stack--tight" key={key}>
            <div class="row row--between">
              <strong>{key}</strong>
              <span class={pairClass('text-subtle/surface-1')}>
                {revision ? `cites ${revision.claim_ids.length} claims` : 'empty'}
              </span>
            </div>
            {revision ? <pre class="excerpt">{revision.content_text}</pre> : null}
          </div>
        );

        return (
          <div class="stack">
            <Section
              level={3}
              title="LinkedIn fields"
              hint="These map to a field you can paste into."
            >
              {linkedIn.map(render)}
            </Section>
            <Section
              level={3}
              title="Internal only"
              hint="Working notes with no LinkedIn destination. They are never emitted as patches."
            >
              {internal.map(render)}
            </Section>
          </div>
        );
      }}
    </ResourceView>
  );
}

function DiffView() {
  const diff = useResource<{
    diff: Array<{
      field_key: string;
      left_text: string | null;
      right_text: string | null;
      changed: boolean;
    }>;
  }>('/profile/diff?left=canonical&right=snapshot:latest');

  return (
    <ResourceView resource={diff.state} reload={diff.reload} label="the diff">
      {(data) => {
        const changed = data.diff.filter((row) => row.changed);
        return changed.length === 0 ? (
          <EmptyState title="Your canonical profile matches the last snapshot" />
        ) : (
          <>
            {changed.map((row) => (
              <div class="card stack stack--tight" key={row.field_key}>
                <strong>{row.field_key}</strong>
                <p class={pairClass('text-subtle/surface-1')}>On LinkedIn (last snapshot)</p>
                <pre class="excerpt">{row.right_text ?? '(empty)'}</pre>
                <p class={pairClass('text-subtle/surface-1')}>Canonical (evidence-backed)</p>
                <pre class="excerpt">{row.left_text ?? '(empty)'}</pre>
              </div>
            ))}
          </>
        );
      }}
    </ResourceView>
  );
}

/**
 * The title leads because it is what you decide to open. The two counts that
 * make that decision — what is waiting on you, and what is ready to paste —
 * stay beside it; the total is dropped first on a narrow viewport, because how
 * big a set is has never been the reason to open it.
 */
const CHANGE_SET_COLUMNS: ReadonlyArray<Column<ChangeSetSummary>> = [
  { key: 'title', header: 'Title', cell: (set) => set.title },
  {
    key: 'state',
    header: 'State',
    cell: (set) => <StatusChip state={set.state} />,
  },
  {
    key: 'patches',
    header: 'Patches',
    priority: 'low',
    align: 'end',
    cell: (set) => set.patch_count,
  },
  { key: 'proposed', header: 'To review', align: 'end', cell: (set) => set.proposed_count },
  { key: 'approved', header: 'Ready', align: 'end', cell: (set) => set.approved_count },
  {
    key: 'created',
    header: 'Created',
    align: 'end',
    cell: (set) => <Timestamp value={set.created_at} />,
  },
];

function ChangeSetsView() {
  const sets = useResource<{ change_sets: ChangeSetSummary[] }>('/changesets');
  const [open, setOpen] = useState<string | null>(null);

  // Accepting a patch moves the row's own counts, so the list is refetched on
  // the way out rather than left showing what was true when it was opened.
  const close = () => {
    setOpen(null);
    sets.reload();
  };

  const list = (
    <div class="stack stack--tight">
      <ResourceView resource={sets.state} reload={sets.reload} label="change sets">
        {(data) => (
          <DataTable
            caption="Change sets"
            rows={data.change_sets}
            rowKey={(set) => set.id}
            selectedKey={open}
            columns={CHANGE_SET_COLUMNS}
            action={{
              label: 'Open',
              describe: (set) => `Open change set: ${set.title}`,
              onActivate: (set) => setOpen(set.id),
            }}
            empty={
              <EmptyState title="No change sets yet">
                <p class={pairClass('text-muted/surface-1')}>
                  Generate one with <code>linkedin_changeset_generate</code> once canonical sections
                  differ from your last snapshot.
                </p>
              </EmptyState>
            }
          />
        )}
      </ResourceView>
    </div>
  );

  return (
    <SplitView
      list={list}
      detailTitle="Change set"
      selectionKey={open}
      onCloseDetail={close}
      detail={open ? <ChangeSetDetail id={open} onClose={close} /> : null}
    />
  );
}

interface ProfileSnapshot {
  id: string;
  version: number;
  source_kind: string;
  imported_at: string;
}

/**
 * The version leads because it is how one import gets referred to, and where it
 * came from is what you check next — a DMA sync and a hand-pasted export are not
 * the same kind of evidence. The id is dropped first on a narrow viewport: it
 * names the row to a machine, not to the person reading it.
 */
const SNAPSHOT_COLUMNS: ReadonlyArray<Column<ProfileSnapshot>> = [
  { key: 'version', header: 'Version', cell: (snapshot) => `v${snapshot.version}` },
  { key: 'source', header: 'Source', cell: (snapshot) => snapshot.source_kind },
  {
    key: 'id',
    header: 'Id',
    priority: 'low',
    cell: (snapshot) => <Id value={snapshot.id} />,
  },
  {
    key: 'imported',
    header: 'Imported',
    align: 'end',
    cell: (snapshot) => <Timestamp value={snapshot.imported_at} />,
  },
];

function SnapshotsView() {
  const profile = useResource<{
    snapshots: ProfileSnapshot[];
    scores: ScoreFinding[];
  }>('/profile');

  return (
    <ResourceView resource={profile.state} reload={profile.reload} label="snapshots">
      {(data) => (
        <div class="stack">
          <Section
            title="Score"
            hint="Transparent ratios with their reasoning. Never a single number that implies precision the data cannot carry."
          >
            {data.scores.map((finding) => (
              <div class="card stack stack--tight" key={finding.dimension}>
                <div class="row row--between">
                  <strong>{finding.dimension.replace(/_/g, ' ')}</strong>
                  <span class="u-tabular">{finding.score}</span>
                </div>
                <p class={pairClass('text-muted/surface-1')}>{finding.explanation}</p>
                {finding.details.map((detail) => (
                  <p class={pairClass('text-subtle/surface-1')} key={detail}>
                    {detail}
                  </p>
                ))}
              </div>
            ))}
          </Section>
          <Section
            level={3}
            title="Snapshots"
            hint="What LinkedIn actually said, each time it was imported."
          >
            <DataTable
              caption="Imported snapshots"
              rows={data.snapshots}
              rowKey={(snapshot) => snapshot.id}
              columns={SNAPSHOT_COLUMNS}
              empty={<EmptyState title="No snapshots imported" />}
            />
          </Section>
        </div>
      )}
    </ResourceView>
  );
}

export function ProfileScreen() {
  const route = useRoute();
  const view = (VIEWS as readonly string[]).includes(route.view ?? '')
    ? (route.view as View)
    : 'sections';

  return (
    <div class="stack">
      <ViewNav
        label="Profile views"
        destination="profile"
        current={view}
        views={VIEWS.map((key) => ({ key, label: VIEW_LABEL[key] }))}
      />
      {view === 'sections' ? <SectionsView /> : null}
      {view === 'diff' ? (
        <Section
          title="Canonical vs LinkedIn"
          hint="What differs between your evidence-backed copy and your last snapshot."
        >
          <DiffView />
        </Section>
      ) : null}
      {view === 'changesets' ? (
        <Section
          title="Change sets"
          hint="Copy/paste patches. Applying one is always something you do by hand."
        >
          <ChangeSetsView />
        </Section>
      ) : null}
      {view === 'snapshots' ? <SnapshotsView /> : null}
    </div>
  );
}
