import { useState } from 'hono/jsx/dom';
import { Button } from '../components/Button.tsx';
import { Callout } from '../components/Feedback.tsx';
import { ResourceView, Section } from '../components/Screen.tsx';
import { StatusChip } from '../components/Status.tsx';
import { ApiError, api } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { useMutation, useResource } from '../lib/store.ts';
import type {
  DescribeResult,
  ReadinessCheck,
  ReadinessReport,
  UploadResult,
} from '../lib/types.ts';
import { pairClass } from '../styles/pairs.ts';

// The first screen a new member sees, and the one to come back to when
// something has stopped working.
//
// It answers two questions and nothing else: is this set up, and how do I get
// my first evidence in. Everything it offers is a way to start; none of it
// skips a decision that exists elsewhere.

const MIN_DESCRIPTION = 40;

function statusTone(status: ReadinessCheck['status']): string {
  if (status === 'ok') return 'verified';
  // Not a failure. Something this member cannot act on should not be dressed
  // as a task they have neglected.
  if (status === 'unavailable') return 'ambiguous';
  return 'pending_review';
}

const STATUS_LABEL: Record<ReadinessCheck['status'], string> = {
  ok: 'ready',
  action_needed: 'needs you',
  unavailable: 'not available',
};

function CheckRow(props: { check: ReadinessCheck }) {
  const { check } = props;
  return (
    <li class="stack stack--tight">
      <div class="row row--between">
        <span>{check.title}</span>
        <StatusChip state={statusTone(check.status)} label={STATUS_LABEL[check.status]} />
      </div>
      <p class={`section__hint ${pairClass('text-muted/bg')}`}>{check.detail}</p>
      {check.remediation !== null ? (
        <p class={`section__hint ${pairClass('text-subtle/bg')}`}>{check.remediation}</p>
      ) : null}
    </li>
  );
}

function UploadPanel(props: { onDone: () => void }) {
  // Multipart cannot go through useMutation, which posts JSON. The in-flight
  // state is kept here for the same reason Button has one: a second submit
  // while the first is outstanding would register a second source.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  async function submit(event: Event) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem('files') as HTMLInputElement | null;
    const files = input?.files;
    if (!files || files.length === 0) return;

    const payload = new FormData();
    payload.append('label', 'Uploaded documents');
    payload.append('trust', 'personal_doc');
    for (const file of Array.from(files)) payload.append('files', file);

    setPending(true);
    setError(null);
    try {
      const outcome = await api.upload<UploadResult>('/intake/upload', payload);
      setResult(outcome);
      form.reset();
      props.onDone();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : String(caught),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form class="stack" onSubmit={submit}>
      <label class="stack stack--tight" for="setup-files">
        <span>Choose a CV, or any documents you wrote</span>
        <input
          id="setup-files"
          name="files"
          type="file"
          multiple
          accept=".pdf,.docx,.md,.txt,.csv,.zip"
        />
      </label>
      <p class={`section__hint ${pairClass('text-muted/bg')}`}>
        PDF, Word, Markdown, plain text, CSV, or a LinkedIn export archive. Copies are stored
        locally; your original files are never moved or changed.
      </p>
      <div class="row">
        <Button type="submit" variant="primary" pending={pending}>
          Upload and import
        </Button>
      </div>
      {error !== null ? <Callout tone="danger" title={error} /> : null}
      {result !== null ? (
        <Callout tone="ok" title={`Imported ${result.imported} of ${result.results.length}`}>
          <ul>
            {result.results.map((row) => (
              <li key={row.filename}>
                {row.filename}
                {row.imported ? '' : ` — not imported: ${row.reason ?? 'unknown reason'}`}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </form>
  );
}

function DescribePanel(props: { onDone: () => void }) {
  const mutation = useMutation();
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const remaining = MIN_DESCRIPTION - text.trim().length;
  const tooShort = remaining > 0;

  async function submit(event: Event) {
    event.preventDefault();
    if (tooShort) return;
    const outcome = await mutation.run<DescribeResult>('/intake/describe', {
      text: text.trim(),
    });
    if (outcome !== null) {
      setSaved(true);
      setText('');
      props.onDone();
    }
  }

  return (
    <form class="stack" onSubmit={submit}>
      <label class="stack stack--tight" for="setup-about">
        <span>In your own words, what do you do?</span>
        <textarea
          id="setup-about"
          rows={6}
          value={text}
          onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
        />
      </label>
      <p class={`section__hint ${pairClass('text-muted/bg')}`}>
        Stored as self-attested evidence: it ranks below a document you wrote earlier, and claims
        resting only on it stay self-reported until something backs them up. Secrets are redacted
        before anything is stored, exactly as they are for an imported file.
      </p>
      <div class="row">
        <Button
          type="submit"
          variant="primary"
          pending={mutation.pending}
          disabled={tooShort}
          disabledReason={`Write at least ${MIN_DESCRIPTION} characters`}
        >
          Save this
        </Button>
        {tooShort && text.length > 0 ? (
          <span class={`section__hint ${pairClass('text-subtle/bg')}`}>
            {remaining} more character{remaining === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
      {mutation.error !== null ? <Callout tone="danger" title={mutation.error.message} /> : null}
      {saved ? (
        <Callout tone="ok" title="Saved as self-attested evidence">
          Review the claims it supports before anything uses them.
        </Callout>
      ) : null}
    </form>
  );
}

export function SetupScreen() {
  const readiness = useResource<ReadinessReport>('/readiness');

  return (
    <div class="stack">
      <ResourceView resource={readiness.state} reload={readiness.reload} label="setup status">
        {(report) => (
          <div class="stack">
            <Callout
              tone={report.is_first_run ? 'info' : 'ok'}
              title={report.is_first_run ? 'Nothing imported yet' : 'Next step'}
            >
              {report.next_step}
            </Callout>

            <Section title="Checks" hint="What is set up, and what is simply not available here.">
              <ul class="stack">
                {report.checks.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </ul>
            </Section>

            <Section
              title="Add your first evidence"
              hint="Everything this product says about you has to come from something. Start with whichever you have."
            >
              <div class="stack">
                <Section level={3} title="Upload documents">
                  <UploadPanel onDone={readiness.reload} />
                </Section>

                <Section level={3} title="Point at a folder instead">
                  <p class={`section__hint ${pairClass('text-muted/bg')}`}>
                    A folder stays on disk and is re-scanned on each import, so it suits a
                    repository or a documents directory you keep adding to. Registering one asks you
                    to review its path and trust class before it is enabled.
                  </p>
                  <div class="row">
                    <Button
                      variant="secondary"
                      onClick={() => navigate({ destination: 'evidence', view: 'sources' })}
                    >
                      Go to sources
                    </Button>
                  </div>
                </Section>

                <Section level={3} title="Or just tell it about yourself">
                  <DescribePanel onDone={readiness.reload} />
                </Section>
              </div>
            </Section>
          </div>
        )}
      </ResourceView>
    </div>
  );
}
