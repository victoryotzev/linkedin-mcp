import { useState, type Child } from 'hono/jsx/dom';
import { Button } from '../components/Button.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { Callout, EmptyState, InlineError } from '../components/Feedback.tsx';
import { Excerpt, Id, Timestamp } from '../components/Facts.tsx';
import { ConfirmDialog } from '../components/Overlay.tsx';
import { ResourceView, Section, ViewNav } from '../components/Screen.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { SplitView } from '../components/SplitView.tsx';
import { StatusChip } from '../components/Status.tsx';
import { pushToast } from '../components/Toast.tsx';
import { middleTruncate } from '../lib/format.ts';
import { useRoute } from '../lib/router.ts';
import { useDebounced, useMutation, useResource } from '../lib/store.ts';
import type {
  ArtifactSummary,
  Claim,
  ClaimEvidence,
  Conflict,
  Paged,
  Source,
} from '../lib/types.ts';
import { pairClass } from '../styles/pairs.ts';

const VIEWS = ['queue', 'claims', 'conflicts', 'sources', 'artifacts'] as const;
type View = (typeof VIEWS)[number];

const VIEW_LABEL: Record<View, string> = {
  queue: 'Review queue',
  claims: 'All claims',
  conflicts: 'Conflicts',
  sources: 'Sources',
  artifacts: 'Artifacts',
};

function Tabs(props: { current: View }) {
  return (
    <ViewNav
      label="Evidence views"
      destination="evidence"
      current={props.current}
      views={VIEWS.map((key) => ({ key, label: VIEW_LABEL[key] }))}
    />
  );
}

/**
 * The claim, its evidence and the decision — as content, with no container.
 *
 * `SplitView` decides whether this lands in a docked pane or, on a narrow
 * viewport, in a `Drawer`. Keeping the container out of here is what lets the
 * same markup be non-modal beside the list and modal over it without a second
 * copy of the review UI.
 */
