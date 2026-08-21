import { useState } from 'hono/jsx/dom';
import { Button } from '../components/Button.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { Callout, EmptyState, InlineError } from '../components/Feedback.tsx';
import { Hash, Id, Timestamp } from '../components/Facts.tsx';
import { ConfirmDialog } from '../components/Overlay.tsx';
import { ResourceView, Section, ViewNav } from '../components/Screen.tsx';
import { ActorBadge, StatusChip } from '../components/Status.tsx';
import { relativeTime } from '../lib/format.ts';
import { useRoute } from '../lib/router.ts';
import { useMutation, useResource } from '../lib/store.ts';
import { pushToast } from '../components/Toast.tsx';
import type { Approval, Capability, ChainStatus, LaneAccount, Publication } from '../lib/types.ts';
import { pairClass } from '../styles/pairs.ts';

// The purpose-built visual publication review surface. The MCP parity tool can
// record the same decision only after an explicit bound confirmation.
//
// Three rules shape this screen and none of them is negotiable:
//
//   1. Grant is reachable only from an approval's own card, and only when the
//      byte-exact preview of the BOUND revision is on screen beside it. If the
//      preview cannot be built, the control stays disabled — approving bytes
//      nobody is looking at defeats the entire mechanism.
//   2. Nothing is optimistic. Displayed state changes only after the server has
//      answered.
//   3. A granted, unconsumed approval is not history. It is a live, single-use
//      authorisation to publish, and it is shown as one.

function ApprovalCard(props: { approval: Approval; onChanged: () => void }) {
  const { approval } = props;
  const [confirming, setConfirming] = useState<'grant' | 'deny' | null>(null);
  const [reason, setReason] = useState('');
  const mutation = useMutation();

  const preview = approval.preview;
  const canGrant = preview !== null;

  const act = async (kind: 'grant' | 'deny') => {
    const result = await mutation.run(
      `/approvals/${approval.id}/${kind}`,
      kind === 'deny' ? { reason } : {},
    );
    if (result !== null) {
      setConfirming(null);
      pushToast('ok', kind === 'grant' ? 'Approval granted' : 'Approval denied');
      props.onChanged();
    }
  };

  return (
    <div class="card stack stack--tight">
      <div class="row row--between">
        <div class="row">
          <StatusChip
            state={approval.state}
            label={approval.state === 'granted' ? 'armed' : approval.state}
          />
          <span class={pairClass('text-muted/surface-1')}>
            requested by <ActorBadge actor={approval.requested_by} />
          </span>
        </div>
        <span class={pairClass('text-subtle/surface-1')}>
          expires <Timestamp value={approval.expires_at} />
        </span>
      </div>

      {approval.state === 'granted' ? (
        <Callout tone="info" title="This is a live authorisation">
          <p class={pairClass('text-muted/surface-1')}>
            It permits publishing exactly one revision, exactly once, and is consumed by
            <code> linkedin_publish_execute</code>. Editing the draft invalidates it.
          </p>
        </Callout>
      ) : null}

      {preview !== null && !preview.revision_is_current ? (
        // The domain computes this specifically for the reviewer and the old
        // dashboard threw it away.
        <Callout tone="warn" title="The draft has moved on since this was requested">
          <p class={pairClass('text-muted/surface-1')}>
            What follows is the revision this approval is bound to — the bytes that would actually
            be published. It is not what the draft says now.
          </p>
        </Callout>
      ) : null}

      <div class="row">
        <span class={pairClass('text-subtle/surface-1')}>
          draft <Id value={approval.draft_id} /> · revision <Hash value={approval.revision_hash} />{' '}
          · visibility {approval.visibility}
        </span>
      </div>

      {preview === null ? (
        <Callout tone="danger" title="The bound revision could not be loaded">
          <p class={pairClass('text-muted/surface-1')}>
            Approval is refused while the exact text cannot be shown. Revisions are append-only, so
            a missing one means the draft history is damaged.
          </p>
        </Callout>
      ) : (
        <>
          {/* The bytes under approval. data-approval-preview is what the
              safety test looks for when asserting the grant control cannot
              exist without it. */}
          <pre class="excerpt" data-approval-preview={approval.id}>
            {preview.body_text}
          </pre>
          <p class={pairClass('text-subtle/surface-1')}>
            <span class="u-tabular">{preview.char_count}</span> characters · {preview.media.length}{' '}
            media
            {preview.intended_time ? ` · intended ${relativeTime(preview.intended_time)}` : ''}
          </p>
        </>
      )}

      {mutation.error ? <InlineError error={mutation.error} /> : null}

      {approval.state === 'pending' ? (
        <div class="row">
          <Button
            variant="primary"
            disabled={!canGrant}
            disabledReason="The exact text being approved cannot be displayed, so it cannot be approved."
            onClick={() => setConfirming('grant')}
          >
            Approve exactly this text
          </Button>
          <Button variant="danger" onClick={() => setConfirming('deny')}>
            Deny
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming === 'grant'}
        title="Approve this publication"
        consequence={`This authorises publishing revision ${approval.revision_hash.slice(0, 12)}… exactly once. It cannot be undone. An agent can record this decision only after you give the exact approval command.`}
        confirmLabel="Approve exactly this text"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('grant')}
      >
        <pre class="excerpt">{(preview?.body_text ?? '').slice(0, 240)}</pre>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'deny'}
        title="Deny this approval"
        consequence="The request is closed. A new approval must be requested for this draft before it can be published."
        confirmLabel="Deny"
        destructive
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('deny')}
      >
        <label class="field">
          <span class="field__label">Reason</span>
          <input
            class="field__control"
            value={reason}
            onInput={(event: Event) => setReason((event.target as HTMLInputElement).value)}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}

