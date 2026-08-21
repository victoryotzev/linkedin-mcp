import { DataTable, type Column } from '../components/DataTable.tsx';
import { Callout, EmptyState } from '../components/Feedback.tsx';
import { Hash, Timestamp } from '../components/Facts.tsx';
import { ResourceView, Section } from '../components/Screen.tsx';
import { ActorBadge, StatusChip, ToneText } from '../components/Status.tsx';
import { navigate, type Destination } from '../lib/router.ts';
import { useResource } from '../lib/store.ts';
import type { ChainStatus, WorkbenchSummary } from '../lib/types.ts';
import { pairClass } from '../styles/pairs.ts';
import { pluralise, relativeTime } from '../lib/format.ts';

// What needs a decision now, what is blocked, whether the state is healthy, and
// what changed. The ranking below is fixed and documented rather than learned:
// a queue that reorders itself is a queue you cannot trust to be complete.

type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'neutral';

interface QueueItem {
  key: string;
  tone: Tone;
  title: string;
  reason: string;
  destination: Destination;
  /**
   * Required, not optional. Every row here names a specific decision, and the
   * screen that owns it always has a view for that decision — landing a member
   * on a destination's default view would make them hunt for the thing the
   * queue just told them about.
   */
  view: string;
}

function buildQueue(summary: WorkbenchSummary): QueueItem[] {
  const items: QueueItem[] = [];
  const { counts } = summary;

  for (const approval of summary.approvals.pending) {
    items.push({
      key: `approval-pending-${approval.id}`,
      tone: 'warn',
      title: 'A publication is waiting for your approval',
      reason: `expires ${relativeTime(approval.expires_at)} — approve the exact revision or deny it`,
      destination: 'publishing',
      view: 'approvals',
    });
  }

  for (const approval of summary.approvals.armed) {
    items.push({
      key: `approval-armed-${approval.id}`,
      tone: 'accent',
      title: 'An approval is armed',
      reason: `a live single-use authorisation exists for revision ${approval.revision_hash.slice(0, 12)}…`,
      destination: 'publishing',
      view: 'approvals',
    });
  }

  for (const publication of summary.publications_unresolved) {
    items.push({
      key: `publication-${publication.id}`,
      tone: 'danger',
      title: 'A publication outcome is unknown',
      reason: 'the response was lost — check LinkedIn and report what you find',
      destination: 'publishing',
      view: 'publications',
    });
  }

  if (counts.conflicts_open > 0) {
    items.push({
      key: 'conflicts',
      tone: 'danger',
      title: `${pluralise(counts.conflicts_open, 'conflict')} open`,
      reason: 'claims contradict each other; every member needs a decision',
      destination: 'evidence',
      view: 'conflicts',
    });
  }

  if (counts.claims.expired > 0 || counts.claims_stale > 0) {
    const total = counts.claims.expired + counts.claims_stale;
    items.push({
      key: 'claims-expired',
      tone: 'warn',
      title: `${pluralise(total, 'claim')} past review`,
      reason: 'expired claims can no longer back profile copy or a post until re-reviewed',
      destination: 'evidence',
      view: 'queue',
    });
  }

  if (counts.claims.candidate > 0) {
    items.push({
      key: 'claims-candidate',
      tone: 'warn',
      title: `${pluralise(counts.claims.candidate, 'claim')} awaiting verification`,
      reason: 'each one needs checking against its evidence before it can be used',
      destination: 'evidence',
      view: 'queue',
    });
  }

  if (counts.sources_pending > 0) {
    items.push({
      key: 'sources',
      tone: 'warn',
      title: `${pluralise(counts.sources_pending, 'source')} awaiting authorisation`,
      reason: 'registered but not enabled; nothing is imported from them yet',
      destination: 'evidence',
      view: 'sources',
    });
  }

  if (counts.patches.proposed > 0) {
    items.push({
      key: 'patches-proposed',
      tone: 'warn',
      title: `${pluralise(counts.patches.proposed, 'profile patch')} to review`,
      reason: 'proposed changes to your LinkedIn fields, each citing verified claims',
      destination: 'profile',
      view: 'changesets',
    });
  }

  if (counts.patches.approved > 0) {
    items.push({
      key: 'patches-approved',
      tone: 'accent',
      title: `${pluralise(counts.patches.approved, 'patch')} ready to apply`,
      reason: 'export the bundle and paste each field into LinkedIn — there is no edit API',
      destination: 'profile',
      view: 'changesets',
    });
  }

  if (counts.patches_applied_unverified > 0) {
    items.push({
      key: 'patches-unverified',
      tone: 'neutral',
      title: `${pluralise(counts.patches_applied_unverified, 'applied patch')} unconfirmed`,
      reason: 'import a fresh snapshot to confirm the text actually landed',
      destination: 'profile',
      view: 'snapshots',
    });
  }

  if (counts.drafts_failing_validation > 0) {
    items.push({
      key: 'drafts-failing',
      tone: 'warn',
      title: `${pluralise(counts.drafts_failing_validation, 'draft')} failing validation`,
      reason: 'unsupported sentences and fabricated metrics block approval',
      destination: 'content',
      view: 'drafts',
    });
  }

  return items;
}

