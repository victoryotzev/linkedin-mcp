import { describe, expect, it } from 'vitest';
import { PROMPT_DEFS } from '../../linkedin-mcp-server/src/prompts.ts';

// Prompts exist because the ORDER of these workflows matters — drafting before
// checking coverage, or patching before importing a fresh snapshot, produces
// unevidenced output. Their build() functions branch on which arguments the
// host supplied, and an unsupplied argument must degrade into an instruction to
// ask rather than into a silently different workflow.

const prompt = (name: string) => PROMPT_DEFS.find((p) => p.name === name)!;
const build = (name: string, args: Record<string, string | undefined> = {}) =>
  prompt(name).build(args);

describe('every prompt', () => {
  it('declares a title, a description, and argument metadata', () => {
    for (const def of PROMPT_DEFS) {
      expect(def.title).not.toBe('');
      expect(def.description.length).toBeGreaterThan(20);
      for (const arg of def.arguments) {
        expect(arg.name).toMatch(/^[a-z_]+$/);
        expect(arg.description).not.toBe('');
        expect(typeof arg.required).toBe('boolean');
      }
    }
  });

  it('builds a non-trivial message with no arguments at all', () => {
    // A host may call prompts/get with nothing. None of these may throw, and
    // none may render an empty or placeholder-riddled instruction.
    for (const def of PROMPT_DEFS) {
      const text = def.build({});
      expect(text.length).toBeGreaterThan(100);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('[object Object]');
    }
  });

  it('builds cleanly when every declared argument is supplied', () => {
    // Not every argument appears in every rendering: source_id and path are
    // mutually exclusive by design, and supplying both takes the source_id
    // branch. What must hold is that nothing renders as "undefined".
    for (const def of PROMPT_DEFS) {
      const args = Object.fromEntries(def.arguments.map((a) => [a.name, `value_${a.name}`]));
      const text = def.build(args);
      expect(text).not.toContain('undefined');
      expect(text.length).toBeGreaterThan(100);
      // At least one supplied argument must reach the output, or the arguments
      // are decorative. Two of these workflows take none at all, which is not
      // the same thing as ignoring the ones they declare.
      if (def.arguments.length > 0) {
        expect(def.arguments.some((a) => text.includes(`value_${a.name}`))).toBe(true);
      }
    }
  });
});

describe('ingest_and_review_evidence', () => {
  const name = 'ingest_and_review_evidence';

  it('processes an existing source when given a source id', () => {
    const text = build(name, { source_id: 'src_01ABC' });

    expect(text).toContain('Process registered evidence source "src_01ABC"');
    expect(text).toContain('linkedin_source_list');
    // Registration is skipped, because the source already exists.
    expect(text).not.toContain('action="register"');
  });

  it('registers a new source when given a path instead', () => {
    const text = build(name, { path: 'C:\\evidence\\cv.pdf' });

    expect(text).toContain('Process new evidence at "C:\\\\evidence\\\\cv.pdf"');
    expect(text).toContain('action="register"');
    expect(text).toContain('Do not guess the trust class.');
  });

  it('asks for one or the other when given neither', () => {
    const text = build(name, {});

    expect(text).toContain(
      'Ask the user for either an existing source id or an absolute evidence path.',
    );
  });

  it('threads optional kind, trust and label into the registration step', () => {
    const withAll = build(name, {
      path: 'C:\\evidence',
      kind: 'folder',
      trust: 'own_repo',
      label: 'Portfolio',
    });
    expect(withAll).toContain('(kind="folder")');
    expect(withAll).toContain('(trust="own_repo")');
    expect(withAll).toContain('(label="Portfolio")');

    // Omitted ones leave no empty parentheses or stray "undefined" behind.
    const pathOnly = build(name, { path: 'C:\\evidence' });
    expect(pathOnly).not.toContain('(kind=');
    expect(pathOnly).not.toContain('(trust=');
    expect(pathOnly).not.toContain('(label=');
    expect(pathOnly).not.toContain('undefined');
  });

  it('keeps enablement and verification at the human boundary regardless of arguments', () => {
    for (const args of [{}, { source_id: 'src_1' }, { path: 'C:\\x' }]) {
      const text = build(name, args);
      expect(text).toContain('ENABLE <source_id>');
      expect(text).toContain('Only after they explicitly confirm');
      expect(text).toContain('untrusted data');
      expect(text).toContain('Never silently approve a new public statement.');
    }
  });
});

describe('the remaining workflows', () => {
  it('draft_post_from_claims refuses to invent evidence', () => {
    const text = build('draft_post_from_claims', { topic: 'local-first tooling' });

    expect(text).toContain('local-first tooling');
    // The word "verified" lives in linkedin://evidence/rules, which step 1
    // sends the agent to read. What this prompt carries itself is the hard
    // block and the instruction not to invent.
    expect(text).toContain('linkedin://evidence/rules');
    expect(text).toContain('unsupported sentences and unbacked quantities are hard blocks');
    expect(text).toContain('Do not invent metrics, employers, dates or outcomes.');
    // Validation precedes any approval request, and approval stays human.
    expect(text.indexOf('linkedin_draft_validate')).toBeLessThan(
      text.indexOf('linkedin_publish_request'),
    );
    expect(text).toContain('current explicit confirmation');
  });

  it('draft_post_from_claims accepts an explicit claim list', () => {
    const text = build('draft_post_from_claims', {
      topic: 'backups',
      claim_ids: 'clm_1,clm_2',
    });
    expect(text).toContain('clm_1,clm_2');
  });

  it('profile_audit_session branches on whether a snapshot source was given', () => {
    const withSource = build('profile_audit_session', { source_id: 'src_9' });
    expect(withSource).toContain('linkedin_snapshot_import');
    expect(withSource).toContain('src_9');

    const without = build('profile_audit_session', {});
    expect(without).not.toContain('undefined');
    expect(without.length).toBeGreaterThan(100);
  });

  it('review_conflicts and weekly_evidence_review build without arguments', () => {
    for (const name of ['review_conflicts', 'weekly_evidence_review']) {
      const text = build(name, {});
      expect(text.length).toBeGreaterThan(100);
      expect(text).not.toContain('undefined');
    }
  });
});
