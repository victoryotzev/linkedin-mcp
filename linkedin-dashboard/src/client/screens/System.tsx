import { useState } from 'hono/jsx/dom';
import { Button } from '../components/Button.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { Callout, EmptyState, InlineError } from '../components/Feedback.tsx';
import { Excerpt, Hash, Id, Timestamp } from '../components/Facts.tsx';
import { ConfirmDialog } from '../components/Overlay.tsx';
import { ResourceView, Section, ViewNav } from '../components/Screen.tsx';
import { SplitView } from '../components/SplitView.tsx';
import { ActorBadge, StatusChip } from '../components/Status.tsx';
import { pushToast } from '../components/Toast.tsx';
import { relativeTime } from '../lib/format.ts';
import { useRoute } from '../lib/router.ts';
import { useMutation, useResource } from '../lib/store.ts';
import type {
  AuditEvent,
  Capability,
  ChainStatus,
  FeatureControl,
  LaneAccount,
  Observation,
  RetentionSummary,
} from '../lib/types.ts';
import { pairClass } from '../styles/pairs.ts';

const VIEWS = [
  'credentials',
  'features',
  'capabilities',
  'tools',
  'audit',
  'retention',
  'analytics',
  'data',
] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  credentials: 'Credentials',
  features: 'Features',
  capabilities: 'Capabilities',
  tools: 'All MCP tools',
  audit: 'Audit log',
  retention: 'Retention',
  analytics: 'Analytics',
  data: 'Data & backups',
};

const LANE_HINT: Record<'read' | 'write', string> = {
  read: 'Member Data Portability. Bound to the Data Portability company page, which permanently excludes Sign In and Share on this app. Provides your own profile, positions, education, skills and post history.',
  write:
    'Sign In with LinkedIn + Share on LinkedIn. A separate application is required: binding an app to the Data Portability page blocks these products forever.',
};