/**
 * The queue routes rather than resolving in place.
 *
 * Each row belongs to a different destination's decision UI — an approval to
 * Publishing, a conflict to Evidence, a patch to Profile. Rendering those
 * decisions here would mean a second copy of each one, and two places to keep a
 * consequential control correct is exactly the trade this product does not
 * make. Triage names the work and takes you to the screen that owns it.
 */
const QUEUE_COLUMNS: ReadonlyArray<Column<QueueItem>> = [
  {
    key: 'title',
    header: 'Needs a decision',
    cell: (item) => <ToneText tone={item.tone}>{item.title}</ToneText>,
  },
  {
    key: 'reason',
    header: 'Why',
    cell: (item) => <span class={pairClass('text-muted/surface-1')}>{item.reason}</span>,
  },
];

const EVENT_COLUMNS: ReadonlyArray<Column<WorkbenchSummary['recent_events'][number]>> = [
  { key: 'type', header: 'Event', cell: (event) => <span class="u-mono">{event.event_type}</span> },
  {
    key: 'actor',
    // Who acted is the guarantee this product sells, so it is a column of its
    // own rather than a detail inside a payload.
    header: 'By',
    cell: (event) => <ActorBadge actor={event.actor} />,
  },
  {
    key: 'when',
    header: 'When',
    align: 'end',
    cell: (event) => <Timestamp value={event.created_at} />,
  },
];

function Blocked(props: { summary: WorkbenchSummary }) {
  const unusable = props.summary.capabilities.filter((c) => c.status !== 'verified');
  const expiring = props.summary.lanes.filter((lane) => {
    if (!lane.token_expires_at) return false;
    const days = (new Date(lane.token_expires_at).getTime() - Date.now()) / 86_400_000;
    return days < 14;
  });

  if (unusable.length === 0 && expiring.length === 0) return null;

  return (
    <Section title="Blocked" hint="These cannot proceed until something changes.">
      {expiring.map((lane) => (
        <Callout
          key={lane.lane}
          tone="warn"
          title={`The ${lane.lane} lane token expires ${relativeTime(lane.token_expires_at!)}`}
        >
          <p class={pairClass('text-muted/surface-1')}>
            Mint a fresh token in the Developer Portal and paste it in System → Credentials.
          </p>
        </Callout>
      ))}
      {groupByRemedy(unusable).map((group) => (
        <div class="card stack stack--tight" key={group.key}>
          {group.capabilities.map((capability) => (
            <div class="row row--between" key={capability.feature}>
              <span class="u-mono">{capability.feature}</span>
              <StatusChip state={capability.status} />
            </div>
          ))}
          {/* No product path produces a capability that is not verified and
              carries no blockers, so the empty case is unreachable today.
              Kept because "blockers:" with nothing after it is worse than no
              line: it invites the reader to look for something absent. */}
          {/* v8 ignore next 3 */}
          {group.blockers.length > 0 ? (
            <p class={pairClass('text-subtle/surface-1')}>blockers: {group.blockers.join(', ')}</p>
          ) : null}
          {/* The domain's own remediation text, verbatim. It is some of the
              clearest writing in the product and the old UI showed it on one
              screen only. Printed once per distinct fix rather than once per
              capability: five capabilities blocked on one missing LinkedIn app
              produced the same four-line paragraph five times, and a wall of
              identical text reads as noise rather than as instructions. */}
          <p class={pairClass('text-muted/surface-1')}>{group.remediation}</p>
        </div>
      ))}
    </Section>
  );
}

type Capability = WorkbenchSummary['capabilities'][number];