// Deliberately still a card, not a table row. An unresolved attempt carries the
// callout explaining that nobody knows whether the post went out, and two
// opposite reconciliation decisions — a shape a uniform row with one action
// cannot hold. Losing either half would lose the only route back to certainty.
function PublicationRow(props: { publication: Publication; onChanged: () => void }) {
  const { publication } = props;
  const [confirming, setConfirming] = useState<'found' | 'missing' | null>(null);
  const [url, setUrl] = useState('');
  const mutation = useMutation();
  const unresolved = publication.outcome === 'ambiguous' || publication.outcome === 'pending';

  const reconcile = async (found: boolean) => {
    const result = await mutation.run(`/publications/${publication.id}/reconcile`, {
      found,
      ...(found && url ? { post_url: url } : {}),
    });
    if (result !== null) {
      setConfirming(null);
      pushToast('ok', found ? 'Recorded as published' : 'Recorded as not published');
      props.onChanged();
    }
  };

  return (
    <div class="card stack stack--tight">
      <div class="row row--between">
        <span class="row">
          <StatusChip state={publication.outcome} />
          <span class="u-mono">{publication.adapter}</span>
        </span>
        <Timestamp value={publication.attempted_at} />
      </div>
      {publication.linkedin_post_urn ? (
        <span class={pairClass('text-subtle/surface-1')}>{publication.linkedin_post_urn}</span>
      ) : null}

      {unresolved ? (
        <>
          <Callout tone="warn" title="Nobody knows whether this went out">
            <p class={pairClass('text-muted/surface-1')}>
              The response was lost. Check your LinkedIn activity and report what you find. A retry
              after &ldquo;not there&rdquo; needs a fresh approval — this is never retried
              automatically.
            </p>
          </Callout>
          {mutation.error ? <InlineError error={mutation.error} /> : null}
          <div class="row">
            <Button variant="primary" onClick={() => setConfirming('found')}>
              I found the post
            </Button>
            <Button variant="danger" onClick={() => setConfirming('missing')}>
              It is not there
            </Button>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirming === 'found'}
        title="Record this as published"
        consequence="The draft is marked published and the publication is closed as a success."
        confirmLabel="Record as published"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void reconcile(true)}
      >
        <label class="field">
          <span class="field__label">Post URL (optional)</span>
          <input
            class="field__control"
            placeholder="https://www.linkedin.com/…"
            value={url}
            onInput={(event: Event) => setUrl((event.target as HTMLInputElement).value)}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'missing'}
        title="Record this as not published"
        consequence="The publication is closed as failed. Publishing this draft again requires a fresh approval — the original one is already consumed."
        confirmLabel="Record as not published"
        destructive
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void reconcile(false)}
      />
    </div>
  );
}