function ClaimDetail(props: { claim: Claim; onClose: () => void; onChanged: () => void }) {
  const evidence = useResource<{ evidence: ClaimEvidence[] }>(`/claims/${props.claim.id}/evidence`);
  const [confirming, setConfirming] = useState<'verify' | 'clone' | 'reject' | null>(null);
  const [limitations, setLimitations] = useState('');
  const [reason, setReason] = useState('');
  const mutation = useMutation();

  const rows = evidence.state.status === 'ready' ? evidence.state.data.evidence : [];
  const tampered = rows.some((row) => row.integrity_error !== null);
  const cloneBacked = rows.some(
    (row) => row.role === 'primary' && row.source_trust === 'local_clone_reference',
  );

  const act = async (kind: 'verify' | 'clone' | 'reject') => {
    const path = kind === 'reject' ? 'reject' : 'verify';
    const body =
      kind === 'reject'
        ? { reason }
        : kind === 'clone'
          ? { limitations: limitations || undefined, clone_reference_ack: true }
          : { limitations: limitations || undefined };
    const result = await mutation.run(`/claims/${props.claim.id}/${path}`, body);
    if (result !== null) {
      setConfirming(null);
      pushToast('ok', kind === 'reject' ? 'Claim rejected permanently' : 'Claim verified');
      props.onChanged();
      props.onClose();
    }
  };

  return (
    <>
      <div class="stack stack--tight">
        <p>{props.claim.statement}</p>
        <div class="row">
          <StatusChip state={props.claim.state} on="surface-3" />
          <span class={pairClass('text-subtle/surface-3')}>
            <Id value={props.claim.id} /> · {props.claim.method} · {props.claim.sensitivity}
          </span>
        </div>
        {props.claim.limitations ? (
          <Callout tone="info" title="Allowed wording">
            {/* Travels with the claim into every patch and draft that cites it. */}
            <p class={pairClass('text-muted/surface-3')}>{props.claim.limitations}</p>
          </Callout>
        ) : null}
      </div>

      <Section level={3} title="Evidence">
        <ResourceView resource={evidence.state} reload={evidence.reload} label="evidence">
          {(data) =>
            data.evidence.length === 0 ? (
              <EmptyState title="No evidence is linked to this claim" />
            ) : (
              <>
                {data.evidence.map((row) => (
                  <div class="stack stack--tight" key={`${row.artifact_id}-${row.role}`}>
                    <p class={pairClass('text-subtle/surface-3')}>
                      {row.source_label} · {middleTruncate(row.source_relpath)} · trust{' '}
                      {row.source_trust} · {row.role}
                    </p>
                    {row.integrity_error !== null ? (
                      <Callout tone="danger" title="Evidence failed its integrity check">
                        <p class={pairClass('text-muted/surface-3')}>{row.integrity_error}</p>
                        <p class={pairClass('text-muted/surface-3')}>
                          The stored bytes no longer match the hash recorded at import. This claim
                          cannot be verified on this evidence.
                        </p>
                      </Callout>
                    ) : row.excerpt !== null ? (
                      <Excerpt text={row.excerpt} label="imported evidence" />
                    ) : (
                      <p class={pairClass('text-subtle/surface-3')}>no text preview</p>
                    )}
                  </div>
                ))}
              </>
            )
          }
        </ResourceView>
      </Section>

      {mutation.error ? <InlineError error={mutation.error} /> : null}

      {props.claim.state === 'candidate' || props.claim.state === 'expired' ? (
        <div class="stack stack--tight">
          <label class="field">
            <span class="field__label">Allowed-wording limitations (optional)</span>
            <span class="field__hint">
              Recorded on the claim and carried into every patch and draft that cites it.
            </span>
            <input
              class="field__control"
              value={limitations}
              onInput={(event: Event) => setLimitations((event.target as HTMLInputElement).value)}
            />
          </label>
          <div class="row">
            <Button
              variant="primary"
              disabled={tampered}
              disabledReason="Evidence failed its integrity check, so this claim cannot be verified on it."
              onClick={() => setConfirming('verify')}
            >
              Verify
            </Button>
            {cloneBacked ? (
              <Button
                variant="secondary"
                disabled={tampered}
                onClick={() => setConfirming('clone')}
              >
                Verify as familiarity only
              </Button>
            ) : null}
            <Button variant="danger" onClick={() => setConfirming('reject')}>
              Reject permanently
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming === 'verify'}
        title="Verify this claim"
        consequence="Verified claims may be cited by profile patches and post drafts. You are asserting the evidence above supports the statement."
        confirmLabel="Verify"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('verify')}
      />

      <ConfirmDialog
        open={confirming === 'clone'}
        title="Verify as familiarity only"
        consequence="This asserts the statement describes familiarity with third-party code, not authorship of it. The assertion is written into the claim's limitations permanently."
        confirmLabel="Verify as familiarity only"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('clone')}
      />

      <ConfirmDialog
        open={confirming === 'reject'}
        title="Reject this claim permanently"
        consequence="Rejection is a tombstone. The identical statement can never be re-proposed, by you or by the model."
        confirmLabel="Reject permanently"
        destructive
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void act('reject')}
      >
        <label class="field">
          <span class="field__label">Reason (required, becomes the permanent record)</span>
          <input
            class="field__control"
            value={reason}
            onInput={(event: Event) => setReason((event.target as HTMLInputElement).value)}
          />
        </label>
      </ConfirmDialog>
    </>
  );
}

/**
 * The statement leads because it is what the reviewer is deciding about;
 * everything else is provenance. The id is dropped first on a narrow viewport —
 * it identifies a row to a machine, not to the person reading it.
 */