/** Capabilities waiting on the same fix, gathered under one copy of it. */
function groupByRemedy(
  capabilities: Capability[],
): Array<{ key: string; capabilities: Capability[]; blockers: string[]; remediation: string }> {
  const groups = new Map<
    string,
    { capabilities: Capability[]; blockers: string[]; remediation: string }
  >();
  for (const capability of capabilities) {
    const blockers = [...capability.blockers].sort();
    const key = `${blockers.join('|')}::${capability.remediation}`;
    const existing = groups.get(key);
    if (existing) existing.capabilities.push(capability);
    else
      groups.set(key, {
        capabilities: [capability],
        blockers,
        remediation: capability.remediation,
      });
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

function Health(props: { summary: WorkbenchSummary; chain: ChainStatus | null }) {
  const { counts } = props.summary;
  return (
    <Section title="Health">
      <div class="card stack stack--tight">
        <div class="row row--between">
          <span>Audit chain</span>
          {props.chain === null ? (
            // Never rendered as 0 or as "fine": unknown and healthy must not
            // look alike.
            <span class={pairClass('text-subtle/surface-1')}>checking…</span>
          ) : props.chain.valid ? (
            <span class={pairClass('ok/surface-1')}>
              intact · {props.chain.length} events · <Hash value={props.chain.head_hash} />
            </span>
          ) : (
            <span class={pairClass('danger/surface-1')}>
              broken at seq {props.chain.broken_at_seq}
            </span>
          )}
        </div>
        <div class="row row--between">
          <span>Evidence</span>
          <span class="u-tabular">
            {counts.claims.verified} verified · {counts.claims.candidate} candidate ·{' '}
            {counts.claims.ambiguous} ambiguous · {counts.claims.expired} expired ·{' '}
            {counts.claims.rejected} rejected
          </span>
        </div>
        {props.summary.score.map((finding) => (
          <div class="row row--between" key={finding.dimension}>
            <span>{finding.dimension.replace(/_/g, ' ')}</span>
            {/* A transparent ratio with its explanation, never a composite
                score out of 100 that implies precision the data cannot carry. */}
            <span class={pairClass('text-muted/surface-1')}>
              <span class="u-tabular">{finding.score}</span> — {finding.explanation}
            </span>
          </div>
        ))}
        {props.summary.lanes.length === 0 ? (
          <div class="row row--between">
            <span>LinkedIn lanes</span>
            <span class={pairClass('text-subtle/surface-1')}>none configured</span>
          </div>
        ) : (
          props.summary.lanes.map((lane) => (
            <div class="row row--between" key={lane.lane}>
              <span>{lane.lane} lane</span>
              <StatusChip state={lane.status} />
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

export function OverviewScreen() {
  const summary = useResource<{ summary: WorkbenchSummary }>('/overview');
  // Its own request, so the O(n) hash walk over the whole audit log never
  // delays the actionable content.
  const chain = useResource<{ chain: ChainStatus }>('/system/chain');

  return (
    <ResourceView resource={summary.state} reload={summary.reload} label="the overview">
      {(data) => {
        const queue = buildQueue(data.summary);
        const chainStatus = chain.state.status === 'ready' ? chain.state.data.chain : null;

        return (
          // The whole sheet, filled exactly: a work column and a state column
          // that reach the bottom of the frame together and are separated by a
          // rule rather than by a gap between floating panels. Each side scrolls
          // on its own, so neither can push the other off the screen.
          <div class="fill">
            {chainStatus && !chainStatus.valid ? (
              <Callout
                tone="danger"
                title={`Audit chain broken at seq ${chainStatus.broken_at_seq}`}
              >
                <p>{chainStatus.reason}</p>
                <p>
                  Approvals and publishing are refused until the database is restored from a
                  verified backup.
                </p>
              </Callout>
            ) : null}

            <div class="overview">
              <div class="overview__work">
                <Section
                  title="Needs your decision"
                  hint="Ranked by consequence. Nothing here acts on its own."
                >
                  {queue.length === 0 ? (
                    <EmptyState title="Nothing is waiting on you">
                      <p class={pairClass('text-muted/surface-1')}>
                        No pending approvals, open conflicts, unreviewed claims or unapplied
                        patches.
                      </p>
                    </EmptyState>
                  ) : (
                    <DataTable
                      caption="Work waiting on a decision, in priority order"
                      rows={queue}
                      rowKey={(item) => item.key}
                      columns={QUEUE_COLUMNS}
                      action={{
                        label: 'Open',
                        describe: (item) => `Open: ${item.title}`,
                        onActivate: (item) =>
                          navigate({ destination: item.destination, view: item.view }),
                      }}
                    />
                  )}
                </Section>
              </div>

              <div class="overview__state">
                <Blocked summary={data.summary} />
                <Health summary={data.summary} chain={chainStatus} />

                <Section title="Recently">
                  <DataTable
                    caption="Recent audit events"
                    rows={data.summary.recent_events}
                    rowKey={(event) => String(event.seq)}
                    columns={EVENT_COLUMNS}
                    empty={<EmptyState title="No activity yet" />}
                  />
                </Section>
              </div>
            </div>
          </div>
        );
      }}
    </ResourceView>
  );
}