function Readiness(props: {
  capabilities: Capability[];
  lanes: LaneAccount[];
  chain: ChainStatus | null;
}) {
  const publish = props.capabilities.find((c) => c.feature === 'linkedin.publish_post');
  const writeLane = props.lanes.find((lane) => lane.lane === 'write');
  const steps = [
    {
      label: 'Write-lane account verified against LinkedIn',
      done: writeLane?.status === 'verified',
      detail: writeLane ? `account is ${writeLane.status}` : 'no write lane configured',
    },
    {
      label: 'Publishing capability proved',
      done: publish?.status === 'verified',
      detail: publish ? `capability is ${publish.status}` : 'not registered',
    },
    {
      label: 'Publishing explicitly enabled',
      done: publish?.status === 'verified' && publish.blockers.length === 0,
      detail: publish?.blockers.join(', ') || 'no blockers',
    },
    {
      label: 'Audit chain intact',
      done: props.chain?.valid === true,
      detail: props.chain === null ? 'checking' : (props.chain.reason ?? 'verified'),
    },
  ];

  return (
    <Section
      title="Publishing readiness"
      hint="Every step must hold before anything can leave this machine. Proving a credential works is not the same as deciding to post."
    >
      <div class="card stack stack--tight">
        {steps.map((step) => (
          <div class="row row--between" key={step.label}>
            <span class="row">
              <StatusChip
                state={step.done ? 'verified' : 'pending'}
                label={step.done ? 'ready' : 'not ready'}
                tone={step.done ? 'ok' : 'warn'}
              />
              {step.label}
            </span>
            <span class={pairClass('text-subtle/surface-1')}>{step.detail}</span>
          </div>
        ))}
      </div>
      {publish && publish.status !== 'verified' ? (
        <p class={pairClass('text-muted/bg')}>{publish.remediation}</p>
      ) : null}
    </Section>
  );
}

/**
 * A decided approval has no statement to lead with, so the draft it was about
 * carries the identity and stays at every width — dropping it would leave a
 * state and a date belonging to nothing. What was decided comes next, because
 * that is what history is scanned for; why a granted one lapsed is detail the
 * scan can do without.
 */
const APPROVAL_HISTORY_COLUMNS: ReadonlyArray<Column<Approval>> = [
  { key: 'draft', header: 'Draft', cell: (approval) => <Id value={approval.draft_id} /> },
  { key: 'state', header: 'State', cell: (approval) => <StatusChip state={approval.state} /> },
  {
    key: 'invalidated',
    header: 'Invalidated by',
    priority: 'low',
    cell: (approval) => approval.invalidated_by ?? '',
  },
  {
    key: 'requested',
    header: 'Requested',
    align: 'end',
    cell: (approval) => <Timestamp value={approval.created_at} />,
  },
];

const VIEWS = ['approvals', 'publications', 'readiness', 'history'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  approvals: 'Approvals',
  publications: 'Publications',
  readiness: 'Readiness',
  history: 'History',
};

/**
 * Publishing was the only destination that stacked every section on one page —
 * four unrelated things down a single scroll, with the decision that matters at
 * the top and the checklist explaining why it is impossible near the bottom.
 * Sub-views put each where it can be reached directly, and the count on
 * Approvals means splitting them up never hides work.
 */