const CLAIM_COLUMNS: ReadonlyArray<Column<Claim>> = [
  { key: 'statement', header: 'Statement', cell: (claim) => claim.statement },
  {
    key: 'state',
    header: 'State',
    cell: (claim) => <StatusChip state={claim.state} />,
  },
  { key: 'method', header: 'Method', priority: 'low', cell: (claim) => claim.method },
  {
    key: 'id',
    header: 'Id',
    priority: 'low',
    cell: (claim) => <Id value={claim.id} />,
  },
  {
    key: 'created',
    header: 'Created',
    align: 'end',
    cell: (claim) => <Timestamp value={claim.created_at} />,
  },
];

function ClaimList(props: {
  query: string;
  search: string;
  emptyTitle: string;
  emptyHint: string;
}) {
  const [selected, setSelected] = useState<Claim | null>(null);
  const search = useDebounced(props.search);
  const path = `/claims?${props.query}${search ? `&q=${encodeURIComponent(search)}` : ''}`;
  const claims = useResource<{ claims: Paged<Claim> }>(path);

  const list = (
    <div class="stack stack--tight">
      <ResourceView resource={claims.state} reload={claims.reload} label="claims">
        {(data) =>
          data.claims.items.length === 0 ? (
            <EmptyState title={props.emptyTitle}>
              <p class={pairClass('text-muted/surface-1')}>{props.emptyHint}</p>
            </EmptyState>
          ) : (
            <>
              <DataTable
                caption="Claims awaiting review"
                rows={data.claims.items}
                rowKey={(claim) => claim.id}
                selectedKey={selected?.id ?? null}
                columns={CLAIM_COLUMNS}
                action={{
                  label: 'Review',
                  describe: (claim) => `Review claim: ${claim.statement}`,
                  onActivate: setSelected,
                }}
              />
              <p class={pairClass('text-subtle/bg')}>
                Showing {data.claims.items.length} of {data.claims.total}
              </p>
            </>
          )
        }
      </ResourceView>
    </div>
  );

  return (
    <SplitView
      list={list}
      detailTitle="Review claim"
      selectionKey={selected?.id ?? null}
      onCloseDetail={() => setSelected(null)}
      detail={
        selected ? (
          <ClaimDetail
            claim={selected}
            onClose={() => setSelected(null)}
            onChanged={claims.reload}
          />
        ) : null
      }
    />
  );
}

/** One search box, shared by whatever list is on screen. */
function ClaimSearch(props: { children: (search: string) => Child }) {
  const [search, setSearch] = useState('');
  return (
    <div class="stack stack--tight">
      <label class="field">
        <span class="u-visually-hidden">Search claim statements</span>
        <input
          class="field__control"
          type="search"
          placeholder="Search statements…"
          value={search}
          onInput={(event: Event) => setSearch((event.target as HTMLInputElement).value)}
        />
      </label>
      {props.children(search)}
    </div>
  );
}

const QUEUE_TABS = [
  {
    key: 'candidate',
    label: 'Awaiting verification',
    query: 'state=candidate',
    emptyTitle: 'The review queue is clear',
    emptyHint: 'No claims are awaiting verification.',
  },
  {
    key: 'expired',
    label: 'Expired',
    query: 'state=expired',
    emptyTitle: 'Nothing has expired',
    emptyHint: 'Every verified claim is still within its review window.',
  },
] as const;

/**
 * Both halves of the queue behind one search box.
 *
 * They were previously two stacked lists, each with its own search field and
 * its own heading — two inputs on one screen doing the same job, and no way to
 * tell which one you had typed into.
 */
function ReviewQueue() {
  const [tab, setTab] = useState<(typeof QUEUE_TABS)[number]['key']>('candidate');
  const active = QUEUE_TABS.find((item) => item.key === tab) ?? QUEUE_TABS[0];

  return (
    <Section
      titleHidden
      title="Review queue"
      hint="Claims awaiting a decision, and claims that expired out of the corpus and need re-reviewing."
    >
      <SegmentedControl label="Queue filter" value={tab} options={QUEUE_TABS} onChange={setTab} />
      <ClaimSearch>
        {(search) => (
          <ClaimList
            query={active.query}
            search={search}
            emptyTitle={active.emptyTitle}
            emptyHint={active.emptyHint}
          />
        )}
      </ClaimSearch>
    </Section>
  );
}

