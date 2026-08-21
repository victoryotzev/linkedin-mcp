import { useState } from 'hono/jsx/dom';
import { Button } from '../components/Button.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { Callout, EmptyState, InlineError } from '../components/Feedback.tsx';
import { Hash, Timestamp } from '../components/Facts.tsx';
import { ConfirmDialog } from '../components/Overlay.tsx';
import { ResourceView, Section, ViewNav } from '../components/Screen.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { EditWithConsequence } from '../components/EditWithConsequence.tsx';
import { SplitView } from '../components/SplitView.tsx';
import { StatusChip } from '../components/Status.tsx';
import { pushToast } from '../components/Toast.tsx';
import { navigate, useRoute } from '../lib/router.ts';
import { useMutation, useResource } from '../lib/store.ts';
import type {
  Draft,
  DraftRevision,
  Opportunity,
  SentenceCoverage,
  ValidationReport,
  VoiceProfile,
} from '../lib/types.ts';
import { pairClass } from '../styles/pairs.ts';

const VIEWS = ['drafts', 'opportunities', 'calendar', 'published'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  drafts: 'Drafts',
  opportunities: 'Opportunities',
  calendar: 'Calendar',
  published: 'Published & voice',
};

const DRAFT_PANELS = [
  { key: 'text', label: 'Text' },
  { key: 'checks', label: 'Checks' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'history', label: 'History' },
] as const;

function ChecksList(props: { validation: ValidationReport | null }) {
  const [showPassing, setShowPassing] = useState(false);
  if (!props.validation) {
    return <p class={pairClass('text-muted/surface-3')}>This revision has not been validated.</p>;
  }
  const failing = props.validation.checks.filter((check) => !check.passed);
  const passing = props.validation.checks.filter((check) => check.passed);

  return (
    <div class="stack stack--tight">
      {failing.map((check) => (
        <Callout tone="danger" title={check.check.replace(/_/g, ' ')} key={check.check}>
          <p class={pairClass('text-muted/surface-3')}>{check.detail}</p>
          {check.offenders.slice(0, 5).map((offender) => (
            <p class={`u-mono ${pairClass('text-subtle/surface-3')}`} key={offender}>
              {offender}
            </p>
          ))}
        </Callout>
      ))}
      <Button variant="ghost" onClick={() => setShowPassing(!showPassing)}>
        {showPassing ? 'Hide' : 'Show'} {passing.length} passing check
        {passing.length === 1 ? '' : 's'}
      </Button>
      {showPassing
        ? passing.map((check) => (
            <div class="row row--between" key={check.check}>
              <span class={pairClass('ok/surface-3')}>{check.check.replace(/_/g, ' ')}</span>
              <span class={pairClass('text-subtle/surface-3')}>{check.detail}</span>
            </div>
          ))
        : null}
    </div>
  );
}

/**
 * Everything under one draft — text, checks, coverage, history — as content,
 * with no container of its own.
 *
 * `SplitView` owns the choice between a docked pane and, on a narrow viewport,
 * a `Drawer`. Judging a draft ready is partly a comparison against the drafts
 * either side of it, so the list has to survive opening this.
 */