function Tabs(props: { current: View; pending: number }) {
  return (
    <ViewNav
      label="Publishing views"
      destination="publishing"
      current={props.current}
      views={VIEWS.map((key) => ({
        key,
        label:
          key === 'approvals' && props.pending > 0
            ? `${VIEW_LABEL[key]} (${props.pending})`
            : VIEW_LABEL[key],
      }))}
    />
  );
}

export function PublishingScreen() {
  const route = useRoute();
  const view: View = (VIEWS as readonly string[]).includes(route.view ?? '')
    ? (route.view as View)
    : 'approvals';
  const approvals = useResource<{ approvals: Approval[]; chain: ChainStatus }>('/approvals');
  const publications = useResource<{ publications: Publication[] }>('/publications');
  const system = useResource<{ capabilities: Capability[]; lanes: LaneAccount[] }>('/system');

  const reload = () => {
    approvals.reload();
    publications.reload();
    // Readiness is derived from capabilities and lanes. Leaving it out meant
    // enabling publishing in System left this checklist claiming "not ready"
    // until a full page reload.
    system.reload();
  };

  return (
    <ResourceView resource={approvals.state} reload={approvals.reload} label="approvals">
      {(data) => {
        const pending = data.approvals.filter((a) => a.state === 'pending');
        const armed = data.approvals.filter((a) => a.state === 'granted');
        const history = data.approvals.filter(
          (a) => a.state !== 'pending' && a.state !== 'granted',
        );

        return (
          <div class="stack">
            {!data.chain.valid ? (
              <Callout
                tone="danger"
                title={`Audit chain broken at seq ${data.chain.broken_at_seq}`}
              >
                <p>{data.chain.reason}</p>
                <p>Approvals and publishing are refused until a verified backup is restored.</p>
              </Callout>
            ) : null}

            <Tabs current={view} pending={pending.length + armed.length} />

            {view === 'approvals' ? (
              <>
                <Section title="Pending approval" hint="Read the text, then decide.">
                  {pending.length === 0 ? (
                    <EmptyState title="Nothing is awaiting approval" />
                  ) : (
                    pending.map((approval) => (
                      <ApprovalCard key={approval.id} approval={approval} onChanged={reload} />
                    ))
                  )}
                </Section>

                {armed.length > 0 ? (
                  <Section
                    title="Armed"
                    hint="Granted and not yet consumed. Each of these is a live permission to publish."
                  >
                    {armed.map((approval) => (
                      <ApprovalCard key={approval.id} approval={approval} onChanged={reload} />
                    ))}
                  </Section>
                ) : null}
              </>
            ) : null}

            {view === 'publications' ? (
              <Section titleHidden title="Publications">
                <ResourceView
                  resource={publications.state}
                  reload={publications.reload}
                  label="publications"
                >
                  {(pubs) =>
                    pubs.publications.length === 0 ? (
                      <EmptyState title="Nothing has been published from here" />
                    ) : (
                      <>
                        {pubs.publications.map((publication) => (
                          <PublicationRow
                            key={publication.id}
                            publication={publication}
                            onChanged={reload}
                          />
                        ))}
                      </>
                    )
                  }
                </ResourceView>
              </Section>
            ) : null}

            {view === 'readiness' ? (
              <ResourceView resource={system.state} label="capabilities">
                {(sys) => (
                  <Readiness capabilities={sys.capabilities} lanes={sys.lanes} chain={data.chain} />
                )}
              </ResourceView>
            ) : null}

            {view === 'history' ? (
              <Section titleHidden title="Approval history">
                <DataTable
                  caption="Decided approvals"
                  rows={history}
                  rowKey={(approval) => approval.id}
                  columns={APPROVAL_HISTORY_COLUMNS}
                  empty={<EmptyState title="No decided approvals yet" />}
                />
              </Section>
            ) : null}
          </div>
        );
      }}
    </ResourceView>
  );
}