function ConflictCard(props: { conflict: Conflict; onChanged: () => void }) {
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<'resolve' | 'dismiss' | null>(null);
  const mutation = useMutation();

  // The domain refuses a resolution that leaves any member undecided; the
  // control mirrors that rather than letting the member discover it by pressing.
  const undecided = props.conflict.members.filter((member) => !decisions[member.claim_id]);

  const resolve = async (resolution: 'resolved' | 'dismissed') => {
    const result = await mutation.run(`/conflicts/${props.conflict.id}/resolve`, {
      resolution,
      note,
      ...(resolution === 'resolved'
        ? {
            member_actions: props.conflict.members.map((member) => ({
              claim_id: member.claim_id,
              action: decisions[member.claim_id],
              reason: reasons[member.claim_id],
            })),
          }
        : {}),
    });
    if (result !== null) {
      setConfirming(null);
      pushToast('ok', resolution === 'resolved' ? 'Conflict resolved' : 'Conflict dismissed');
      props.onChanged();
    }
  };

  return (
    <div class="card stack stack--tight">
      <div class="row row--between">
        <span class="row">
          <StatusChip state={props.conflict.state} label={props.conflict.type} />
          <Id value={props.conflict.id} />
        </span>
        <Timestamp value={props.conflict.created_at} />
      </div>

      {props.conflict.members.map((member) => (
        <div class="stack stack--tight" key={member.claim_id}>
          <p>{member.statement}</p>
          <div class="row">
            <StatusChip state={member.state} />
            <label class="field">
              <span class="u-visually-hidden">Decision for {member.claim_id}</span>
              <select
                class="field__control"
                value={decisions[member.claim_id] ?? ''}
                onChange={(event: Event) =>
                  setDecisions({
                    ...decisions,
                    [member.claim_id]: (event.target as HTMLSelectElement).value,
                  })
                }
              >
                <option value="">— choose —</option>
                <option value="verify">Keep (verify)</option>
                <option value="reject">Reject (tombstone)</option>
                <option value="mark_ambiguous">Mark ambiguous</option>
              </select>
            </label>
            {decisions[member.claim_id] === 'reject' ? (
              <label class="field">
                <span class="u-visually-hidden">Reason</span>
                <input
                  class="field__control"
                  placeholder="reason"
                  value={reasons[member.claim_id] ?? ''}
                  onInput={(event: Event) =>
                    setReasons({
                      ...reasons,
                      [member.claim_id]: (event.target as HTMLInputElement).value,
                    })
                  }
                />
              </label>
            ) : null}
          </div>
        </div>
      ))}

      {mutation.error ? <InlineError error={mutation.error} /> : null}

      {props.conflict.state === 'open' ? (
        <>
          <label class="field">
            <span class="field__label">Resolution note</span>
            <input
              class="field__control"
              value={note}
              onInput={(event: Event) => setNote((event.target as HTMLInputElement).value)}
            />
          </label>
          <div class="row">
            <Button
              variant="primary"
              disabled={undecided.length > 0}
              disabledReason={`Every member claim needs a decision. ${undecided.length} still undecided.`}
              onClick={() => setConfirming('resolve')}
            >
              Resolve with these decisions
            </Button>
            <Button variant="secondary" onClick={() => setConfirming('dismiss')}>
              Not a real conflict
            </Button>
          </div>
          {undecided.length > 0 ? (
            <p class={pairClass('text-subtle/surface-1')}>
              {undecided.length} of {props.conflict.members.length} claims still need a decision.
            </p>
          ) : null}
        </>
      ) : // The conflicts view fetches open conflicts only, so a card for a
      // settled one cannot render today. The guard stays because the route
      // already serves resolved and dismissed history, and this card is what
      // would show it.
      /* v8 ignore next */
      null}

      <ConfirmDialog
        open={confirming === 'resolve'}
        title="Resolve this conflict"
        consequence="Each decision is applied atomically: verified claims become citable, rejected ones become permanent tombstones. If any single transition is invalid the whole resolution rolls back."
        confirmLabel="Apply these decisions"
        destructive
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void resolve('resolved')}
      />

      <ConfirmDialog
        open={confirming === 'dismiss'}
        title="Dismiss this conflict"
        consequence="The conflict is closed without changing any claim. Both statements stay exactly as they are."
        confirmLabel="Dismiss"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void resolve('dismissed')}
      />
    </div>
  );
}