function LaneCard(props: {
  lane: 'read' | 'write';
  account: LaneAccount | undefined;
  onChanged: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [token, setToken] = useState('');
  const [expires, setExpires] = useState('');
  const [confirming, setConfirming] = useState<'store' | 'verify' | null>(null);
  const mutation = useMutation();

  const store = async () => {
    const result = await mutation.run(`/lanes/${props.lane}/token`, {
      client_id: clientId,
      access_token: token,
      ...(expires ? { expires_in_seconds: Number(expires) } : {}),
    });
    // Cleared whether or not it succeeded: the value must not sit in the DOM.
    setToken('');
    if (result !== null) {
      setConfirming(null);
      pushToast('ok', 'Token stored encrypted', 'It is never returned by any read path.');
      props.onChanged();
    }
  };

  const verify = async () => {
    const result = (await mutation.run(`/lanes/${props.lane}/verify`)) as {
      result: { warnings: string[] };
    } | null;
    if (result !== null) {
      setConfirming(null);
      // A probe can succeed without opening the lane. Saying "verified" then
      // would be a lie the capability list directly contradicts.
      if (result.result.warnings.length > 0) {
        pushToast(
          'ok',
          'Token accepted, but the lane is not open yet',
          result.result.warnings.join(', '),
        );
      } else {
        pushToast('ok', 'Lane verified against LinkedIn');
      }
      props.onChanged();
    }
  };

  const expiresSoon =
    props.account?.token_expires_at &&
    (new Date(props.account.token_expires_at).getTime() - Date.now()) / 86_400_000 < 14;

  return (
    <div class="card stack stack--tight">
      <div class="row row--between">
        <strong>{props.lane} lane</strong>
        <StatusChip
          state={props.account?.status ?? 'unavailable'}
          label={props.account ? props.account.status : 'not configured'}
        />
      </div>
      <p class={pairClass('text-muted/surface-1')}>{LANE_HINT[props.lane]}</p>

      {props.account ? (
        <div class="stack stack--tight">
          <div class="row row--between">
            <span>Token stored</span>
            <span
              class={
                props.account.has_token
                  ? pairClass('ok/surface-1')
                  : pairClass('text-subtle/surface-1')
              }
            >
              {props.account.has_token ? 'yes' : 'no'}
            </span>
          </div>
          <div class="row row--between">
            <span>Client ID</span>
            <span class="u-mono">{props.account.client_id ?? '—'}</span>
          </div>
          {props.account.person_urn ? (
            <div class="row row--between">
              <span>Person URN</span>
              <span class="u-mono">{props.account.person_urn}</span>
            </div>
          ) : null}
          {props.account.token_expires_at ? (
            <div class="row row--between">
              <span>Token expires</span>
              <span
                class={
                  expiresSoon ? pairClass('warn/surface-1') : pairClass('text-muted/surface-1')
                }
              >
                {relativeTime(props.account.token_expires_at)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {mutation.error ? <InlineError error={mutation.error} /> : null}

      <label class="field">
        <span class="field__label">Client ID</span>
        <input
          class="field__control"
          value={clientId}
          autocomplete="off"
          onInput={(event: Event) => setClientId((event.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span class="field__label">Access token</span>
        <span class="field__hint">
          Encrypted with a Windows DPAPI-wrapped key before it reaches the database. Never returned
          by any read path, never carried over MCP. Paste it here and nowhere else.
        </span>
        <input
          class="field__control"
          type="password"
          autocomplete="off"
          value={token}
          onInput={(event: Event) => setToken((event.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span class="field__label">expires_in (seconds, optional)</span>
        <input
          class="field__control"
          value={expires}
          autocomplete="off"
          onInput={(event: Event) => setExpires((event.target as HTMLInputElement).value)}
        />
      </label>

      <div class="row">
        <Button
          variant="primary"
          disabled={token.length === 0}
          onClick={() => setConfirming('store')}
        >
          Save encrypted
        </Button>
        <Button variant="secondary" onClick={() => setConfirming('verify')}>
          Verify against LinkedIn
        </Button>
      </div>

      <ConfirmDialog
        open={confirming === 'store'}
        title="Store this credential"
        consequence="The token is encrypted and saved. Storing it does not open the lane — that needs a live probe, and publishing needs a further explicit decision after that."
        confirmLabel="Save encrypted"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void store()}
      />

      <ConfirmDialog
        open={confirming === 'verify'}
        title="Verify this lane against LinkedIn"
        consequence="This makes one real request to LinkedIn with the stored token. A failure demotes the lane; a success proves the credential but does not enable publishing."
        confirmLabel="Verify"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void verify()}
      />
    </div>
  );
}

function CredentialsView() {
  const system = useResource<{ lanes: LaneAccount[] }>('/system');
  return (
    <ResourceView resource={system.state} reload={system.reload} label="credentials">
      {(data) => (
        <>
          <Callout tone="info" title="A human-only credential entry point">
            <p class={pairClass('text-muted/surface-1')}>
              No MCP tool can reach this: the settings tool refuses secret-shaped keys. The masked
              companion CLI is the equivalent non-dashboard human entry point.
            </p>
          </Callout>
          <LaneCard
            lane="read"
            account={data.lanes.find((l) => l.lane === 'read')}
            onChanged={system.reload}
          />
          <LaneCard
            lane="write"
            account={data.lanes.find((l) => l.lane === 'write')}
            onChanged={system.reload}
          />
        </>
      )}
    </ResourceView>
  );
}

function CapabilitiesView() {
  const system = useResource<{ capabilities: Capability[] }>('/system');
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation();

  const enable = async () => {
    const result = await mutation.run('/capabilities/publishing/enable');
    if (result !== null) {
      setConfirming(false);
      pushToast('ok', 'Publishing enabled');
      system.reload();
    }
  };

  return (
    <ResourceView resource={system.state} reload={system.reload} label="capabilities">
      {(data) => {
        const publish = data.capabilities.find((c) => c.feature === 'linkedin.publish_post');
        // The domain requires 'configured' AND the awaiting_explicit_enable
        // blocker AND a verified write-lane account. Offering the control
        // without those is offering something that will fail.
        const canEnable =
          publish?.status === 'configured' && publish.blockers.includes('awaiting_explicit_enable');

        return (
          <div class="stack stack--tight">
            {data.capabilities.map((capability) => (
              <div class="card stack stack--tight" key={capability.feature}>
                <div class="row row--between">
                  <span class="u-mono">{capability.feature}</span>
                  <StatusChip state={capability.status} />
                </div>
                {capability.blockers.length > 0 ? (
                  <div class="row">
                    {capability.blockers.map((blocker) => (
                      <span class="chip" key={blocker}>
                        {blocker}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p class={pairClass('text-muted/surface-1')}>{capability.remediation}</p>
                {capability.verified_at ? (
                  <p class={pairClass('text-subtle/surface-1')}>
                    verified <Timestamp value={capability.verified_at} />
                    {capability.api_version ? ` · API version ${capability.api_version}` : ''}
                  </p>
                ) : null}
              </div>
            ))}

            {mutation.error ? <InlineError error={mutation.error} /> : null}

            {canEnable ? (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Enable publishing
              </Button>
            ) : null}

            <ConfirmDialog
              open={confirming}
              title="Enable publishing"
              consequence="This is the second gate. Proving the credential works is not the same as deciding to post; after this, a granted approval can send a real post to LinkedIn."
              confirmLabel="Enable publishing"
              destructive
              pending={mutation.pending}
              onCancel={() => setConfirming(false)}
              onConfirm={() => void enable()}
            />
          </div>
        );
      }}
    </ResourceView>
  );
}

/**
 * The event type leads because it is what the member scans for and what the
 * filter above narrows by; the actor answers the next question every entry
 * raises. The sequence number is the chain's own index — load-bearing when the
 * chain breaks, which the callout above already reports — so it drops before
 * anything a person reads.
 */
const AUDIT_COLUMNS: ReadonlyArray<Column<AuditEvent>> = [
  {
    key: 'event_type',
    header: 'Event',
    cell: (event) => <span class="u-mono">{event.event_type}</span>,
  },
  { key: 'actor', header: 'Actor', cell: (event) => <ActorBadge actor={event.actor} /> },
  {
    key: 'subject',
    header: 'Subject',
    priority: 'low',
    cell: (event) => (event.subject_id ? <Id value={event.subject_id} /> : '—'),
  },
  { key: 'seq', header: 'Seq', priority: 'low', align: 'end', cell: (event) => event.seq },
  {
    key: 'created',
    header: 'Recorded',
    align: 'end',
    cell: (event) => <Timestamp value={event.created_at} />,
  },
];

/**
 * One entry, in full, from the row already on screen.
 *
 * Nothing is fetched. The log is append-only, so a second read of an event the
 * list has already delivered could only ever return the same bytes; a loading
 * state beside a row the reader is already looking at would suggest the entry
 * were still capable of changing.
 */
function AuditEventDetail(props: { event: AuditEvent }) {
  return (
    <div class="stack stack--tight">
      <div class="row row--between">
        <span>Sequence</span>
        <span class="u-tabular">{props.event.seq}</span>
      </div>
      <div class="row row--between">
        <span>Event</span>
        <span class="u-mono">{props.event.event_type}</span>
      </div>
      <div class="row row--between">
        <span>Actor</span>
        <ActorBadge actor={props.event.actor} />
      </div>
      <div class="row row--between">
        <span>Subject</span>
        {props.event.subject_id ? (
          <Id value={props.event.subject_id} />
        ) : (
          <span class={pairClass('text-subtle/surface-3')}>—</span>
        )}
      </div>
      <div class="row row--between">
        <span>Recorded</span>
        <Timestamp value={props.event.created_at} />
      </div>
    </div>
  );
}

function AuditView() {
  const [eventType, setEventType] = useState('');
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const chain = useResource<{ chain: ChainStatus }>('/system/chain');
  const audit = useResource<{ events: AuditEvent[] }>(
    `/audit?limit=100${eventType ? `&event_type=${encodeURIComponent(eventType)}` : ''}`,
    [eventType],
  );

  const list = (
    <ResourceView resource={audit.state} reload={audit.reload} label="the audit log">
      {(data) => (
        <DataTable
          caption="Audit log events"
          columns={AUDIT_COLUMNS}
          rows={data.events}
          rowKey={(event) => String(event.seq)}
          selectedKey={selected ? String(selected.seq) : null}
          empty={<EmptyState title="No matching events" />}
          action={{
            label: 'Inspect',
            describe: (event) => `Inspect audit event ${event.seq}: ${event.event_type}`,
            onActivate: setSelected,
          }}
        />
      )}
    </ResourceView>
  );

  return (
    <div class="stack stack--tight">
      <ResourceView resource={chain.state} reload={chain.reload} label="the chain status">
        {(data) =>
          data.chain.valid ? (
            <Callout tone="ok" title="Chain verified">
              <p class={pairClass('text-muted/surface-1')}>
                {data.chain.length} events · head <Hash value={data.chain.head_hash} />
              </p>
            </Callout>
          ) : (
            <Callout tone="danger" title={`Chain broken at seq ${data.chain.broken_at_seq}`}>
              <p>{data.chain.reason}</p>
            </Callout>
          )
        }
      </ResourceView>

      <label class="field">
        <span class="u-visually-hidden">Filter by event type</span>
        <input
          class="field__control"
          type="search"
          placeholder="Filter by event type, e.g. approval.granted"
          value={eventType}
          onInput={(event: Event) => setEventType((event.target as HTMLInputElement).value)}
        />
      </label>

      <SplitView
        list={list}
        detailTitle="Audit event"
        selectionKey={selected ? String(selected.seq) : null}
        onCloseDetail={() => setSelected(null)}
        detail={selected ? <AuditEventDetail event={selected} /> : null}
      />
    </div>
  );
}

interface RetentionClass {
  retention_class: string;
  description: string;
  observations: number;
}

/**
 * The class leads because it is the name the policy text and the purge tools
 * both use to refer to the data. The rule beside it is the promise being made
 * about that class, and the count is how much of the member's data that promise
 * currently covers — a promise about a quantity nobody can see is not a useful
 * one.
 */
const RETENTION_COLUMNS: ReadonlyArray<Column<RetentionClass>> = [
  { key: 'class', header: 'Class', cell: (row) => <strong>{row.retention_class}</strong> },
  { key: 'policy', header: 'Policy', cell: (row) => row.description },
  { key: 'rows', header: 'Rows', align: 'end', cell: (row) => row.observations },
];

function RetentionView() {
  const system = useResource<{ retention: RetentionSummary }>('/system');
  return (
    <ResourceView resource={system.state} reload={system.reload} label="retention">
      {(data) => (
        <DataTable
          caption="Retention classes and what each one promises"
          columns={RETENTION_COLUMNS}
          // The policy is the source of truth for which classes exist; the
          // counts only cover the classes that currently hold anything.
          rows={Object.entries(data.retention.policy).map(([key, description]) => ({
            retention_class: key,
            description,
            observations:
              data.retention.classes.find((c) => c.retention_class === key)?.observations ?? 0,
          }))}
          rowKey={(row) => row.retention_class}
        />
      )}
    </ResourceView>
  );
}

function AnalyticsView() {
  const analytics = useResource<{
    metrics: Observation[];
    summary: Array<{ metric: string; observations: number; subjects: number }>;
  }>('/analytics');

  return (
    <ResourceView resource={analytics.state} reload={analytics.reload} label="analytics">
      {(data) => (
        <div class="stack">
          <Callout tone="info" title="A single account is a weak instrument">
            <p class={pairClass('text-muted/surface-1')}>
              Comparisons here always carry their sample size and confounders, and the confidence
              label is capped at &ldquo;moderate&rdquo; by construction.
            </p>
          </Callout>
          {data.summary.length === 0 ? (
            <EmptyState title="No metrics imported">
              <p class={pairClass('text-muted/surface-1')}>
                LinkedIn&rsquo;s member-analytics APIs need Community Management access that
                individuals cannot obtain, so manual import is the supported path.
              </p>
            </EmptyState>
          ) : (
            <>
              {data.summary.map((row) => (
                <div class="card row row--between" key={row.metric}>
                  <span class="u-mono">{row.metric}</span>
                  <span class="u-tabular">
                    {row.observations} observations · {row.subjects} subjects
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </ResourceView>
  );
}

function FeaturesView() {
  const system = useResource<{ features: FeatureControl[] }>('/system');
  const [pending, setPending] = useState<FeatureControl | null>(null);
  const mutation = useMutation();

  const change = async () => {
    if (!pending) return;
    const enabled = !pending.enabled;
    const result = await mutation.run(`/features/${pending.key}`, { enabled });
    if (result !== null) {
      pushToast('ok', `${pending.title} ${enabled ? 'enabled' : 'disabled'}`);
      setPending(null);
      system.reload();
    }
  };

  return (
    <ResourceView resource={system.state} reload={system.reload} label="feature settings">
      {(data) => (
        <div class="stack stack--tight">
          <Callout tone="info" title="One setting for dashboard and MCP">
            <p class={pairClass('text-muted/surface-1')}>
              These controls are stored in the shared database and take effect on both surfaces.
              Credentials are separate and can only be entered here or through the masked CLI.
            </p>
          </Callout>
          {data.features.map((feature) => (
            <div class="card stack stack--tight" key={feature.key}>
              <div class="row row--between">
                <span>
                  <strong>{feature.title}</strong>
                  <span class="chip u-mono">{feature.key}</span>
                </span>
                <StatusChip
                  state={feature.enabled ? 'verified' : 'disabled'}
                  label={feature.enabled ? 'enabled' : 'disabled'}
                />
              </div>
              <p class={pairClass('text-muted/surface-1')}>{feature.description}</p>
              <p class={pairClass('text-subtle/surface-1')}>
                Default: {feature.default_enabled ? 'enabled' : 'disabled'}
              </p>
              <Button
                variant={feature.enabled ? 'danger' : 'secondary'}
                onClick={() => setPending(feature)}
              >
                {feature.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          ))}
          {mutation.error ? <InlineError error={mutation.error} /> : null}
          <ConfirmDialog
            open={pending !== null}
            title={`${pending?.enabled ? 'Disable' : 'Enable'} ${pending?.title ?? 'feature'}`}
            consequence={
              pending?.key === 'live_publishing' && !pending.enabled
                ? 'This opens the real LinkedIn publishing gate only if the write credential has already been verified. Every post still needs its own approval and exact publish command.'
                : `This setting is shared immediately by the dashboard and every MCP process.`
            }
            confirmLabel={pending?.enabled ? 'Disable feature' : 'Enable feature'}
            destructive={pending?.enabled ?? false}
            pending={mutation.pending}
            onCancel={() => setPending(null)}
            onConfirm={() => void change()}
          />
        </div>
      )}
    </ResourceView>
  );
}

interface DashboardTool {
  name: string;
  title: string;
  description: string;
  permission: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input_schema: Record<string, unknown>;
}

function ToolConsoleView() {
  const catalog = useResource<{ tools: DashboardTool[] }>('/tools');
  const [selected, setSelected] = useState('');
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState<unknown>(null);
  const [parseError, setParseError] = useState('');
  const [pendingRun, setPendingRun] = useState<{ tool: DashboardTool; input: unknown } | null>(
    null,
  );
  const mutation = useMutation();

  const execute = async (tool: DashboardTool, parsed: unknown) => {
    setPendingRun(null);
    const response = (await mutation.run(`/tools/${encodeURIComponent(tool.name)}/run`, {
      input: parsed,
    })) as {
      result: unknown;
    } | null;
    if (response !== null) {
      setResult(response.result);
      pushToast('ok', `${tool.title} completed`);
    }
  };

  const requestRun = async (tool: DashboardTool) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
      setParseError('');
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'Input is not valid JSON');
      return;
    }
    if (
      !tool.annotations.readOnlyHint ||
      tool.annotations.destructiveHint ||
      tool.annotations.openWorldHint
    ) {
      setPendingRun({ tool, input: parsed });
      return;
    }
    await execute(tool, parsed);
  };

  return (
    <ResourceView resource={catalog.state} reload={catalog.reload} label="the MCP tool catalog">
      {(data) => {
        const tool = data.tools.find((candidate) => candidate.name === selected) ?? data.tools[0];
        if (!tool) return <EmptyState title="No MCP tools registered" />;
        return (
          <div class="stack">
            <Callout tone="info" title="Exact MCP parity">
              <p class={pairClass('text-muted/surface-1')}>
                This advanced console uses the same registry, input schemas, handlers, and output
                schemas as connected AI agents. Common workflows still have purpose-built screens.
              </p>
            </Callout>

            <label class="field">
              <span class="field__label">Tool</span>
              <select
                class="field__control"
                value={tool.name}
                onChange={(event: Event) => {
                  setSelected((event.target as HTMLSelectElement).value);
                  setInput('{}');
                  setResult(null);
                  setParseError('');
                  setPendingRun(null);
                  mutation.clear();
                }}
              >
                {data.tools.map((candidate) => (
                  <option value={candidate.name} key={candidate.name}>
                    {candidate.title} — {candidate.name}
                  </option>
                ))}
              </select>
            </label>

            <div class="card stack stack--tight">
              <div class="row row--between">
                <strong>{tool.title}</strong>
                <span class="chip">{tool.permission}</span>
              </div>
              <p class={pairClass('text-muted/surface-1')}>{tool.description}</p>
              <div class="row">
                <span class="chip">
                  {tool.annotations.readOnlyHint ? 'read only' : 'writes state'}
                </span>
                {tool.annotations.destructiveHint ? <span class="chip">destructive</span> : null}
                {tool.annotations.openWorldHint ? <span class="chip">external network</span> : null}
              </div>
              <details>
                <summary>Input schema</summary>
                <pre class="excerpt">{JSON.stringify(tool.input_schema, null, 2)}</pre>
              </details>
            </div>

            <label class="field">
              <span class="field__label">Input JSON</span>
              <span class="field__hint">
                State-changing schemas that require <code>confirm: true</code> still require it
                here.
              </span>
              <textarea
                class="field__control"
                rows={12}
                value={input}
                spellcheck={false}
                onInput={(event: Event) => setInput((event.target as HTMLTextAreaElement).value)}
              />
            </label>

            {parseError ? (
              <Callout tone="danger" title="Invalid JSON">
                <p>{parseError}</p>
              </Callout>
            ) : null}
            {mutation.error ? <InlineError error={mutation.error} /> : null}
            <Button
              variant="primary"
              pending={mutation.pending}
              onClick={() => void requestRun(tool)}
            >
              Run {tool.title}
            </Button>

            <ConfirmDialog
              open={pendingRun !== null}
              title={`Run ${pendingRun?.tool.title ?? 'this tool'}`}
              consequence={
                pendingRun?.tool.annotations.openWorldHint
                  ? 'This operation can contact an external service. Review the JSON and tool description before continuing.'
                  : pendingRun?.tool.annotations.destructiveHint
                    ? 'This operation is marked destructive. Review the JSON and consequences before continuing.'
                    : 'This operation changes shared application state. Review the JSON before continuing.'
              }
              confirmLabel="Run tool"
              destructive={pendingRun?.tool.annotations.destructiveHint ?? false}
              pending={mutation.pending}
              onCancel={() => setPendingRun(null)}
              onConfirm={() => {
                if (pendingRun) void execute(pendingRun.tool, pendingRun.input);
              }}
            />

            {result !== null ? (
              <Section title="Result">
                {/* Named, because this console holds two blocks of monospace
                    JSON at once and a bare <pre> is a region a screen reader
                    cannot announce the difference between. */}
                <Excerpt text={JSON.stringify(result, null, 2)} label="tool result" />
              </Section>
            ) : null}
          </div>
        );
      }}
    </ResourceView>
  );
}

interface BackupListing {
  name: string;
  created_at: string;
  entries: number;
}

/**
 * The archive name leads: it is what the verify confirmation names back, and
 * what the danger zone lists once one has passed. That name is the timestamp it
 * was written at, so the created column says the same thing in friendlier words
 * and is the first to go. The entry count stays, because it is the number a
 * verification is measured against.
 */
const BACKUP_COLUMNS: ReadonlyArray<Column<BackupListing>> = [
  { key: 'name', header: 'Backup', cell: (backup) => <span class="u-mono">{backup.name}</span> },
  {
    key: 'created',
    header: 'Created',
    priority: 'low',
    align: 'end',
    cell: (backup) => <Timestamp value={backup.created_at} />,
  },
  { key: 'entries', header: 'Entries', align: 'end', cell: (backup) => backup.entries },
];

function DataSection() {
  const backups = useResource<{ backups: BackupListing[] }>('/backups');
  const [confirming, setConfirming] = useState<'backup' | 'purge-all' | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const mutation = useMutation();
  const [purged, setPurged] = useState(false);
  const [purging, setPurging] = useState(false);
  // Set by a successful verification. Deleting everything is gated on having
  // proved a backup actually restores — a backup that has not been verified is
  // a belief, not a safety net.
  const [verifiedBackups, setVerifiedBackups] = useState<string[]>([]);
  const [acceptLoss, setAcceptLoss] = useState(false);

  const runBackup = async () => {
    const result = await mutation.run('/backups');
    if (result !== null) {
      setConfirming(null);
      pushToast('ok', 'Backup created');
      backups.reload();
    }
  };

  const verify = async (name: string) => {
    const result = (await mutation.run(`/backups/${name}/verify`)) as {
      result: { valid: boolean; checked: number; problems: string[] };
    } | null;
    setVerifying(null);
    if (result) {
      if (result.result.valid) {
        setVerifiedBackups((current) => [...new Set([...current, name])]);
        pushToast('ok', `${name} verified`, `${result.result.checked} entries all match.`);
      } else {
        setVerifiedBackups((current) => current.filter((backup) => backup !== name));
        pushToast('danger', `${name} did not verify`, result.result.problems.join('; '));
      }
    }
  };

  const purgeAll = async () => {
    // Not through useMutation's confirm wrapper — this route takes a typed
    // phrase rather than a boolean — but it still needs an in-flight guard, or
    // a double click sends the request twice.
    if (purging) return;
    setPurging(true);
    try {
      const response = await fetch('/api/purge-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirm_phrase: 'DELETE ALL LOCAL DATA',
          accept_no_backup: acceptLoss,
        }),
      });
      if (response.ok) {
        setPurged(true);
      } else {
        pushToast('danger', 'Purge was refused', `HTTP ${response.status}`);
      }
    } finally {
      setPurging(false);
    }
  };

  if (purged) {
    return (
      <Callout tone="danger" title="All local data has been deleted">
        <p class={pairClass('text-muted/surface-1')}>
          The database, the artifact store, the backups and the encryption key are gone, and the
          server has shut down. This window is no longer connected to anything.
        </p>
      </Callout>
    );
  }

  // A backup that exists is not a backup that works. The purge stays disabled
  // until one has been verified in this session, or until the loss is accepted
  // explicitly — which takes its own typed phrase.
  const hasVerifiedBackup = verifiedBackups.length > 0;
  const purgeAllowed = hasVerifiedBackup || acceptLoss;

  return (
    <div class="stack">
      <Section
        title="Backups"
        hint="Written only to the managed location. Secrets are never included."
      >
        {mutation.error ? <InlineError error={mutation.error} /> : null}
        <Button
          variant="primary"
          pending={mutation.pending}
          onClick={() => setConfirming('backup')}
        >
          Create a backup
        </Button>
        <ResourceView resource={backups.state} reload={backups.reload} label="backups">
          {(data) => (
            <DataTable
              caption="Backups written to the managed location"
              columns={BACKUP_COLUMNS}
              rows={data.backups}
              rowKey={(backup) => backup.name}
              empty={<EmptyState title="No backups yet" />}
              action={{
                label: 'Verify',
                describe: (backup) => `Verify backup: ${backup.name}`,
                onActivate: (backup) => setVerifying(backup.name),
              }}
            />
          )}
        </ResourceView>
      </Section>

      <Section
        title="Danger zone"
        hint="Irreversible. Nothing here is linked from anywhere else, and none of it appears in the command palette."
      >
        <div class="card stack stack--tight">
          <strong class={pairClass('danger/surface-1')}>Delete all local data</strong>
          <p class={pairClass('text-muted/surface-1')}>
            Removes the database, the artifact store, every backup and the DPAPI-wrapped master key.
            Deleting that key is what makes this a crypto-erase: any stray ciphertext elsewhere
            becomes permanently undecryptable. There is no undo and no recovery.
          </p>
          {!hasVerifiedBackup ? (
            <Callout tone="warn" title="No verified backup">
              <p class={pairClass('text-muted/surface-1')}>
                Create a backup above and press Verify on it. A backup that has not been verified is
                a belief, not a safety net — so this stays disabled until one passes.
              </p>
              <label class="row">
                <input
                  type="checkbox"
                  checked={acceptLoss}
                  onChange={(event: Event) =>
                    setAcceptLoss((event.target as HTMLInputElement).checked)
                  }
                />
                <span>I have no backup and accept that this is permanent</span>
              </label>
            </Callout>
          ) : (
            <p class={pairClass('ok/surface-1')}>
              Verified backup available: {verifiedBackups.join(', ')}
            </p>
          )}
          <Button
            variant="danger"
            disabled={!purgeAllowed}
            disabledReason="Verify a backup first, or explicitly accept permanent loss."
            onClick={() => setConfirming('purge-all')}
          >
            Delete all local data
          </Button>
        </div>
      </Section>

      <ConfirmDialog
        open={confirming === 'backup'}
        title="Create a backup"
        consequence="Copies the database and artifact store into the managed backups directory, with a manifest of hashes. Secrets are excluded."
        confirmLabel="Create backup"
        pending={mutation.pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void runBackup()}
      />

      <ConfirmDialog
        open={verifying !== null}
        title={`Verify ${verifying ?? ''}`}
        consequence="Re-hashes every file in the archive and compares it against the manifest."
        confirmLabel="Verify"
        pending={mutation.pending}
        onCancel={() => setVerifying(null)}
        onConfirm={() => verifying && void verify(verifying)}
      />

      <ConfirmDialog
        open={confirming === 'purge-all'}
        title="Delete all local data"
        consequence="Every claim, every artifact, every draft, every backup and the encryption key are destroyed. The server shuts down immediately afterwards. This cannot be undone."
        confirmLabel="Delete everything permanently"
        destructive
        pending={purging}
        requiredPhrase={
          hasVerifiedBackup ? 'DELETE ALL LOCAL DATA' : 'NO BACKUP I ACCEPT PERMANENT LOSS'
        }
        onCancel={() => setConfirming(null)}
        onConfirm={() => void purgeAll()}
      />
    </div>
  );
}

export function SystemScreen() {
  const route = useRoute();
  const view = (VIEWS as readonly string[]).includes(route.view ?? '')
    ? (route.view as View)
    : 'credentials';

  return (
    <div class="stack">
      <ViewNav
        label="System views"
        destination="system"
        current={view}
        views={VIEWS.map((key) => ({ key, label: VIEW_LABEL[key] }))}
      />
      {view === 'credentials' ? (
        <Section title="Credentials">
          <CredentialsView />
        </Section>
      ) : null}
      {view === 'capabilities' ? (
        <Section
          title="Capabilities"
          hint="Every external feature starts unavailable and opens only by a human decision."
        >
          <CapabilitiesView />
        </Section>
      ) : null}
      {view === 'features' ? (
        <Section
          title="Shared feature settings"
          hint="Enable or disable each MCP/dashboard feature group from one synchronized policy store."
        >
          <FeaturesView />
        </Section>
      ) : null}
      {view === 'tools' ? (
        <Section
          title="All MCP tools"
          hint="Advanced access to every capability exposed to an AI agent, using the exact same validation and domain services."
        >
          <ToolConsoleView />
        </Section>
      ) : null}
      {view === 'audit' ? (
        <Section
          title="Audit log"
          hint="Hash-chained and append-only. A broken chain blocks approvals and publishing outright."
        >
          <AuditView />
        </Section>
      ) : null}
      {view === 'retention' ? (
        <Section title="Retention policy">
          <RetentionView />
        </Section>
      ) : null}
      {view === 'analytics' ? (
        <Section title="Analytics">
          <AnalyticsView />
        </Section>
      ) : null}
      {view === 'data' ? <DataSection /> : null}
    </div>
  );
}