function DraftDetail(props: { id: string; onChanged: () => void }) {
  const detail = useResource<{
    draft: Draft;
    revision: DraftRevision;
    validation: ValidationReport | null;
    revisions: Array<{
      revision: number;
      revision_hash: string;
      created_at: string;
      chars: number;
    }>;
  }>(`/drafts/${props.id}`);
  const [tab, setTab] = useState<'text' | 'checks' | 'coverage' | 'history'>('text');
  const [coverage, setCoverage] = useState<SentenceCoverage[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState<'approval' | 'edit' | null>(null);
  const mutation = useMutation();

  const data = detail.state.status === 'ready' ? detail.state.data : null;

  // Explicitly triggered, never on open: checkCoverage writes a
  // content-addressed report row, and navigation must not mutate.
  const runCoverage = async () => {
    if (!data) return;
    const result = (await mutation.run('/coverage', {
      text: data.revision.body_text,
      subject: 'draft',
      subject_ref: data.draft.id,
    })) as { coverage: { sentences: SentenceCoverage[] } } | null;
    if (result) setCoverage(result.coverage.sentences);
  };

  const revalidate = async () => {
    const result = await mutation.run(`/drafts/${props.id}/validate`);
    if (result !== null) {
      pushToast('ok', 'Validation re-run');
      detail.reload();
      props.onChanged();
    }
  };

  const saveEdit = async () => {
    const result = await mutation.run(`/drafts/${props.id}`, { body_text: body });
    if (result !== null) {
      setEditing(false);
      setConfirming(null);
      pushToast('ok', 'New revision saved — any live approval is now invalidated');
      detail.reload();
      props.onChanged();
    }
  };

  const requestApproval = async () => {
    const result = await mutation.run(`/drafts/${props.id}/approval-request`);
    if (result !== null) {
      setConfirming(null);
      pushToast(
        'ok',
        'Approval requested',
        'Grant it in Publishing — a separate, deliberate step.',
      );
      props.onChanged();
      navigate({ destination: 'publishing', view: 'approvals' });
    }
  };

  const validationCurrent =
    data?.validation?.passed === true &&
    data.validation.revision_hash === data.draft.current_revision_hash;

  return (
    <>
      <ResourceView resource={detail.state} reload={detail.reload} label="the draft">
        {(draftData) => (
          <div class="stack">
            <div class="row row--between">
              <span class="row">
                <strong>{draftData.draft.slug}</strong>
                <StatusChip state={draftData.draft.state} on="surface-3" />
              </span>
              <span class={pairClass('text-subtle/surface-3')}>
                revision {draftData.draft.current_revision}
              </span>
            </div>

            {/* In-place panels within the drawer, not navigation — a segmented
                control rather than links or a half-built tab pattern. */}
            <SegmentedControl
              label="Draft panels"
              value={tab}
              options={DRAFT_PANELS}
              onChange={setTab}
            />

            {mutation.error ? <InlineError error={mutation.error} /> : null}

            {tab === 'text' ? (
              <>
                <pre class="excerpt">{draftData.revision.body_text}</pre>
                <p class={pairClass('text-subtle/surface-3')}>
                  <span class="u-tabular">{draftData.revision.body_text.length}</span> characters ·
                  visibility {draftData.revision.visibility} · revision{' '}
                  <Hash value={draftData.revision.revision_hash} />
                </p>
              </>
            ) : null}

            {tab === 'checks' ? <ChecksList validation={draftData.validation} /> : null}

            {tab === 'coverage' ? (
              <div class="stack stack--tight">
                <p class={pairClass('text-muted/surface-3')}>
                  Sentence-level scoring against verified claims. Unsupported sentences are the hard
                  blocker on approval.
                </p>
                <Button
                  variant="secondary"
                  pending={mutation.pending}
                  onClick={() => void runCoverage()}
                >
                  Check coverage
                </Button>
                {coverage?.map((sentence) => (
                  <div class="stack stack--tight" key={sentence.index}>
                    <span class="row">
                      <StatusChip
                        state={sentence.status}
                        tone={
                          sentence.status === 'supported'
                            ? 'ok'
                            : sentence.status === 'partial'
                              ? 'warn'
                              : 'danger'
                        }
                      />
                      <span class={pairClass('text-subtle/surface-3')}>
                        best <span class="u-tabular">{sentence.best_score}</span>
                      </span>
                    </span>
                    <p>{sentence.text}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {tab === 'history' ? (
              <div class="stack stack--tight">
                {draftData.revisions.map((revision) => (
                  <div class="row row--between" key={revision.revision_hash}>
                    <span>revision {revision.revision}</span>
                    <span class="row">
                      <Hash value={revision.revision_hash} />
                      <Timestamp value={revision.created_at} />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <div class="row">
              <Button
                variant="secondary"
                pending={mutation.pending}
                onClick={() => void revalidate()}
              >
                Re-validate
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setBody(draftData.revision.body_text);
                  setEditing(true);
                }}
              >
                Edit body
              </Button>
              <Button
                variant="primary"
                disabled={!validationCurrent}
                disabledReason={
                  draftData.validation === null
                    ? 'This revision has not been validated yet.'
                    : draftData.validation.revision_hash !== draftData.draft.current_revision_hash
                      ? 'The validation describes an older revision. Re-validate first.'
                      : 'Validation is failing. Fix the failing checks first.'
                }
                onClick={() => setConfirming('approval')}
              >
                Request approval
              </Button>
            </div>
          </div>
        )}
      </ResourceView>

      <EditWithConsequence
        open={editing}
        title="Edit draft body"
        consequenceTitle="This creates a new revision"
        consequence="Any live approval for this draft is invalidated in the same transaction as the edit — an approval describes one exact text, so changing the text kills it."
        fieldLabel="Body"
        rows={14}
        value={body}
        onInput={setBody}
        saveLabel="Save new revision"
        onSave={() => setConfirming('edit')}
        onCancel={() => setEditing(false)}
      />

      <ConfirmDialog
        open={confirming === 'edit'}
        title="Save a new revision"
        consequence="Validation and any live approval for this draft are invalidated. It returns to draft state and must be validated again."
        confirmLabel="Save new revision"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void saveEdit()}
      />

      <ConfirmDialog
        open={confirming === 'approval'}
        title="Request approval to publish"
        consequence="This creates a pending approval bound to this exact revision. It does not approve anything — granting is a separate decision you make in Publishing, with the text in front of you."
        confirmLabel="Request approval"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void requestApproval()}
      />
    </>
  );
}

/**
 * Never validated and nothing failing are different answers, and the column has
 * to keep saying which of the two it is — an unvalidated draft cannot be
 * approved either, but for a reason the member can fix in one press.
 */
function checksSummary(draft: Draft): string {
  if (!draft.validation) return 'not validated';
  const failing = draft.validation.checks.filter((check) => !check.passed).length;
  return failing === 0 ? 'all checks pass' : `${failing} check${failing === 1 ? '' : 's'} failing`;
}

/**
 * The slug leads because it is what the member is choosing between; state and
 * checks are the pair that decides whether this draft can go anywhere at all.
 * The revision number drops first on a narrow viewport — it matters once you
 * are inside the draft, not while you are picking one.
 */
const DRAFT_COLUMNS: ReadonlyArray<Column<Draft>> = [
  { key: 'slug', header: 'Slug', cell: (draft) => draft.slug },
  {
    key: 'state',
    header: 'State',
    cell: (draft) => <StatusChip state={draft.state} />,
  },
  { key: 'checks', header: 'Checks', cell: (draft) => checksSummary(draft) },
  {
    key: 'revision',
    header: 'Revision',
    priority: 'low',
    align: 'end',
    cell: (draft) => <span class="u-tabular">{draft.current_revision}</span>,
  },
];

function DraftsView() {
  const drafts = useResource<{ drafts: Draft[]; voice: VoiceProfile }>('/drafts');
  const [open, setOpen] = useState<string | null>(null);

  const list = (
    <div class="stack stack--tight">
      <ResourceView resource={drafts.state} reload={drafts.reload} label="drafts">
        {(data) => (
          <DataTable
            caption="Drafts and the state of their checks"
            rows={data.drafts}
            rowKey={(draft) => draft.id}
            selectedKey={open}
            columns={DRAFT_COLUMNS}
            empty={
              <EmptyState title="No drafts yet">
                <p class={pairClass('text-muted/surface-1')}>
                  Draft one through your MCP host with <code>linkedin_draft_write</code>, using only
                  verified claims.
                </p>
              </EmptyState>
            }
            action={{
              label: 'Open',
              describe: (draft) => `Open draft: ${draft.slug}`,
              onActivate: (draft) => setOpen(draft.id),
            }}
          />
        )}
      </ResourceView>
    </div>
  );

  return (
    <SplitView
      list={list}
      detailTitle="Draft"
      selectionKey={open}
      onCloseDetail={() => setOpen(null)}
      detail={open ? <DraftDetail id={open} onChanged={drafts.reload} /> : null}
    />
  );
}

/**
 * Cards, not a table. An opportunity carrying allowed-wording limitations is a
 * record with a warning attached to it, and a warning that has to be read
 * cannot be a cell in a row someone is scanning past.
 */
function OpportunitiesView() {
  const opportunities = useResource<{ opportunities: Opportunity[] }>('/opportunities');
  return (
    <ResourceView
      resource={opportunities.state}
      reload={opportunities.reload}
      label="opportunities"
    >
      {(data) =>
        data.opportunities.length === 0 ? (
          <EmptyState title="Nothing to suggest yet">
            <p class={pairClass('text-muted/surface-1')}>
              Opportunities are verified claims you have not already written about. Verify some
              claims first.
            </p>
          </EmptyState>
        ) : (
          <>
            {data.opportunities.map((opportunity) => (
              <div class="card stack stack--tight" key={opportunity.claim_id}>
                <p>{opportunity.statement}</p>
                <span class={pairClass('text-subtle/surface-1')}>
                  novelty <span class="u-tabular">{opportunity.novelty}</span>
                  {opportunity.closest_prior
                    ? ` · closest prior: ${opportunity.closest_prior}`
                    : ''}
                </span>
                {opportunity.limitations ? (
                  <p class={pairClass('warn/surface-1')}>
                    wording constraint: {opportunity.limitations}
                  </p>
                ) : null}
              </div>
            ))}
          </>
        )
      }
    </ResourceView>
  );
}

interface CalendarEntry {
  id: string;
  intended_date: string;
  status: string;
  note: string | null;
}

/**
 * The date leads and stays left-aligned: here it names the entry rather than
 * trailing it, which is the one case where a date is not metadata. The note is
 * last because most entries do not have one.
 */
const CALENDAR_COLUMNS: ReadonlyArray<Column<CalendarEntry>> = [
  { key: 'date', header: 'Intended date', cell: (entry) => entry.intended_date },
  {
    key: 'status',
    header: 'Status',
    cell: (entry) => <StatusChip state={entry.status} />,
  },
  { key: 'note', header: 'Note', cell: (entry) => entry.note ?? '' },
];

function CalendarView() {
  const drafts = useResource<{ calendar: CalendarEntry[] }>('/drafts');

  return (
    <>
      <Callout tone="info" title="Planning only">
        <p class={pairClass('text-muted/surface-1')}>
          Nothing publishes from a date. There is no scheduler anywhere in this system — publishing
          always needs a fresh human approval bound to one exact revision.
        </p>
      </Callout>
      <ResourceView resource={drafts.state} reload={drafts.reload} label="the calendar">
        {(data) => (
          <DataTable
            caption="Planned posting dates"
            rows={data.calendar}
            rowKey={(entry) => entry.id}
            columns={CALENDAR_COLUMNS}
            empty={<EmptyState title="No calendar entries" />}
          />
        )}
      </ResourceView>
    </>
  );
}

interface PublishedPost {
  id: string;
  posted_at: string;
  commentary: string;
  char_count: number;
}

/**
 * What was actually posted leads; the date and the length are how a member
 * places a post, not what they came to read. The character count drops first —
 * it measures the text sitting immediately beside it.
 */
const PUBLISHED_COLUMNS: ReadonlyArray<Column<PublishedPost>> = [
  { key: 'commentary', header: 'Post', cell: (post) => post.commentary.slice(0, 280) },
  {
    key: 'posted',
    header: 'Posted',
    align: 'end',
    cell: (post) => <Timestamp value={post.posted_at} />,
  },
  {
    key: 'chars',
    header: 'Chars',
    priority: 'low',
    align: 'end',
    cell: (post) => <span class="u-tabular">{post.char_count}</span>,
  },
];

function PublishedView() {
  const published = useResource<{
    posts: PublishedPost[];
    voice: VoiceProfile;
  }>('/published');

  return (
    <ResourceView resource={published.state} reload={published.reload} label="published posts">
      {(data) => (
        <div class="stack">
          <Section
            level={3}
            title="Voice profile"
            hint="Descriptive statistics of how you have actually written. Drafts match this register instead of inventing one."
          >
            <div class="card stack stack--tight">
              <div class="row row--between">
                <span>Posts</span>
                <span class="u-tabular">{data.voice.posts}</span>
              </div>
              <div class="row row--between">
                <span>Median length</span>
                <span class="u-tabular">{data.voice.median_chars} characters</span>
              </div>
              <div class="row row--between">
                <span>Hashtags per post</span>
                <span class="u-tabular">{data.voice.hashtags_per_post}</span>
              </div>
              <div class="row row--between">
                <span>Posts with a link</span>
                <span class="u-tabular">{data.voice.posts_with_link}</span>
              </div>
              <div class="row row--between">
                <span>Languages</span>
                <span>
                  {Object.entries(data.voice.language_mix)
                    .map(([language, count]) => `${language} ${count}`)
                    .join(' · ') || '—'}
                </span>
              </div>
              {data.voice.top_hashtags.length > 0 ? (
                <div class="row">
                  {data.voice.top_hashtags.map((tag) => (
                    <span class="chip" key={tag.tag}>
                      {tag.tag} <span class="u-tabular">{tag.count}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </Section>

          <Section level={3} title="Published history">
            <DataTable
              caption="Published posts imported from the export"
              rows={data.posts}
              rowKey={(post) => post.id}
              columns={PUBLISHED_COLUMNS}
              empty={<EmptyState title="No published posts imported" />}
            />
          </Section>
        </div>
      )}
    </ResourceView>
  );
}

export function ContentScreen() {
  const route = useRoute();
  const view = (VIEWS as readonly string[]).includes(route.view ?? '')
    ? (route.view as View)
    : 'drafts';

  return (
    <div class="stack">
      <ViewNav
        label="Content views"
        destination="content"
        current={view}
        views={VIEWS.map((key) => ({ key, label: VIEW_LABEL[key] }))}
      />
      {view === 'drafts' ? (
        <Section
          title="Drafts"
          hint="Read the text, check the evidence under it, then request approval."
        >
          <DraftsView />
        </Section>
      ) : null}
      {view === 'opportunities' ? (
        <Section
          title="Opportunities"
          hint="Verified claims you have not already written about, ranked by novelty."
        >
          <OpportunitiesView />
        </Section>
      ) : null}
      {view === 'calendar' ? (
        <Section title="Calendar">
          <CalendarView />
        </Section>
      ) : null}
      {view === 'published' ? <PublishedView /> : null}
    </div>
  );
}