/**
 * Trust is its own column rather than a second chip beside the status: the two
 * answer different questions — whether this source is being read at all, and
 * how much the evidence out of it is worth — and stacking them read as one
 * compound state.
 */
const SOURCE_COLUMNS: ReadonlyArray<Column<Source>> = [
  {
    key: 'label',
    header: 'Source',
    cell: (source) => <strong>{source.label}</strong>,
  },
  { key: 'status', header: 'Status', cell: (source) => <StatusChip state={source.status} /> },
  {
    key: 'trust',
    header: 'Trust',
    cell: (source) => <StatusChip state={source.trust} tone="neutral" />,
  },
  {
    key: 'path',
    header: 'Path',
    priority: 'low',
    cell: (source) => (
      <span class={`u-mono ${pairClass('text-subtle/surface-1')}`}>
        {middleTruncate(source.root_path, 64)}
      </span>
    ),
  },
];

function SourcesView() {
  const sources = useResource<{ sources: Source[] }>('/sources');
  const [confirming, setConfirming] = useState<Source | null>(null);
  const mutation = useMutation();

  const enable = async (source: Source) => {
    const result = await mutation.run(`/sources/${source.id}/enable`);
    if (result !== null) {
      setConfirming(null);
      pushToast('ok', `Enabled ${source.label}`);
      sources.reload();
    }
  };

  return (
    <ResourceView resource={sources.state} reload={sources.reload} label="sources">
      {(data) =>
        data.sources.length === 0 ? (
          <EmptyState title="No sources registered">
            <p class={pairClass('text-muted/surface-1')}>
              Register one with the MCP tool <code>linkedin_source_manage</code>. It lands in
              pending review; enable it here, in the CLI, or by confirming the exact source ID
              through MCP.
            </p>
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="Registered evidence sources"
              rows={data.sources}
              rowKey={(source) => source.id}
              columns={SOURCE_COLUMNS}
              action={{
                label: 'Enable',
                variant: 'primary',
                describe: (source) => `Enable source: ${source.label}`,
                available: (source) =>
                  source.status === 'pending_review' || source.status === 'disabled',
                onActivate: setConfirming,
              }}
            />
            {mutation.error ? <InlineError error={mutation.error} /> : null}
            <ConfirmDialog
              open={confirming !== null}
              title="Enable this source"
              consequence={`Imports will read files under ${confirming?.root_path ?? ''}. Only a human can enable a source, here or through the local control CLI; no MCP tool can do it.`}
              confirmLabel="Enable source"
              pending={mutation.pending}
              onCancel={() => setConfirming(null)}
              onConfirm={() => confirming && void enable(confirming)}
            />
          </>
        )
      }
    </ResourceView>
  );
}

/**
 * Redaction gets a column of its own rather than a trailing note. It is the one
 * fact here that says something happened to the bytes on the way in, and it
 * should be findable by scanning one column rather than by reading each line.
 */
const ARTIFACT_COLUMNS: ReadonlyArray<Column<ArtifactSummary>> = [
  {
    key: 'path',
    header: 'Path',
    cell: (artifact) => (
      <span class={`u-mono ${pairClass('text/surface-1')}`}>
        {middleTruncate(artifact.source_relpath, 56)}
      </span>
    ),
  },
  { key: 'mime', header: 'Type', priority: 'low', cell: (artifact) => artifact.mime },
  {
    key: 'secrets',
    header: 'Redaction',
    cell: (artifact) => (artifact.contains_secrets ? 'secrets redacted' : ''),
  },
  {
    key: 'size',
    header: 'Size',
    align: 'end',
    cell: (artifact) => (
      <>
        <span class="u-tabular">{artifact.size_bytes}</span> B
      </>
    ),
  },
];

function ArtifactsView() {
  const [search, setSearch] = useState('');
  const settled = useDebounced(search);
  const artifacts = useResource<{ artifacts: Paged<ArtifactSummary> }>(
    `/artifacts?${settled ? `q=${encodeURIComponent(settled)}` : ''}`,
  );

  return (
    <div class="stack stack--tight">
      <label class="field">
        <span class="u-visually-hidden">Search imported text</span>
        <input
          class="field__control"
          type="search"
          placeholder="Search imported text…"
          value={search}
          onInput={(event: Event) => setSearch((event.target as HTMLInputElement).value)}
        />
      </label>
      <ResourceView resource={artifacts.state} reload={artifacts.reload} label="artifacts">
        {(data) =>
          data.artifacts.items.length === 0 ? (
            <EmptyState title="No artifacts imported yet" />
          ) : (
            <>
              <DataTable
                caption="Imported artifacts"
                rows={data.artifacts.items}
                rowKey={(artifact) => artifact.id}
                columns={ARTIFACT_COLUMNS}
              />
              <p class={pairClass('text-subtle/bg')}>
                Showing {data.artifacts.items.length} of {data.artifacts.total}
              </p>
            </>
          )
        }
      </ResourceView>
    </div>
  );
}

function ConflictsView() {
  const conflicts = useResource<{ conflicts: Conflict[] }>('/conflicts');
  return (
    <ResourceView resource={conflicts.state} reload={conflicts.reload} label="conflicts">
      {(data) =>
        data.conflicts.length === 0 ? (
          <EmptyState title="No open conflicts">
            <p class={pairClass('text-muted/surface-1')}>
              Contradictions are detected deterministically: two active claims whose statements
              match once every number is replaced, but whose numbers differ.
            </p>
          </EmptyState>
        ) : (
          <>
            {data.conflicts.map((conflict) => (
              <ConflictCard key={conflict.id} conflict={conflict} onChanged={conflicts.reload} />
            ))}
          </>
        )
      }
    </ResourceView>
  );
}

export function EvidenceScreen() {
  const route = useRoute();
  const view = (VIEWS as readonly string[]).includes(route.view ?? '')
    ? (route.view as View)
    : 'queue';

  return (
    <div class="stack">
      <Tabs current={view} />
      {view === 'queue' ? <ReviewQueue /> : null}
      {view === 'claims' ? (
        <Section title="All claims">
          <ClaimSearch>
            {(search) => (
              <ClaimList
                query=""
                search={search}
                emptyTitle="No claims yet"
                emptyHint="Import evidence first."
              />
            )}
          </ClaimSearch>
        </Section>
      ) : null}
      {view === 'conflicts' ? (
        <Section
          title="Open conflicts"
          hint="Resolving requires a decision for every member claim."
        >
          <ConflictsView />
        </Section>
      ) : null}
      {view === 'sources' ? (
        <Section title="Sources" hint="Review and enable exact source paths as a human decision.">
          <SourcesView />
        </Section>
      ) : null}
      {view === 'artifacts' ? (
        <Section
          title="Artifacts"
          hint="Imported bytes, content-addressed and hash-verified on read."
        >
          <ArtifactsView />
        </Section>
      ) : null}
    </div>
  );
}
